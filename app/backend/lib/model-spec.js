'use strict';
/* Architecture synthesis + parameter accounting + weight initialisation.

   Nothing here is simulated: given a target parameter budget the search below
   enumerates valid transformer decoder configurations, computes the EXACT
   trainable parameter count for each one, and returns the configuration that
   lands closest to the target. The same analytic counter is re-implemented in
   the generated repo (scripts/validate.py) so GitHub Actions can independently
   confirm the number against the tensor manifest.
*/

const crypto = require('node:crypto');

const LIMITS = {
  target: { min: 100_000, max: 500_000_000 },
  layers: { min: 2, max: 48 },
  heads: [2, 4, 6, 8, 12, 16],
  ctx: [64, 128, 256, 512],
  ffMult: [2, 3, 4],
};

/** Exact trainable parameter count for a decoder-only transformer. */
function countParameters(cfg) {
  const d = cfg.d_model;
  const V = cfg.vocab_size;
  const ctx = cfg.n_ctx;
  const ff = cfg.d_ff;
  const L = cfg.n_layer;

  const embedding = cfg.tie_word_embeddings ? V * d : V * d * 2;
  const positional = ctx * d;
  const perLayer =
    // ln_1 + ln_2 (weight + bias each)
    2 * 2 * d +
    // c_attn: [d, 3d] + bias[3d]
    3 * d * d + 3 * d +
    // c_proj: [d, d] + bias[d]
    d * d + d +
    // mlp fc_in: [ff, d] + bias[ff]
    ff * d + ff +
    // mlp fc_out: [d, ff] + bias[d]
    d * ff + d;
  const finalLn = 2 * d;
  return {
    embedding,
    positional,
    perLayer,
    blocks: perLayer * L,
    finalLn,
    total: embedding + positional + perLayer * L + finalLn,
  };
}

/** Which layer/parameter manifests a configuration produces (source of truth
 *  for both the weight writer and the architecture view in the dashboard). */
function layerManifest(cfg) {
  const d = cfg.d_model;
  const ff = cfg.d_ff;
  const V = cfg.vocab_size;
  const ctx = cfg.n_ctx;
  const layers = [];

  layers.push({ name: 'token_embedding', kind: 'embed', shape: [V, d], indent: 0, width: 0.5, params: V * d });
  layers.push({ name: 'position_embedding', kind: 'embed', shape: [ctx, d], indent: 0, width: 0.4, params: ctx * d });

  for (let i = 0; i < cfg.n_layer; i++) {
    layers.push({ name: `block${i}.ln_1`, kind: 'norm', shape: [d], indent: 1, width: 0.15, params: 2 * d });
    layers.push({ name: `block${i}.attn.qkv`, kind: 'attention', shape: [d, 3 * d], indent: 1, width: 0.8, params: 3 * d * d + 3 * d });
    layers.push({ name: `block${i}.attn.proj`, kind: 'attention', shape: [d, d], indent: 1, width: 0.5, params: d * d + d });
    layers.push({ name: `block${i}.ln_2`, kind: 'norm', shape: [d], indent: 1, width: 0.15, params: 2 * d });
    layers.push({ name: `block${i}.mlp.in`, kind: 'mlp', shape: [ff, d], indent: 1, width: 0.9, params: ff * d + ff });
    layers.push({ name: `block${i}.mlp.out`, kind: 'mlp', shape: [d, ff], indent: 1, width: 0.9, params: ff * d + d });
  }

  layers.push({ name: 'final_norm', kind: 'norm', shape: [d], indent: 0, width: 0.15, params: 2 * d });
  layers.push({
    name: 'lm_head',
    kind: 'head',
    shape: [d, V],
    indent: 0,
    width: 0.6,
    params: cfg.tie_word_embeddings ? 0 : d * V,
    note: cfg.tie_word_embeddings ? 'tied to token_embedding' : 'untied',
  });
  return layers;
}

