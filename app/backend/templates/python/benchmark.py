#!/usr/bin/env python3
"""Micro-benchmark: parameter count, forward/backward latency, throughput.

    python benchmark.py --batch-size 4 --seq-len 128 --iters 20
"""
from __future__ import annotations

import argparse
import json
import time

import torch

from model import MapperGPTForCausalLM, ModelConfig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=4)
    ap.add_argument("--seq-len", type=int, default=128)
    ap.add_argument("--iters", type=int, default=20)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    cfg = ModelConfig.from_json("config.json")
    device = torch.device(args.device)
    model = MapperGPTForCausalLM(cfg).to(device)
    seq = min(args.seq_len, cfg.n_ctx)
    x = torch.randint(0, cfg.vocab_size, (args.batch_size, seq), device=device)

    params = model.num_parameters()
    # warmup
    for _ in range(2):
        _, loss = model(x, x)
        loss.backward()
        model.zero_grad(set_to_none=True)

    t0 = time.perf_counter()
    for _ in range(args.iters):
        _, loss = model(x, x)
        loss.backward()
        model.zero_grad(set_to_none=True)
    fwd_bwd = (time.perf_counter() - t0) / args.iters

    model.eval()
    with torch.no_grad():
        t0 = time.perf_counter()
        for _ in range(args.iters):
            model(x)
        fwd = (time.perf_counter() - t0) / args.iters

    tokens = args.batch_size * seq
    result = {
        "device": str(device),
        "trainable_parameters": params,
        "batch_size": args.batch_size,
        "seq_len": seq,
        "forward_ms": round(fwd * 1000, 2),
        "forward_backward_ms": round(fwd_bwd * 1000, 2),
        "fwd_tokens_per_second": round(tokens / max(fwd, 1e-9), 1),
        "fwd_bwd_tokens_per_second": round(tokens / max(fwd_bwd, 1e-9), 1),
        "estimated_train_hours_per_100k_steps": round(fwd_bwd * 100000 / 3600, 2),
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for key, value in result.items():
            print(f"{key:38s} {value}")


if __name__ == "__main__":
    main()
