'use strict';
/* Dataset/template generation + byte-level BPE training.

   The corpus is real: seed examples shipped with the generator plus
   deterministically synthesised map specifications rendered into the
   `mapper-gpt/1` text format. The BPE vocab produced here is the vocab the
   model's embedding matrix is sized for, and it round-trips losslessly
   (verified by validate.py and by the app's own validation step).
*/

const SPLIT_RE = /[A-Za-z]+|\d+|[^\sA-Za-z\d]+|\s+/g;
const SPECIALS = ['<pad>', '<unk>', '<bos>', '<eos>'];

const GENRES = ['edm', 'rock', 'pop', 'hiphop', 'metal', 'ambient', 'dnb', 'jpop', 'classical', 'synthwave'];
const DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
const DIRS = ['up', 'down', 'left', 'right', 'up_left', 'up_right', 'down_left', 'down_right'];

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFrom(seed) {
  let a = hash32(String(seed));
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

/** Renders a canonical note map. This is both training text and the model's target format. */
function renderMap(spec, rnd) {
  const lines = [
    `# map: ${spec.genre} ${spec.bpm}bpm difficulty=${spec.difficulty}`,
    '# schema: mapper-gpt/1',
    'map {',
    `  bpm = ${spec.bpm}`,
    `  duration = ${spec.duration.toFixed(2)}`,
    `  style = "${spec.style}"`,
    '  notes [',
  ];
  let beat = 0.5;
  const step = Math.max(0.25, Math.round((1 / Math.max(spec.density, 0.01) / 4) * 100) / 100);
  let guard = 0;
  while (beat < spec.duration && guard++ < 800) {
    const hand = rnd() < 0.5 ? 'red' : 'blue';
    const lane = Math.floor(rnd() * 4);
    const row = rnd() < 0.6 ? 0 : rnd() < 0.8 ? 1 : 2;
    const dir = pick(rnd, DIRS);
    lines.push(`    { t = ${beat.toFixed(2).padStart(6)}, hand = ${hand}, lane = ${lane}, row = ${row}, dir = ${dir} }`);
    if (rnd() < spec.density * 0.25) {
      const other = hand === 'red' ? 'blue' : 'red';
      lines.push(`    { t = ${beat.toFixed(2).padStart(6)}, hand = ${other}, lane = ${3 - lane}, row = ${row}, dir = ${dir} }`);
    }
    beat = Math.round((beat + step) * 100) / 100;
  }
  lines.push('  ]', '}');
  return lines.join('\n');
}

function promptFor(spec) {
  return `map a level for a ${(spec.duration / 60).toFixed(1)} minute ${spec.genre} track at ${spec.bpm} bpm, ` +
    `style=${spec.style}, difficulty=${spec.difficulty}, density=${spec.density.toFixed(2)}`;
}

function synthesise(seed, index) {
  const rnd = rngFrom(`${seed}:synth:${index}`);
  const genre = GENRES[index % GENRES.length];
  const difficulty = DIFFICULTIES[index % DIFFICULTIES.length];
  const bpm = pick(rnd, [90, 100, 110, 120, 128, 140, 150, 160, 174, 180]);
  const duration = pick(rnd, [60, 90, 120, 150, 180]);
  const base = { Easy: 0.25, Normal: 0.4, Hard: 0.6, Expert: 0.8, ExpertPlus: 1.0 }[difficulty];
  const density = Math.min(1.5, Math.round(base * (0.85 + rnd() * 0.3) * 1000) / 1000);
  const spec = { genre, bpm, duration, style: difficulty.toLowerCase(), difficulty, density };
  return {
    id: `synthetic-${String(index).padStart(6, '0')}`,
    source: 'synthetic',
    prompt: promptFor(spec),
    completion: renderMap(spec, rnd),
    meta: spec,
  };
}

const SEED_EXAMPLES = [
  {
    id: 'seed-edm-drop',
    prompt: 'map a level for a 3.0 minute edm track at 128 bpm, style=expert, difficulty=Expert, density=0.80',
    completion: `# map: edm 128bpm difficulty=Expert
# schema: mapper-gpt/1
map {
  bpm = 128
  duration = 12.00
  style = "expert"
  notes [
    { t =   0.50, hand = red, lane = 1, row = 0, dir = down },
    { t =   0.75, hand = blue, lane = 2, row = 1, dir = up },
    { t =   1.00, hand = red, lane = 0, row = 0, dir = down_left },
    { t =   1.25, hand = blue, lane = 3, row = 1, dir = up_right },
    { t =   1.50, hand = red, lane = 1, row = 1, dir = down },
    { t =   1.50, hand = blue, lane = 2, row = 1, dir = down },
    { t =   2.00, hand = red, lane = 1, row = 0, dir = right },
    { t =   2.25, hand = blue, lane = 2, row = 0, dir = left },
  ]
}`,
  },
  {
    id: 'seed-chill-verse',
    prompt: 'map a level for a 2.0 minute ambient track at 90 bpm, style=easy, difficulty=Easy, density=0.25',
    completion: `# map: ambient 90bpm difficulty=Easy
# schema: mapper-gpt/1
map {
  bpm = 90
  duration = 8.00
  style = "easy"
  notes [
    { t =   1.00, hand = red, lane = 1, row = 0, dir = down },
    { t =   2.00, hand = blue, lane = 2, row = 0, dir = down },
    { t =   3.00, hand = red, lane = 1, row = 1, dir = up },
    { t =   4.00, hand = blue, lane = 2, row = 1, dir = up },
    { t =   5.00, hand = red, lane = 0, row = 0, dir = down_right },
    { t =   6.00, hand = blue, lane = 3, row = 0, dir = down_left },
  ]
}`,
  },
  {
    id: 'seed-vibro',
    prompt: 'map a level for a 1.5 minute dnb track at 174 bpm, style=expertplus, difficulty=ExpertPlus, density=1.00',
    completion: `# map: dnb 174bpm difficulty=ExpertPlus
# schema: mapper-gpt/1
map {
  bpm = 174
  duration = 6.00
  style = "expertplus"
  notes [
    { t =   0.25, hand = red, lane = 1, row = 0, dir = down },
    { t =   0.50, hand = blue, lane = 2, row = 0, dir = down },
    { t =   0.75, hand = red, lane = 1, row = 1, dir = up },
    { t =   1.00, hand = blue, lane = 2, row = 1, dir = up },
    { t =   1.25, hand = red, lane = 1, row = 0, dir = down },
    { t =   1.50, hand = blue, lane = 2, row = 0, dir = down },
    { t =   1.75, hand = red, lane = 0, row = 0, dir = down_right },
    { t =   2.00, hand = blue, lane = 3, row = 0, dir = down_left },
  ]
}`,
  },
];

function toRow(example) {
  const text = example.text || `<bos>${example.prompt}\n${example.completion}<eos>`;
  return { ...example, text };
}

/** Builds the full corpus (train/val split) deterministically. */
function buildCorpus({ seed = 'default', synthetic = 64, extraSeeds = [] } = {}) {
  const rows = [];
  for (const example of [...SEED_EXAMPLES, ...extraSeeds]) rows.push(toRow({ source: 'seed', ...example }));
  for (let i = 0; i < synthetic; i++) rows.push(toRow(synthesise(seed, i)));

  // deterministic shuffle + 2% validation split
  const rnd = rngFrom(`${seed}:split`);
  const shuffled = rows.map((row, i) => ({ row, k: rnd(), i })).sort((a, b) => a.k - b.k).map((x) => x.row);
  const valCount = Math.max(1, Math.floor(shuffled.length * 0.02));
  const val = shuffled.slice(0, valCount);
  const train = shuffled.slice(valCount);

  const stats = {
    total_examples: rows.length,
    train_examples: train.length,
    val_examples: val.length,
    sources: rows.reduce((acc, r) => ((acc[r.source] = (acc[r.source] || 0) + 1), acc), {}),
    total_bytes: rows.reduce((n, r) => n + Buffer.byteLength(r.text, 'utf8'), 0),
    mean_chars: Math.round((rows.reduce((n, r) => n + r.text.length, 0) / Math.max(1, rows.length)) * 10) / 10,
    format: 'mapper-gpt/1',
  };
  return { train, val, all: rows, stats };
}

// ---------------------------------------------------------------------------
// Byte-level BPE over the raw byte stream (no pre-tokenisation).
//
// Fast implementation: pair frequencies live in a flat typed-array histogram
// (only touched cells are rescanned), and merges are applied with two
// pre-allocated buffers. Training a 40 KB stream for ~2k merges takes well
// under a second, and the result is deterministic for a given corpus.
//
// tokenizer/train_tokenizer.py implements the identical algorithm so CI can
// retrain and reproduce the committed vocabulary.
// ---------------------------------------------------------------------------
const DEFAULT_TRAIN_BYTES = 40000;

function trainBPE(texts, vocabSize, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_TRAIN_BYTES;
  const stream = [];
  let budget = 0;
  for (const text of texts) {
    const buf = Buffer.from(String(text), 'utf8');
    if (budget + buf.length > maxBytes && stream.length > 0) break;
    stream.push(buf, Buffer.from('\n'));
    budget += buf.length + 1;
  }
  const joined = Buffer.concat(stream);

  const vocab = [];
  for (let i = 0; i < 256; i++) vocab.push(Buffer.from([i]));
  for (const special of SPECIALS) vocab.push(Buffer.from(special, 'utf8'));

  let n = joined.length;
  let cur = new Int32Array(n);
  let nxt = new Int32Array(n);
  for (let i = 0; i < n; i++) cur[i] = joined[i];

  // histogram over pairs; stride = vocabSize keeps keys unique
  const stride = Math.max(2048, vocabSize);
  const counts = new Uint32Array(stride * stride > 0 ? Math.min(stride * stride, 1 << 26) : 16384);
  const useHistogram = counts.length >= stride * stride;
  const touched = new Int32Array(Math.min(1 << 20, counts.length));
  let touchedCount = 0;
  const mapCounts = useHistogram ? null : new Map();

  const merges = [];
  while (vocab.length < vocabSize && n > 1) {
    let bestKey = -1;
    let bestCount = 0;
    if (useHistogram) {
      touchedCount = 0;
      for (let i = 0; i < n - 1; i++) {
        const key = cur[i] * stride + cur[i + 1];
        if (counts[key]++ === 0) touched[touchedCount++] = key;
      }
      for (let i = 0; i < touchedCount; i++) {
        const key = touched[i];
        const count = counts[key];
        if (count > bestCount || (count === bestCount && bestKey >= 0 && key < bestKey)) {
          bestCount = count;
          bestKey = key;
        }
      }
      for (let i = 0; i < touchedCount; i++) counts[touched[i]] = 0;
      if (bestCount < 2) break;
    } else {
      mapCounts.clear();
      for (let i = 0; i < n - 1; i++) {
        const key = cur[i] * stride + cur[i + 1];
        mapCounts.set(key, (mapCounts.get(key) || 0) + 1);
      }
      for (const [key, count] of mapCounts) {
        if (count > bestCount || (count === bestCount && bestKey >= 0 && key < bestKey)) {
          bestCount = count;
          bestKey = key;
        }
      }
      if (bestCount < 2) break;
    }

    const left = Math.floor(bestKey / stride);
    const right = bestKey % stride;
    const newId = vocab.length;
    vocab.push(Buffer.concat([vocab[left], vocab[right]]));
    merges.push([left, right]);

    let m = 0;
    for (let i = 0; i < n; i++) {
      if (i < n - 1 && cur[i] === left && cur[i + 1] === right) {
        nxt[m++] = newId;
        i++;
      } else {
        nxt[m++] = cur[i];
      }
    }
    const swap = cur; cur = nxt; nxt = swap;
    n = m;
  }

  const vocabOut = {};
  for (let id = 0; id < vocab.length; id++) {
    const buf = vocab[id];
    const special = SPECIALS.find((sp) => sp === buf.toString('utf8') && buf.length > 1);
    vocabOut[id] = special ? special : buf.toString('hex');
  }
  return {
    version: 2,
    algorithm: 'byte-level-bpe',
    pre_tokenizer: null,
    special_tokens: SPECIALS,
    vocab_size: vocab.length,
    training_bytes: joined.length,
    training_documents: stream.length / 2,
    vocab: vocabOut,
    merges,
  };
}

/** Exact greedy BPE encoder (min-heap over merge ranks: O(n log n) per text). */
function makeEncoder(vocabJson) {
  const idToBytes = new Map();
  const bytesToId = new Map();
  for (const [id, value] of Object.entries(vocabJson.vocab)) {
    const buf = /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0 ? Buffer.from(value, 'hex') : Buffer.from(value, 'utf8');
    idToBytes.set(Number(id), buf);
    if (!bytesToId.has(buf.toString('hex'))) bytesToId.set(buf.toString('hex'), Number(id));
  }
  const ranks = new Map();
  vocabJson.merges.forEach(([a, b], i) => ranks.set(`${a},${b}`, i));

  function encode(text) {
    const bytes = Buffer.from(String(text), 'utf8');
    const n = bytes.length;
    if (n === 0) return [];
    const ids = Int32Array.from(bytes);
    const prev = new Int32Array(n);
    const next = new Int32Array(n);
    const merged = new Uint8Array(n);
    for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
    next[n - 1] = -1;

    const rankOf = (a, b) => {
      const rank = ranks.get(`${ids[a]},${ids[b]}`);
      return rank === undefined ? -1 : rank;
    };

    // simple binary heap of [rank, index]
    const heapRank = [];
    const heapIdx = [];
    const swap = (i, j) => {
      const r = heapRank[i]; heapRank[i] = heapRank[j]; heapRank[j] = r;
      const x = heapIdx[i]; heapIdx[i] = heapIdx[j]; heapIdx[j] = x;
    };
    const push = (rank, idx) => {
      heapRank.push(rank); heapIdx.push(idx);
      let i = heapRank.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapRank[parent] <= heapRank[i]) break;
        swap(parent, i);
        i = parent;
      }
    };
    const pop = () => {
      const last = heapRank.length - 1;
      swap(0, last);
      heapRank.pop(); heapIdx.pop();
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < heapRank.length && heapRank[l] < heapRank[small]) small = l;
        if (r < heapRank.length && heapRank[r] < heapRank[small]) small = r;
        if (small === i) break;
        swap(i, small);
        i = small;
      }
    };

    for (let i = 0; i < n - 1; i++) {
      const rank = rankOf(i, next[i]);
      if (rank >= 0) push(rank, i);
    }

    while (heapRank.length) {
      const rank = heapRank[0];
      const left = heapIdx[0];
      pop();
      if (merged[left]) continue;
      const right = next[left];
      if (right < 0 || merged[right]) continue;
      if (rankOf(left, right) !== rank) continue;

      const combined = Buffer.concat([idToBytes.get(ids[left]), idToBytes.get(ids[right])]);
      const newId = bytesToId.get(combined.toString('hex'));
      if (newId === undefined) continue;

      ids[left] = newId;
      merged[right] = 1;
      next[left] = next[right];
      if (next[right] >= 0) prev[next[right]] = left;

      if (prev[left] >= 0) {
        const r = rankOf(prev[left], left);
        if (r >= 0) push(r, prev[left]);
      }
      if (next[left] >= 0) {
        const r = rankOf(left, next[left]);
        if (r >= 0) push(r, left);
      }
    }

    // walk the (possibly merged) chain from the head
    const out = [];
    let i = 0;
    while (i >= 0) {
      out.push(ids[i]);
      i = next[i];
    }
    return out;
  }

  return {
    get vocabSize() { return idToBytes.size; },
    encode,
    decode(ids) {
      return Buffer.concat(ids.map((id) => idToBytes.get(id) || Buffer.alloc(0))).toString('utf8');
    },
  };
}

module.exports = { buildCorpus, trainBPE, makeEncoder, renderMap, promptFor, SEED_EXAMPLES, SPECIALS };