/** Enumerate candidate architectures and pick the closest to `target`. */
function searchArchitecture(target, vocabSize, options = {}) {
  if (!Number.isFinite(target) || target < LIMITS.target.min || target > LIMITS.target.max) {
    throw new Error(`target parameters must be between ${LIMITS.target.min} and ${LIMITS.target.max}`);
  }
  const ctxChoices = options.nCtx ? [options.nCtx] : LIMITS.ctx;
  const candidates = [];

  for (const heads of LIMITS.heads) {
    for (const mult of LIMITS.ffMult) {
      for (const ctx of ctxChoices) {
        // width must be divisible by head count; step by `heads` so head_dim stays integral
        const minWidth = heads * 16;
        const maxWidth = Math.min(1024, heads * 128);
        for (let d = minWidth; d <= maxWidth; d += heads) {
          const ff = multiplierToFF(d, mult);
          if (ff % 8 !== 0) continue;
          // depth implied by budget given width
          const base = {
            vocab_size: vocabSize,
            n_ctx: ctx,
            d_model: d,
            n_head: heads,
            d_ff: ff,
            n_layer: 2,
            tie_word_embeddings: true,
          };
          const fixed = countParameters({ ...base, n_layer: 0 }).total;
          const perLayer = countParameters({ ...base, n_layer: 1 }).perLayer;
          const estLayers = Math.round((target - fixed) / perLayer);
          for (const L of [estLayers - 1, estLayers, estLayers + 1]) {
            if (L < LIMITS.layers.min || L > LIMITS.layers.max) continue;
            const cfg = { ...base, n_layer: L };
            const counts = countParameters(cfg);
            candidates.push({ cfg, counts, delta: Math.abs(counts.total - target) });
          }
        }
      }
    }
  }

  if (!candidates.length) throw new Error('no architecture candidate fit the requested budget');
  candidates.sort((a, b) => a.delta - b.delta || a.counts.total - b.counts.total);
  const best = candidates[0];
  const within = candidates.filter((c) => c.delta <= Math.max(1000, target * 0.005));

  return {
    config: {
      ...best.cfg,
      target_parameters: target,
      achieved_parameters: best.counts.total,
      deviation: Number(((best.counts.total - target) / target * 100).toFixed(4)),
      candidates_considered: candidates.length,
      candidates_within_budget: within.length,
      parameter_breakdown: best.counts,
      head_dim: best.cfg.d_model / best.cfg.n_head,
      activation: 'gelu',
      norm: 'layernorm',
      model_type: 'mapper_gpt',
      architectures: ['MapperGPTForCausalLM'],
    },
    alternatives: candidates.slice(1, 6).map((c) => ({
      d_model: c.cfg.d_model,
      n_layer: c.cfg.n_layer,
      n_head: c.cfg.n_head,
      d_ff: c.cfg.d_ff,
      n_ctx: c.cfg.n_ctx,
      total: c.counts.total,
      deviation_pct: Number(((c.counts.total - target) / target * 100).toFixed(3)),
    })),
  };
}

function multiplierToFF(d, mult) {
  const raw = d * mult;
  // round to a multiple of 8 as PyTorch tensor-core friendly sizes
  return Math.max(8, Math.round(raw / 8) * 8);
}

// ---------------------------------------------------------------------------
// Deterministic RNG: identical seed => identical weights, reproducible builds
// ---------------------------------------------------------------------------
function hashSeed(seedString) {
  const h = crypto.createHash('sha256').update(String(seedString)).digest();
  return h.readUInt32LE(0);
}

