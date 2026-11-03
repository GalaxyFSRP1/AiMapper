# MapperGPT — byte-level BPE tokenizer (inference side)
#
# Merges in tokenizer/vocab.json were learned by tokenizer/train_tokenizer.py
# over the raw byte stream. Encoding applies those merges in rank order, which
# is exactly what the training loop did, so encode/decode is lossless.
from __future__ import annotations

import heapq
import json
from pathlib import Path
from typing import Iterable, List

SPECIALS = ["<pad>", "<unk>", "<bos>", "<eos>"]
SPECIAL_IDS = {name: i for i, name in enumerate(SPECIALS)}


class BPETokenizer:
    def __init__(self, vocab: dict, merges: List[List[int]]):
        self.id_to_bytes: dict[int, bytes] = {}
        self.bytes_to_id: dict[bytes, int] = {}
        for raw_id, value in vocab.items():
            token_id = int(raw_id)
            if isinstance(value, str) and len(value) % 2 == 0 and all(c in "0123456789abcdefABCDEF" for c in value):
                data = bytes.fromhex(value)
            else:
                data = str(value).encode("utf-8")
            self.id_to_bytes[token_id] = data
            self.bytes_to_id.setdefault(data, token_id)
        self.merges = [(int(a), int(b)) for a, b in merges]
        self.ranks = {pair: i for i, pair in enumerate(self.merges)}

    # ---- construction ----------------------------------------------------
    @classmethod
    def from_file(cls, path: str | Path = "tokenizer/vocab.json") -> "BPETokenizer":
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(raw["vocab"], raw["merges"])

    @property
    def vocab_size(self) -> int:
        return len(self.id_to_bytes)

    # ---- encoding --------------------------------------------------------
    def _merge(self, ids: List[int]) -> List[int]:
        """Greedy lowest-rank merge, equivalent to the training-time procedure."""
        n = len(ids)
        if n < 2:
            return list(ids)
        prev = list(range(-1, n - 1))
        nxt = list(range(1, n + 1))
        nxt[-1] = -1
        alive = [True] * n

        heap = []
        for i in range(n - 1):
            rank = self.ranks.get((ids[i], ids[i + 1]))
            if rank is not None:
                heap.append((rank, i))
        heapq.heapify(heap)

        while heap:
            rank, left = heapq.heappop(heap)
            if not alive[left]:
                continue
            right = nxt[left]
            if right < 0 or not alive[right]:
                continue
            if self.ranks.get((ids[left], ids[right])) != rank:
                continue
            combined = self.id_to_bytes[ids[left]] + self.id_to_bytes[ids[right]]
            new_id = self.bytes_to_id.get(combined)
            if new_id is None:
                continue
            ids[left] = new_id
            alive[right] = False
            nxt[left] = nxt[right]
            if nxt[right] >= 0:
                prev[nxt[right]] = left
            if prev[left] >= 0:
                r = self.ranks.get((ids[prev[left]], ids[left]))
                if r is not None:
                    heapq.heappush(heap, (r, prev[left]))
            if nxt[left] >= 0:
                r = self.ranks.get((ids[left], ids[nxt[left]]))
                if r is not None:
                    heapq.heappush(heap, (r, left))

        out = []
        i = 0
        while i >= 0:
            out.append(ids[i])
            i = nxt[i]
        return out

    def encode(self, text: str, add_bos: bool = False, add_eos: bool = False) -> List[int]:
        ids = self._merge(list(text.encode("utf-8")))
        if add_bos:
            ids.insert(0, SPECIAL_IDS["<bos>"])
        if add_eos:
            ids.append(SPECIAL_IDS["<eos>"])
        return ids

    def encode_batch(self, texts: Iterable[str]) -> List[List[int]]:
        return [self.encode(t) for t in texts]

    # ---- decoding --------------------------------------------------------
    def decode(self, ids: Iterable[int], skip_special: bool = True) -> str:
        buf = bytearray()
        for token_id in ids:
            token_id = int(token_id)
            if skip_special and token_id in SPECIAL_IDS.values():
                continue
            chunk = self.id_to_bytes.get(token_id)
            if chunk is None:
                continue
            if token_id in SPECIAL_IDS.values():
                buf.extend(chunk)
            else:
                buf.extend(chunk)
        return buf.decode("utf-8", errors="replace")

    def roundtrip_ok(self, text: str) -> bool:
        return self.decode(self.encode(text)) == text
