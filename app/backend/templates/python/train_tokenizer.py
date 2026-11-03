#!/usr/bin/env python3
"""Train the byte-level BPE vocabulary used by MapperGPT.

Identical algorithm to the generator that created this repo (and to the JS
implementation in AiMapper Model Studio): the most frequent adjacent token pair
is merged repeatedly over the raw byte stream, ties broken by the lowest
(left, right) id pair. Re-running this on the same corpus reproduces
tokenizer/vocab.json byte-for-byte.

    python tokenizer/train_tokenizer.py --vocab-size {{VOCAB_SIZE}}
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

SPECIALS = ["<pad>", "<unk>", "<bos>", "<eos>"]


def iter_texts(paths):
    for path in paths:
        p = Path(path)
        if not p.exists():
            continue
        for family in sorted(p.glob("*.jsonl")):
            with family.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    yield row.get("text", "")


def build_stream(texts, max_bytes: int) -> bytes:
    out = bytearray()
    for text in texts:
        data = text.encode("utf-8")
        if len(out) + len(data) > max_bytes and out:
            break
        out.extend(data)
        out.append(0x0A)
    return bytes(out)


def train(texts, vocab_size: int, max_bytes: int) -> dict:
    stream = build_stream(texts, max_bytes)
    tokens = list(stream)

    vocab: list[bytes] = [bytes([i]) for i in range(256)]
    vocab += [s.encode("utf-8") for s in SPECIALS]
    merges: list[list[int]] = []

    while len(vocab) < vocab_size and len(tokens) > 1:
        counts = Counter(zip(tokens, tokens[1:]))
        if not counts:
            break
        pair, freq = min(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        if freq < 2:
            break

        left, right = pair
        new_id = len(vocab)
        vocab.append(vocab[left] + vocab[right])
        merges.append([left, right])

        out = []
        i = 0
        n = len(tokens)
        while i < n:
            if i < n - 1 and tokens[i] == left and tokens[i + 1] == right:
                out.append(new_id)
                i += 2
            else:
                out.append(tokens[i])
                i += 1
        tokens = out

    vocab_json = {}
    for idx, data in enumerate(vocab):
        special = next((s for s in SPECIALS if s.encode("utf-8") == data and len(data) > 1), None)
        vocab_json[str(idx)] = special if special else data.hex()

    return {
        "version": 2,
        "algorithm": "byte-level-bpe",
        "pre_tokenizer": None,
        "special_tokens": SPECIALS,
        "vocab_size": len(vocab),
        "training_bytes": len(stream),
        "vocab": vocab_json,
        "merges": merges,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocab-size", type=int, default={{VOCAB_SIZE}})
    ap.add_argument("--max-bytes", type=int, default=40000,
                    help="byte budget for the merge-learning pass")
    ap.add_argument("--data", nargs="*", default=["data/corpus"])
    ap.add_argument("--out", default="tokenizer/vocab.json")
    args = ap.parse_args()

    texts = list(iter_texts(args.data))
    if not texts:
        raise SystemExit("no corpus found — run: python data/prepare_data.py")
    result = train(texts, args.vocab_size, args.max_bytes)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result) + "\n", encoding="utf-8")
    print(f"trained byte-level BPE: {result['vocab_size']} tokens, "
          f"{len(result['merges'])} merges, {result['training_bytes']} training bytes -> {out}")


if __name__ == "__main__":
    main()