function mulberry32(a) {
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal generator driven by a deterministic uniform source. */
function makeNormal(seedString) {
  const rand = mulberry32(hashSeed(seedString));
  let spare = null;
  return function normal() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

/**
 * Build the full tensor list with real initialised values.
 * Tensors use [out_features, in_features] linear layout (PyTorch convention).
 */
function initialiseWeights(cfg, seed) {
  const tensors = [];
  const push = (name, shape, fill, meta = {}) => {
    const size = shape.reduce((a, b) => a * b, 1);
    const data = new Float32Array(size);
    fill(data, size);
    tensors.push({ name, shape, dtype: 'F32', data, ...meta });
  };

  const d = cfg.d_model;
  const ff = cfg.d_ff;
  const V = cfg.vocab_size;
  const ctx = cfg.n_ctx;

  // Embeddings: N(0, 0.02) (GPT-2 init)
  {
    const n = makeNormal(`${seed}:tok_emb`);
    push('model.tok_emb.weight', [V, d], (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = n() * 0.02;
    }, { init: 'normal(0, 0.02)', group: 'embedding' });
  }
  {
    const n = makeNormal(`${seed}:pos_emb`);
    push('model.pos_emb.weight', [ctx, d], (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = n() * 0.01;
    }, { init: 'normal(0, 0.01)', group: 'embedding' });
  }

  for (let i = 0; i < cfg.n_layer; i++) {
    // LayerNorms start at identity
    push(`model.blocks.${i}.ln_1.weight`, [d], (arr) => arr.fill(1), { init: 'ones', group: 'norm' });
    push(`model.blocks.${i}.ln_1.bias`, [d], (arr) => arr.fill(0), { init: 'zeros', group: 'norm' });
    push(`model.blocks.${i}.ln_2.weight`, [d], (arr) => arr.fill(1), { init: 'ones', group: 'norm' });
    push(`model.blocks.${i}.ln_2.bias`, [d], (arr) => arr.fill(0), { init: 'zeros', group: 'norm' });

    // Linear layers: Kaiming normal with PyTorch's default fan_in
    linear(push, `${seed}:l${i}:qkv`, `model.blocks.${i}.attn.c_attn.weight`, [3 * d, d], 1.0, n => n);
    push(`model.blocks.${i}.attn.c_attn.bias`, [3 * d], (arr) => arr.fill(0), { init: 'zeros', group: 'attention' });
    linear(push, `${seed}:l${i}:attn_proj`, `model.blocks.${i}.attn.c_proj.weight`, [d, d], 1 / Math.sqrt(2 * cfg.n_layer), n => n);
    push(`model.blocks.${i}.attn.c_proj.bias`, [d], (arr) => arr.fill(0), { init: 'zeros', group: 'attention' });
    linear(push, `${seed}:l${i}:fc_in`, `model.blocks.${i}.mlp.fc_in.weight`, [ff, d], 1.0, n => n);
    push(`model.blocks.${i}.mlp.fc_in.bias`, [ff], (arr) => arr.fill(0), { init: 'zeros', group: 'mlp' });
    linear(push, `${seed}:l${i}:fc_out`, `model.blocks.${i}.mlp.fc_out.weight`, [d, ff], 1 / Math.sqrt(2 * cfg.n_layer), n => n);
    push(`model.blocks.${i}.mlp.fc_out.bias`, [d], (arr) => arr.fill(0), { init: 'zeros', group: 'mlp' });
  }

  push('model.ln_f.weight', [d], (arr) => arr.fill(1), { init: 'ones', group: 'norm' });
  push('model.ln_f.bias', [d], (arr) => arr.fill(0), { init: 'zeros', group: 'norm' });

  const total = tensors.reduce((sum, t) => sum + t.data.length, 0);
  return { tensors, total };
}

function linear(push, seed, name, shape, scale, _x) {
  const [outF, inF] = shape;
  const std = Math.sqrt(2 / inF) * scale; // kaiming_normal_ equivalent (fan_in, relu gain)
  const n = makeNormal(seed);
  push(name, shape, (arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = n() * std;
  }, { init: `kaiming_normal(fan_in=${inF}, gain=sqrt2)${scale !== 1 ? ` * ${scale.toFixed(6)}` : ''}`, group: 'linear' });
}

// ---------------------------------------------------------------------------
// safetensors writer (real, loadable by the safetensors/transformers libs)
// ---------------------------------------------------------------------------
function writeSafetensors(tensors, metadata = {}) {
  const header = {};
  const blobs = [];
  let offset = 0;
  // safetensors requires deterministic key ordering
  const sorted = [...tensors].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const t of sorted) {
    const bytes = Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength);
    header[t.name] = { dtype: t.dtype, shape: t.shape, data_offsets: [offset, offset + bytes.length] };
    blobs.push(bytes);
    offset += bytes.length;
  }
  header.__metadata__ = Object.fromEntries(
    Object.entries(metadata).map(([k, v]) => [String(k), String(v)])
  );

  let json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (8 - (json.length % 8)) % 8;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(json.length), 0);
  return Buffer.concat([lenBuf, json, ...blobs]);
}

function readSafetensors(buf) {
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.slice(8, 8 + headerLen).toString('utf8'));
  const out = new Map();
  for (const [name, info] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const [start, end] = info.data_offsets;
    const data = buf.slice(8 + headerLen + start, 8 + headerLen + end);
    out.set(name, { shape: info.shape, dtype: info.dtype, data });
  }
  return { tensors: out, metadata: header.__metadata__ || {} };
}

module.exports = {
  LIMITS,
  countParameters,
  layerManifest,
  searchArchitecture,
  initialiseWeights,
  writeSafetensors,
  readSafetensors,
  hashSeed,
  makeNormal,
};
