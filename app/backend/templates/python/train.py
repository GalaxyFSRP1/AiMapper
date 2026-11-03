#!/usr/bin/env python3
"""Train MapperGPT from the initialised checkpoint.

Usage:
    python train.py --config config.json --data data/corpus --steps 2000
    python train.py --resume weights/model.safetensors --steps 500

Everything is seeded and logged; runs are reproducible for a fixed --seed.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

from model import MapperGPTForCausalLM, ModelConfig
from tokenizer.tokenizer import BPETokenizer

PAD_ID = 0


class TokenDataset(Dataset):
    def __init__(self, path: Path, tokenizer: BPETokenizer, n_ctx: int):
        self.samples = []
        if not path.exists():
            raise FileNotFoundError(f"missing dataset {path} — run data/prepare_data.py first")
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                ids = tokenizer.encode(row["text"])
                if len(ids) < 4:
                    continue
                # sliding windows of length n_ctx + 1 (input + shifted target)
                for start in range(0, max(1, len(ids) - n_ctx), n_ctx):
                    chunk = ids[start:start + n_ctx + 1]
                    if len(chunk) < 4:
                        continue
                    # right-pad short windows with <pad> (loss ignores nothing here;
                    # windows are dropped by the sampler if they are mostly padding)
                    if len(chunk) < n_ctx + 1:
                        chunk = chunk + [PAD_ID] * (n_ctx + 1 - len(chunk))
                    self.samples.append(torch.tensor(chunk, dtype=torch.long))
        if not self.samples:
            raise RuntimeError(f"dataset {path} produced no training windows")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        chunk = self.samples[idx]
        return chunk[:-1], chunk[1:]


def lr_at(step: int, total: int, warmup: int, base_lr: float, min_lr: float) -> float:
    if step < warmup:
        return base_lr * (step + 1) / max(1, warmup)
    progress = (step - warmup) / max(1, total - warmup)
    return min_lr + 0.5 * (base_lr - min_lr) * (1 + math.cos(math.pi * min(1.0, progress)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--data", default="data/corpus")
    ap.add_argument("--weights", default="weights/model.safetensors")
    ap.add_argument("--out", default="checkpoints")
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--batch-size", type=int, default=None)
    ap.add_argument("--lr", type=float, default=None)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    raw = json.loads(Path(args.config).read_text(encoding="utf-8"))
    cfg = ModelConfig.from_json(args.config)
    tp = raw.get("training", {})
    steps = args.steps or tp.get("max_steps", 2000)
    batch_size = args.batch_size or tp.get("batch_size", 16)
    base_lr = args.lr or tp.get("learning_rate", 3e-4)
    min_lr = tp.get("min_lr", base_lr / 10)
    warmup = int(steps * tp.get("warmup_ratio", 0.03))
    grad_clip = tp.get("grad_clip", 1.0)
    eval_every = tp.get("eval_every", max(50, steps // 10))

    torch.manual_seed(args.seed)
    device = torch.device(args.device)

    tokenizer = BPETokenizer.from_file("tokenizer/vocab.json")
    if tokenizer.vocab_size != cfg.vocab_size:
        raise SystemExit(
            f"vocab mismatch: tokenizer has {tokenizer.vocab_size} tokens but config expects {cfg.vocab_size}"
        )

    train_ds = TokenDataset(Path(args.data) / "train.jsonl", tokenizer, cfg.n_ctx)
    val_ds = TokenDataset(Path(args.data) / "val.jsonl", tokenizer, cfg.n_ctx) if (Path(args.data) / "val.jsonl").exists() else None
    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True, drop_last=True, num_workers=0)
    val_dl = DataLoader(val_ds, batch_size=batch_size, shuffle=False) if val_ds else None

    model = MapperGPTForCausalLM(cfg).to(device)
    if Path(args.weights).exists():
        from safetensors.torch import load_file
        state = load_file(args.weights)
        missing, unexpected = model.load_state_dict(state, strict=False)
        unexpected = [u for u in unexpected if not (cfg.tie_word_embeddings and u == "lm_head.weight")]
        if unexpected:
            raise SystemExit(f"checkpoint/config mismatch, unexpected tensors: {unexpected}")
        print(f"resumed from {args.weights} (missing={len(missing)})")

    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"trainable parameters: {n_params:,}")

    # weight decay only on matmul weights / embeddings, never on LayerNorm or biases
    decay, no_decay = [], []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if param.dim() >= 2:
            decay.append(param)
        else:
            no_decay.append(param)
    optimizer = torch.optim.AdamW(
        [{"params": decay, "weight_decay": tp.get("weight_decay", 0.1)},
         {"params": no_decay, "weight_decay": 0.0}],
        lr=base_lr, betas=(0.9, 0.95), eps=1e-8,
    )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    history = []
    step = 0
    t0 = time.time()
    model.train()
    while step < steps:
        for x, y in train_dl:
            if step >= steps:
                break
            lr = lr_at(step, steps, warmup, base_lr, min_lr)
            for group in optimizer.param_groups:
                group["lr"] = lr

            x, y = x.to(device), y.to(device)
            _, loss = model(x, y)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
            optimizer.step()
            step += 1

            if step % 10 == 0 or step == 1:
                entry = {
                    "step": step,
                    "loss": round(float(loss.detach()), 6),
                    "lr": round(lr, 8),
                    "elapsed_s": round(time.time() - t0, 2),
                }
                history.append(entry)
                print(json.dumps(entry))

            if step % eval_every == 0 and val_dl is not None:
                model.eval()
                losses = []
                with torch.no_grad():
                    for vx, vy in val_dl:
                        _, vloss = model(vx.to(device), vy.to(device))
                        losses.append(float(vloss))
                model.train()
                val_loss = sum(losses) / len(losses)
                ppl = math.exp(min(val_loss, 20))
                print(json.dumps({"step": step, "val_loss": round(val_loss, 6), "val_ppl": round(ppl, 3)}))
                history.append({"step": step, "val_loss": round(val_loss, 6), "val_ppl": round(ppl, 3)})

    from safetensors.torch import save_file
    ckpt = out_dir / "model.safetensors"
    save_file({k: v.contiguous() for k, v in model.state_dict().items()}, str(ckpt))
    (out_dir / "history.json").write_text(json.dumps(history, indent=2) + "\n", encoding="utf-8")
    (out_dir / "train_summary.json").write_text(json.dumps({
        "steps": step,
        "trainable_parameters": n_params,
        "final_loss": history[-1].get("loss") if history else None,
        "elapsed_s": round(time.time() - t0, 2),
        "device": str(device),
        "batch_size": batch_size,
        "learning_rate": base_lr,
        "checkpoint": str(ckpt),
    }, indent=2) + "\n", encoding="utf-8")
    print(f"saved checkpoint -> {ckpt}")


if __name__ == "__main__":
    main()
