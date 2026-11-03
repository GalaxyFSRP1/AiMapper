#!/usr/bin/env python3
"""Validate the generated MapperGPT project.

Checks (all hard failures unless noted):
  1. config.json parses and declares the expected parameter target
  2. weights/model.safetensors parses as a real safetensors file
  3. every tensor shape in the manifest matches the configuration
  4. the summed tensor element count matches the analytics parameter count
  5. initialised weights are statistically sane (finite, non-degenerate,
     LayerNorms at identity, normal layers ~ N(0, sigma^2))
  6. tokenizer/vocab.json loads and round-trips text losslessly
  7. the model class builds and reports the same parameter count (needs torch)

Exit code 0 == valid. Machine-readable report is written to validation-report.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

FAILS: list[str] = []
WARNS: list[str] = []
REPORT: dict = {}


def check(condition: bool, message: str) -> bool:
    if not condition:
        FAILS.append(message)
    return condition


def warn(condition: bool, message: str) -> None:
    if not condition:
        WARNS.append(message)


def analytic_counts(cfg: dict) -> dict:
    d, V, ctx, ff, L = cfg["d_model"], cfg["vocab_size"], cfg["n_ctx"], cfg["d_ff"], cfg["n_layer"]
    tied = bool(cfg.get("tie_word_embeddings", True))
    embedding = V * d if tied else 2 * V * d
    positional = ctx * d
    per_layer = 4 * d + (3 * d * d + 3 * d) + (d * d + d) + (ff * d + ff) + (d * ff + d)
    total = embedding + positional + per_layer * L + 2 * d
    return {"embedding": embedding, "positional": positional, "per_layer": per_layer,
            "blocks": per_layer * L, "final_ln": 2 * d, "total": total}


def read_safetensors_header(path: Path) -> tuple[dict, int]:
    with path.open("rb") as fh:
        raw_len = fh.read(8)
        if len(raw_len) != 8:
            raise ValueError("file shorter than safetensors length prefix")
        header_len = int.from_bytes(raw_len, "little")
        if header_len <= 0 or header_len > 100 * 1024 * 1024:
            raise ValueError(f"implausible header length {header_len}")
        header = json.loads(fh.read(header_len).decode("utf-8"))
        return header, 8 + header_len


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--weights", default="weights/model.safetensors")
    ap.add_argument("--report", default="validation-report.json")
    ap.add_argument("--strict-target", type=float, default=0.02,
                    help="max allowed relative deviation from target_parameters")
    args = ap.parse_args()

    # 1 — config ------------------------------------------------------------
    cfg_path = Path(args.config)
    if not check(cfg_path.exists(), f"config not found: {cfg_path}"):
        return finish(args)
    raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg = raw.get("model", {})
    for key in ("vocab_size", "n_ctx", "d_model", "n_head", "d_ff", "n_layer"):
        check(key in cfg, f"config missing key: {key}")
    if FAILS:
        return finish(args)
    check(cfg["d_model"] % cfg["n_head"] == 0, "d_model must be divisible by n_head")
    check(cfg["n_ctx"] > 0 and cfg["d_model"] > 0 and cfg["n_layer"] > 0, "non-positive dimensions in config")

    counts = analytic_counts(cfg)
    REPORT["config"] = cfg
    REPORT["analytic_parameters"] = counts

    target = raw.get("target_parameters") or cfg.get("target_parameters")
    if target:
        deviation = abs(counts["total"] - target) / target
        REPORT["target_parameters"] = target
        REPORT["deviation_from_target"] = round(deviation, 6)
        check(deviation <= args.strict_target,
              f"parameter count {counts['total']:,} deviates {deviation*100:.2f}% from target {target:,}")

    # 2/3/4 — weights ------------------------------------------------------
    wpath = Path(args.weights)
    if not check(wpath.exists(), f"weights not found: {wpath}"):
        return finish(args)
    header, data_start = read_safetensors_header(wpath)
    meta = header.pop("__metadata__", {})
    REPORT["safetensors"] = {"tensors": len(header), "metadata": meta}

    expected_shapes = expected_tensor_shapes(cfg)
    missing = sorted(set(expected_shapes) - set(header))
    extra = sorted(set(header) - set(expected_shapes))
    check(not missing, f"{len(missing)} tensors missing from checkpoint (e.g. {missing[:3]})")
    check(not extra, f"{len(extra)} unexpected tensors in checkpoint (e.g. {extra[:3]})")

    total_elems = 0
    shape_errors = []
    for name, info in header.items():
        elems = 1
        for dim in info["shape"]:
            elems *= dim
        total_elems += elems
        if name in expected_shapes and list(info["shape"]) != list(expected_shapes[name]):
            shape_errors.append({"tensor": name, "expected": expected_shapes[name], "actual": info["shape"]})
        check(info["dtype"] == "F32", f"tensor {name} has unexpected dtype {info['dtype']}")
        offsets = info.get("data_offsets")
        if offsets:
            check(offsets[1] - offsets[0] == elems * 4, f"tensor {name} byte length mismatch")
    check(not shape_errors, f"{len(shape_errors)} tensors have wrong shape (first: {shape_errors[:2]})")

    file_bytes = wpath.stat().st_size
    REPORT["weights"] = {
        "tensor_count": len(header),
        "tensor_elements": total_elems,
        "file_bytes": file_bytes,
        "expected_bytes": total_elems * 4 + data_start,
    }
    check(total_elems == counts["total"],
          f"tensor element count {total_elems:,} != analytic total {counts['total']:,}")
    check(file_bytes == total_elems * 4 + data_start,
          f"file size {file_bytes} != expected {total_elems * 4 + data_start}")

    # 5 — statistical sanity of initialised weights -------------------------
    try:
        import numpy as np
        with wpath.open("rb") as fh:
            fh.seek(data_start)
            blob = fh.read()
        stats = {}
        for name, info in header.items():
            if info["group_hint"] if "group_hint" in info else False:
                pass
            start, end = info["data_offsets"]
            arr = np.frombuffer(blob[start:end], dtype="<f4")
            finite = np.isfinite(arr).all()
            check(bool(finite), f"tensor {name} contains NaN/Inf")
            sd = float(arr.std())
            mean = float(arr.mean())
            stats[name] = {"mean": round(mean, 6), "std": round(sd, 6),
                           "min": round(float(arr.min()), 6), "max": round(float(arr.max()), 6)}
            if name.endswith("ln_1.weight") or name.endswith("ln_2.weight") or name.endswith("ln_f.weight"):
                check(abs(mean - 1.0) < 1e-3 and sd < 1e-3, f"LayerNorm {name} is not initialised to ones")
            elif name.endswith(".bias"):
                check(abs(arr).max() < 1e-6, f"bias {name} is not zero-initialised")
            elif name.endswith(".weight"):
                warn(1e-4 < sd < 0.5, f"{name} std {sd:.2e} looks unusual for a fresh init")
                check(sd > 0, f"{name} is degenerate (all identical values)")
        REPORT["weight_stats_sample"] = dict(list(stats.items())[:6])
    except ImportError:
        warn(False, "numpy not installed — skipped statistical weight checks")

    # 6 — tokenizer --------------------------------------------------------
    vocab_path = Path("tokenizer/vocab.json")
    if check(vocab_path.exists(), "tokenizer/vocab.json missing"):
        vocab = json.loads(vocab_path.read_text(encoding="utf-8"))
        REPORT["tokenizer"] = {"vocab_size": vocab.get("vocab_size"), "merges": len(vocab.get("merges", []))}
        check(vocab.get("vocab_size") == cfg["vocab_size"],
              f"tokenizer vocab_size {vocab.get('vocab_size')} != config vocab_size {cfg['vocab_size']}")
        sys.path.insert(0, ".")
        try:
            from tokenizer.tokenizer import BPETokenizer
            tok = BPETokenizer.from_file(vocab_path)
            probe = "map a level for a 3.0 minute edm track at 128 bpm, style=expert, difficulty=Expert, density=0.80"
            ids = tok.encode(probe, add_bos=True, add_eos=True)
            check(tok.decode(ids) == probe, "tokenizer failed a round-trip encode/decode")
            check(len(ids) < len(probe), "BPE produced no compression (merges not applied)")
            REPORT["tokenizer"]["probe_tokens"] = len(ids)
            REPORT["tokenizer"]["roundtrip"] = "ok"
        except Exception as exc:  # noqa: BLE001
            check(False, f"tokenizer round-trip raised: {exc}")

    # 7 — architecture builds (only when torch is available) ----------------
    try:
        import torch  # noqa: F401
        sys.path.insert(0, ".")
        from model import MapperGPTForCausalLM, ModelConfig
        model = MapperGPTForCausalLM(ModelConfig.from_json(args.config))
        built = model.num_parameters()
        REPORT["torch_built_parameters"] = built
        check(built == counts["total"],
              f"built model has {built:,} parameters but analytics say {counts['total']:,}")
        with torch.no_grad():
            logits, loss = model(torch.zeros(1, min(8, cfg["n_ctx"]), dtype=torch.long))
        check(tuple(logits.shape) == (1, min(8, cfg["n_ctx"]), cfg["vocab_size"]),
              f"unexpected forward logits shape {tuple(logits.shape)}")
        REPORT["forward_shape"] = list(logits.shape)
    except ImportError:
        REPORT["torch_built_parameters"] = "skipped (torch not installed)"
        WARNS.append("torch unavailable — architecture build check skipped")

    return finish(args)


def expected_tensor_shapes(cfg: dict) -> dict:
    d, V, ctx, ff, L = cfg["d_model"], cfg["vocab_size"], cfg["n_ctx"], cfg["d_ff"], cfg["n_layer"]
    tied = bool(cfg.get("tie_word_embeddings", True))
    shapes = {
        "model.tok_emb.weight": [V, d],
        "model.pos_emb.weight": [ctx, d],
        "model.ln_f.weight": [d],
        "model.ln_f.bias": [d],
    }
    if not tied:
        shapes["lm_head.weight"] = [V, d]
    for i in range(L):
        shapes[f"model.blocks.{i}.ln_1.weight"] = [d]
        shapes[f"model.blocks.{i}.ln_1.bias"] = [d]
        shapes[f"model.blocks.{i}.ln_2.weight"] = [d]
        shapes[f"model.blocks.{i}.ln_2.bias"] = [d]
        shapes[f"model.blocks.{i}.attn.c_attn.weight"] = [3 * d, d]
        shapes[f"model.blocks.{i}.attn.c_attn.bias"] = [3 * d]
        shapes[f"model.blocks.{i}.attn.c_proj.weight"] = [d, d]
        shapes[f"model.blocks.{i}.attn.c_proj.bias"] = [d]
        shapes[f"model.blocks.{i}.mlp.fc_in.weight"] = [ff, d]
        shapes[f"model.blocks.{i}.mlp.fc_in.bias"] = [ff]
        shapes[f"model.blocks.{i}.mlp.fc_out.weight"] = [d, ff]
        shapes[f"model.blocks.{i}.mlp.fc_out.bias"] = [d]
    return shapes


def finish(args) -> int:
    REPORT["failures"] = FAILS
    REPORT["warnings"] = WARNS
    REPORT["status"] = "pass" if not FAILS else "fail"
    Path(args.report).write_text(json.dumps(REPORT, indent=2) + "\n", encoding="utf-8")

    print("=" * 62)
    print(" MapperGPT validation")
    print("=" * 62)
    print(f" status .......... {REPORT['status'].upper()}")
    if "target_parameters" in REPORT:
        print(f" target params ... {REPORT['target_parameters']:,}")
    print(f" analytic params . {REPORT['analytic_parameters']['total']:,}")
    if REPORT.get("weights"):
        print(f" tensor elements . {REPORT['weights']['tensor_elements']:,}")
        print(f" tensors ......... {REPORT['weights']['tensor_count']}")
    for warning in WARNS:
        print(f" [warn] {warning}")
    for failure in FAILS:
        print(f" [FAIL] {failure}")
    print("=" * 62)
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
