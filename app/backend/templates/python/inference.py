#!/usr/bin/env python3
"""Interactive / scripted inference for MapperGPT.

    python inference.py --prompt "map a level for a 2 minute edm track at 128 bpm"
    python inference.py --prompt "..." --tokens 256 --temperature 0.8 --top-k 40
"""
from __future__ import annotations

import argparse
import json
import time

import torch

from model import ModelConfig, load_pretrained
from tokenizer.tokenizer import BPETokenizer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", default="map a level for a 2.0 minute edm track at 128 bpm, style=expert")
    ap.add_argument("--tokens", type=int, default=256)
    ap.add_argument("--temperature", type=float, default=0.9)
    ap.add_argument("--top-k", type=int, default=50)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON only")
    args = ap.parse_args()

    if args.seed is not None:
        torch.manual_seed(args.seed)

    tokenizer = BPETokenizer.from_file("tokenizer/vocab.json")
    model = load_pretrained("weights/model.safetensors", "config.json")
    cfg = ModelConfig.from_json("config.json")

    ids = tokenizer.encode(args.prompt, add_bos=True)
    if not ids:
        raise SystemExit("prompt encoded to zero tokens")
    x = torch.tensor([ids], dtype=torch.long)
    x = x[:, -cfg.n_ctx:]

    t0 = time.time()
    out = model.generate(x, max_new_tokens=args.tokens, temperature=args.temperature, top_k=args.top_k)
    elapsed = time.time() - t0
    text = tokenizer.decode(out[0].tolist())

    result = {
        "prompt": args.prompt,
        "completion": text,
        "prompt_tokens": len(ids),
        "generated_tokens": int(out.shape[1] - x.shape[1]),
        "elapsed_s": round(elapsed, 3),
        "tokens_per_second": round((out.shape[1] - x.shape[1]) / max(elapsed, 1e-9), 2),
        "parameters": model.num_parameters(),
        "config": model.cfg.to_dict(),
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("-" * 62)
        print(text)
        print("-" * 62)
        print(f"{result['parameters']:,} trainable params | {result['generated_tokens']} new tokens "
              f"| {result['tokens_per_second']} tok/s")


if __name__ == "__main__":
    main()
