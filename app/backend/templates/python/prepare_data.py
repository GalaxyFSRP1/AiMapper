#!/usr/bin/env python3
"""Build the training corpus for MapperGPT.

The model is a mapper model: it learns to turn a song description into a
structured, valid Beat Saber note map. Datasets are emitted as JSONL with a
prompt/completion pair per example plus the fully rendered `text` used for
language modelling.

Sources
  1. data/seeds.jsonl            – hand-written seed examples shipped with the repo
  2. --synthetic N               – deterministic procedurally generated maps
  3. --beatmaps PATH             – real .dat difficulty files (v2 or v3 schema)

Run:  python data/prepare_data.py --synthetic {{SYNTHETIC_EXAMPLES}}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

PROMPT_TEMPLATE = (
    "map a level for a {minutes:.1f} minute {genre} track at {bpm} bpm, "
    "style={style}, difficulty={difficulty}, density={density:.2f}"
)

DIRECTIONS = ["up", "down", "left", "right", "up_left", "up_right", "down_left", "down_right"]


def seeded_rng(key: str) -> random.Random:
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def render_map(spec: dict, rng: random.Random) -> str:
    """Renders a canonical, human-readable note map (also the LM target text)."""
    lines = [
        f"# map: {spec['genre']} {spec['bpm']}bpm difficulty={spec['difficulty']}",
        "# schema: mapper-gpt/1",
        "map {",
        f"  bpm = {spec['bpm']}",
        f"  duration = {spec['duration']:.2f}",
        f"  style = \"{spec['style']}\"",
        "  notes [",
    ]
    beat = 0.5
    step = max(0.25, round(1.0 / max(spec["density"], 0.01) / 4, 2))
    while beat < spec["duration"]:
        hand = "red" if rng.random() < 0.5 else "blue"
        lane = rng.randrange(0, 4)
        row = rng.choices([0, 1, 2], weights=[6, 3, 1])[0]
        direction = rng.choice(DIRECTIONS)
        lines.append(
            f"    {{ t = {beat:6.2f}, hand = {hand}, lane = {lane}, row = {row}, dir = {direction} }}"
        )
        if rng.random() < spec["density"] * 0.25:
            other = "blue" if hand == "red" else "red"
            lines.append(
                f"    {{ t = {beat:6.2f}, hand = {other}, lane = {4 - lane - 1}, row = {row}, dir = {direction} }}"
            )
        beat = round(beat + step, 2)
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines)


GENRES = ["edm", "rock", "pop", "hiphop", "metal", "ambient", "dnb", "jpop", "classical", "synthwave"]
DIFFICULTIES = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"]


def synthetic_example(index: int) -> dict:
    rng = seeded_rng(f"mapper-synthetic-{index}")
    genre = GENRES[index % len(GENRES)]
    bpm = rng.choice([90, 100, 110, 120, 128, 140, 150, 160, 174, 180])
    difficulty = DIFFICULTIES[index % len(DIFFICULTIES)]
    density = round({"Easy": 0.25, "Normal": 0.4, "Hard": 0.6, "Expert": 0.8, "ExpertPlus": 1.0}[difficulty]
                    * rng.uniform(0.85, 1.15), 3)
    duration = rng.choice([60, 90, 120, 150, 180])
    spec = {
        "genre": genre,
        "bpm": bpm,
        "duration": duration,
        "style": difficulty.lower(),
        "difficulty": difficulty,
        "density": min(density, 1.5),
    }
    prompt = PROMPT_TEMPLATE.format(minutes=duration / 60, **spec)
    completion = render_map(spec, rng)
    return {
        "id": f"synthetic-{index:06d}",
        "source": "synthetic",
        "prompt": prompt,
        "completion": completion,
        "text": f"<bos>{prompt}\n{completion}<eos>",
        "meta": spec,
    }


def load_seeds(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if "text" not in row and "prompt" in row and "completion" in row:
                row["text"] = f"<bos>{row['prompt']}\n{row['completion']}<eos>"
            rows.append(row)
    return rows


def load_beatmaps(root: Path) -> list[dict]:
    """Convert real Beat Saber difficulty files into examples."""
    if not root.exists():
        return []
    out = []
    for dat in sorted(root.rglob("*.dat")):
        try:
            raw = json.loads(dat.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        notes = raw.get("colorNotes") or raw.get("_notes") or []
        if not notes:
            continue
        lines = ["# schema: mapper-gpt/1", "map {"]
        if isinstance(raw.get("_beatsPerMinute"), (int, float)):
            lines.append(f"  bpm = {raw['_beatsPerMinute']}")
        lines.append("  notes [")
        for note in notes[:4000]:
            if isinstance(note, dict):
                t = note.get("b", note.get("_time", 0))
                lane = note.get("x", note.get("_lineIndex", 0))
                row = note.get("y", note.get("_lineLayer", 0))
                hand = "red" if note.get("c", note.get("_type", 0)) == 0 else "blue"
                direction = DIRECTIONS[note.get("d", note.get("_cutDirection", 0)) % 8]
            else:  # v2 array form: {"_time":..}, {..}
                continue
            lines.append(f"    {{ t = {float(t):6.2f}, hand = {hand}, lane = {lane}, row = {row}, dir = {direction} }}")
        lines += ["  ]", "}"]
        completion = "\n".join(lines)
        prompt = f"map a level from {dat.name}, style=imported"
        out.append({
            "id": f"beatmap-{len(out):06d}",
            "source": "beatmap",
            "prompt": prompt,
            "completion": completion,
            "text": f"<bos>{prompt}\n{completion}<eos>",
            "meta": {"file": str(dat)},
        })
    return out


def split(rows: list[dict], val_frac: float = 0.02) -> tuple[list[dict], list[dict]]:
    rng = random.Random(1337)
    rows = rows[:]
    rng.shuffle(rows)
    n_val = max(1, int(len(rows) * val_frac)) if rows else 0
    return rows[n_val:], rows[:n_val]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", type=int, default={{SYNTHETIC_EXAMPLES}})
    ap.add_argument("--beatmaps", type=Path, default=Path("data/beatmaps"))
    ap.add_argument("--out", type=Path, default=Path("data/corpus"))
    args = ap.parse_args()

    rows = load_seeds(Path("data/seeds.jsonl"))
    rows += [synthetic_example(i) for i in range(args.synthetic)]
    rows += load_beatmaps(args.beatmaps)
    if not rows:
        raise SystemExit("no training rows produced")

    train, val = split(rows)
    write_jsonl(args.out / "train.jsonl", train)
    write_jsonl(args.out / "val.jsonl", val)

    stats = {
        "total_examples": len(rows),
        "train_examples": len(train),
        "val_examples": len(val),
        "sources": {
            src: sum(1 for r in rows if r.get("source") == src)
            for src in sorted({r.get("source", "seed") for r in rows})
        },
        "total_bytes": sum(len(r["text"].encode("utf-8")) for r in rows),
        "mean_chars": round(sum(len(r["text"]) for r in rows) / len(rows), 1),
    }
    (args.out / "stats.json").write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
