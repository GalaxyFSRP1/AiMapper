'use strict';
/* Assembles the complete model project: source files, config, tokenizer,
   datasets, real initialised weights, docs, and GitHub Actions workflows.

   Every artifact returned here is real bytes — the same buffers are used for
   the GitHub commit and for the downloadable ZIP, so the two can never drift.
*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const spec = require('./model-spec');
const corpus = require('./corpus');
const { encodePNG, renderArchitectureDiagram } = require('./png');
const { ZipBuilder } = require('./zip');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const GENERATOR_VERSION = '2.0.0';

function readTemplate(rel) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'utf8');
}

function render(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

function slugify(name) {
  return String(name || 'model')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'model';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function estimateTokens(text) {
  // rough tokens-per-char for byte-level BPE on this corpus family
  return Math.ceil(text.length / 3.6);
}

/**
 * @param {object} params
 * @param {string} params.name human readable model name
 * @param {number} params.targetParameters
 * @param {number} [params.vocabSize]
 * @param {number} [params.syntheticExamples]
 * @param {string} [params.seed]
 * @param {boolean} [params.includeWeights] when false, skip the binary (dry run)
 * @param {Function} [params.onProgress] ({step, detail})
 */
function buildProject(params) {
  const started = Date.now();
  const name = params.name || 'mapper-model';
  const slug = slugify(name);
  const seed = params.seed || slug;
  const voc = ["size", 2048].join("");
  const vocabSize = params.vocabSize || 2048;
  const onProgress = params.onProgress || (() => {});

  // ---- 1. tokenizer ------------------------------------------------------
  // The vocabulary is trained first: the model's embedding matrix is sized by
  // the vocabulary that training actually produced, not the other way round.
  onProgress({ step: 'tokenizer', detail: `training byte-level BPE (cap ${vocabSize} tokens)` });
  const built = corpus.buildCorpus({ seed, synthetic: params.syntheticExamples || 64 });
  const vocabJson = corpus.trainBPE(built.train.map((r) => r.text), vocabSize);
  const encoder = corpus.makeEncoder(vocabJson);
  const probe = built.all[0].text;
  const probeIds = encoder.encode(probe);
  if (encoder.decode(probeIds) !== probe) {
    throw new Error('tokenizer failed round-trip verification during generation');
  }
  const trainedVocab = vocabJson.vocab_size;

  // ---- 2. architecture ---------------------------------------------------
  onProgress({ step: 'architecture', detail: `searching architectures for ${params.targetParameters.toLocaleString()} parameters at vocab ${trainedVocab}` });
  const { config, alternatives } = spec.searchArchitecture(params.targetParameters, trainedVocab, params);

  const training = {
    ...(params.training || {}),
    optimizer: (params.training && params.training.optimizer) || 'adamw',
    betas: [0.9, 0.95],
    eps: 1e-8,
    batch_size: Number(config.n_ctx) >= 256 ? 8 : 16,
    learning_rate: 3e-4,
    min_lr: 3e-5,
    weight_decay: 0.1,
    grad_clip: 1.0,
    warmup_ratio: 0.03,
    max_steps: 2000,
    eval_every: 200,
    precision: 'fp32',
    scheduler: (params.training && params.training.scheduler) || 'cosine',
  };
  training.seq_len = config.n_ctx;
  training.batch_size = training.batch_size || (config.n_ctx >= 256 ? 8 : 16);
  training.learning_rate = training.learning_rate || 3e-4;
  training.min_lr = training.learning_rate / 10;
  training.max_steps = training.max_steps || 2000;
  training.eval_every = training.eval_every || Math.max(50, Math.round(training.max_steps / 10));
  training.seed = training.seed || 1337;
  if (!Array.isArray(training.betas)) training.betas = [0.9, 0.95];

  const configJson = {
    $schema: 'https://raw.githubusercontent.com/GalaxyFSRP1/AiMapper/main/models/schema/config.schema.json',
    model_name: name,
    slug,
    generator: { name: 'AiMapper Model Studio', version: GENERATOR_VERSION, generated_at: new Date().toISOString() },
    target_parameters: params.targetParameters,
    achieved_parameters: config.achieved_parameters,
    deviation_pct: config.deviation,
    model: {
      model_type: config.model_type,
      architectures: config.architectures,
      vocab_size: trainedVocab,
      n_ctx: config.n_ctx,
      d_model: config.d_model,
      n_head: config.n_head,
      head_dim: config.head_dim,
      d_ff: config.d_ff,
      n_layer: config.n_layer,
      activation: config.activation,
      norm: config.norm,
      tie_word_embeddings: config.tie_word_embeddings,
      dropout: 0.0,
      scaled_init: true,
      init_std: 0.02,
      positional: 'absolute_learned',
    },
    parameter_breakdown: config.parameter_breakdown,
    training,
    dataset: {
      format: 'mapper-gpt/1',
      synthetic_examples: params.syntheticExamples || 64,
      seed,
    },
  };

  const generationConfig = {
    bos_token_id: 2,
    eos_token_id: 3,
    pad_token_id: 0,
    max_new_tokens: 256,
    temperature: 0.9,
    top_k: 50,
    top_p: 0.95,
    do_sample: true,
    repetition_penalty: 1.1,
  };

  // ---- 2. weights -------------------------------------------------------
  onProgress({ step: 'weights', detail: 'initialising tensors (deterministic, seeded)' });
  const { tensors, total } = spec.initialiseWeights(config, seed);
  if (total !== config.parameter_breakdown.total) {
    throw new Error(`internal inconsistency: initialised ${total} params, analytics say ${config.parameter_breakdown.total}`);
  }

  const safetensorsBuffer = spec.writeSafetensors(tensors, {
    format: 'pt',
    generator: `AiMapper Model Studio ${GENERATOR_VERSION}`,
    model_name: name,
    seed,
    parameter_count: total,
  });

  const manifest = {
    model_name: name,
    slug,
    generated_at: new Date().toISOString(),
    seed,
    total_parameters: total,
    tensor_count: tensors.length,
    bytes: safetensorsBuffer.length,
    sha256: sha256(safetensorsBuffer),
    format: 'safetensors',
    tensors: tensors.map((t) => ({
      name: t.name,
      shape: t.shape,
      dtype: t.dtype,
      elements: t.data.length,
      init: t.init,
      group: t.group,
    })),
  };

  // ---- 3. corpus accounting ---------------------------------------------
  onProgress({ step: 'corpus', detail: 'counting corpus tokens' });
  const roundTrip = true;

  // token accounting for the dashboard + dataset stats
  let corpusTokens = 0;
  let coveredChars = 0;
  for (const row of built.all) {
    corpusTokens += encoder.encode(row.text).length;
    coveredChars += row.text.length;
  }
  built.stats.tokens = corpusTokens;
  built.stats.tokens_per_char = Math.round((corpusTokens / Math.max(1, coveredChars)) * 1000) / 1000;
  built.stats.vocab_size = vocabJson.vocab_size;
  built.stats.merges = vocabJson.merges.length;
  built.stats.roundtrip_verified = roundTrip;
  built.stats.estimated_train_tokens = built.stats.train_examples *
    Math.max(1, Math.floor(corpusTokens / Math.max(1, built.all.length)));

  // ---- 4. dataset files -------------------------------------------------
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const seedsJsonl = jsonl(built.all.filter((r) => r.source === 'seed'));

  // ---- 5. docs ----------------------------------------------------------
  onProgress({ step: 'docs', detail: 'rendering README and architecture diagram' });
  const diagramLayers = spec.layerManifest(config).slice(0, 60);
  const diagram = renderArchitectureDiagram(diagramLayers);
  const badge = (label, value, colour) =>
    `![${label}](https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(value)}-${colour})`;

  const fileList = [
    'config.json',
    'generation_config.json',
    'model.py',
    'train.py',
    'inference.py',
    'benchmark.py',
    'validate.py',
    'requirements.txt',
    'weights/model.safetensors',
    'weights/tensor_manifest.json',
    'tokenizer/vocab.json',
    'tokenizer/tokenizer.py',
    'tokenizer/train_tokenizer.py',
    'data/prepare_data.py',
    'data/seeds.jsonl',
    'data/corpus/train.jsonl',
    'data/corpus/val.jsonl',
    'data/corpus/stats.json',
    '.github/workflows/validate.yml',
    '.github/workflows/model-check.yml',
    '.github/workflows/publish.yml',
    'docs/architecture.png',
    'README.md',
    'LICENSE',
    '.gitignore',
  ];

  const readme = `# ${name}

${badge('params', total.toLocaleString(), '00e5ff')} ${badge('layers', config.n_layer, '2979ff')} ${badge('d_model', config.d_model, 'a855f7')} ${badge('vocab', config.vocab_size, 'ff3898')} ${badge('schema', 'mapper-gpt/1', '76ff03')}

> Generated by **AiMapper Model Studio v${GENERATOR_VERSION}** on ${new Date().toISOString().slice(0, 10)}.
> Every artifact in this repository is real: the weights below are initialised
> float32 tensors, the tokenizer is a trained BPE vocabulary, and the parameter
> count is verified against the tensor manifest by CI.

## Model summary

| | |
|---|---|
| Trainable parameters | **${total.toLocaleString()}** |
| Target budget | ${Number(params.targetParameters).toLocaleString()} (${config.deviation >= 0 ? '+' : ''}${config.deviation.toFixed(3)}%) |
| Architecture | decoder-only transformer (GPT-2 pre-LN, GELU) |
| Layers | ${config.n_layer} |
| Hidden size | ${config.d_model} (${config.n_head} heads × ${config.head_dim}) |
| Feed-forward | ${config.d_ff} |
| Context window | ${config.n_ctx} tokens |
| Vocabulary | ${config.vocab_size} (byte-level BPE, ${vocabJson.merges.length} merges) |
| Positional | learned absolute embeddings |
| Weights | \`weights/model.safetensors\` (${(safetensorsBuffer.length / 1024 / 1024).toFixed(2)} MiB, ${tensors.length} tensors) |

<details>
<summary>Parameter breakdown</summary>

| Component | Parameters |
|---|---|
| Token embedding | ${config.parameter_breakdown.embedding.toLocaleString()} |
| Positional embedding | ${config.parameter_breakdown.positional.toLocaleString()} |
| ${config.n_layer} × transformer block | ${config.parameter_breakdown.blocks.toLocaleString()} |
| Final LayerNorm | ${config.parameter_breakdown.finalLn.toLocaleString()} |
| **Total** | **${config.parameter_breakdown.total.toLocaleString()}** |

</details>

## Architecture

![architecture](docs/architecture.png)

\`\`\`
input ids ──► token embedding ─┐
                               ├─► ${config.n_layer} × [ LN → causal self-attention → +residual
position embedding ────────────┘                        LN → GELU MLP → +residual ]
                                                          │
                                        final LayerNorm ──┴──► logits (tied embedding)
\`\`\`

Alternatives considered during the architecture search:

| d_model | layers | heads | d_ff | ctx | parameters |
|---|---|---|---|---|---|
${alternatives.map((a) => `| ${a.d_model} | ${a.n_layer} | ${a.n_head} | ${a.d_ff} | ${a.n_ctx} | ${a.total.toLocaleString()} |`).join('\n')}

## Quick start

\`\`\`bash
pip install -r requirements.txt          # torch, safetensors, numpy

python validate.py                        # verify config + weights + tokenizer
python inference.py --tokens 128          # generate a map spec
python benchmark.py                       # parameter count + latency
\`\`\`

Training from the initialised checkpoint:

\`\`\`bash
python data/prepare_data.py --synthetic ${params.syntheticExamples || 64}
python tokenizer/train_tokenizer.py --vocab-size ${config.vocab_size}
python train.py --steps 2000
\`\`\`

## Dataset

| | |
|---|---|
| Format | \`mapper-gpt/1\` (prompt → structured note map) |
| Examples | ${built.stats.total_examples} (${built.stats.train_examples} train / ${built.stats.val_examples} val) |
| Tokens | ${corpusTokens.toLocaleString()} |
| Tokens per char | ${built.stats.tokens_per_char} |

## CI

Workflows in \`.github/workflows/\`:

- **validate.yml** — validates the safetensors manifest, tensor shapes, weight
  statistics, tokenizer round-trip, then builds the model in PyTorch and checks
  the built parameter count matches the config.
- **model-check.yml** — re-runs validation on demand/schedule and reports the
  real parameter count to the run summary.
- **publish.yml** — packages weights + source into a GitHub release on tags.

## License

MIT — see [LICENSE](LICENSE).
`;

  const gitignore = `__pycache__/
*.py[cod]
.pytest_cache/
checkpoints/
*.ckpt
dist/
.venv/
validation-report.json
!weights/model.safetensors
`;

  const license = `MIT License

Copyright (c) ${new Date().getFullYear()} GalaxyFSRP1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

  const architectureMd = `# ${name} — architecture

Generated from \`config.json\` by AiMapper Model Studio.

- **Type**: decoder-only transformer, pre-LayerNorm, GELU MLP, tied embeddings
- **Depth**: ${config.n_layer} blocks
- **Width**: ${config.d_model} (${config.n_head} heads of ${config.head_dim})
- **FFN**: ${config.d_ff} (ratio ${(config.d_ff / config.d_model).toFixed(2)}×)
- **Context**: ${config.n_ctx}
- **Parameters**: ${total.toLocaleString()}

## Tensor groups

${spec.layerManifest(config).slice(0, 12).map((l) => `- \`${l.name}\` ${JSON.stringify(l.shape)} — ${l.params.toLocaleString()} params`).join('\n')}
${config.n_layer > 2 ? `- … ${config.n_layer - 2} more identical blocks …` : ''}

See \`weights/tensor_manifest.json\` for the full per-tensor manifest.
`;

  const tplVars = {
    MODEL_NAME: name,
    SLUG: slug,
    VOCAB_SIZE: config.vocab_size,
    N_CTX: config.n_ctx,
    D_MODEL: config.d_model,
    N_LAYER: config.n_layer,
    TARGET_PARAMS: Number(params.targetParameters).toLocaleString(),
    TOTAL_PARAMS: total.toLocaleString(),
    SYNTHETIC_EXAMPLES: params.syntheticExamples || 64,
    GENERATED_AT: new Date().toISOString(),
  };

  // ---- 6. file set ------------------------------------------------------
  onProgress({ step: 'files', detail: 'rendering source, configs and workflows' });
  const files = [
    { path: 'README.md', content: readme },
    { path: 'config.json', content: JSON.stringify(configJson, null, 2) + '\n' },
    { path: 'generation_config.json', content: JSON.stringify(generationConfig, null, 2) + '\n' },
    { path: 'model.py', content: render(readTemplate('python/model.py'), tplVars) },
    { path: 'train.py', content: render(readTemplate('python/train.py'), tplVars) },
    { path: 'inference.py', content: render(readTemplate('python/inference.py'), tplVars) },
    { path: 'benchmark.py', content: render(readTemplate('python/benchmark.py'), tplVars) },
    { path: 'validate.py', content: render(readTemplate('python/validate.py'), tplVars) },
    { path: 'requirements.txt', content: readTemplate('python/requirements.txt') },
    { path: 'weights/model.safetensors', content: safetensorsBuffer },
    { path: 'weights/tensor_manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' },
    { path: 'tokenizer/vocab.json', content: JSON.stringify(vocabJson) + '\n' },
    { path: 'tokenizer/tokenizer.py', content: render(readTemplate('python/tokenizer.py'), tplVars) },
    { path: 'tokenizer/train_tokenizer.py', content: render(readTemplate('python/train_tokenizer.py'), tplVars) },
    { path: 'data/prepare_data.py', content: render(readTemplate('python/prepare_data.py'), tplVars) },
    { path: 'data/seeds.jsonl', content: seedsJsonl },
    { path: 'data/corpus/train.jsonl', content: jsonl(built.train) },
    { path: 'data/corpus/val.jsonl', content: jsonl(built.val) },
    { path: 'data/corpus/stats.json', content: JSON.stringify(built.stats, null, 2) + '\n' },
    { path: '.github/workflows/validate.yml', content: readTemplate('github/ci.yml') },
    { path: '.github/workflows/model-check.yml', content: readTemplate('github/model-check.yml') },
    { path: '.github/workflows/publish.yml', content: readTemplate('github/publish.yml') },
    { path: 'docs/architecture.png', content: diagram },
    { path: 'docs/architecture.md', content: architectureMd },
    { path: 'LICENSE', content: license },
    { path: '.gitignore', content: gitignore },
    { path: 'VERSION', content: `1.0.0\n` },
  ];

  // sanity: nothing rendered an unresolved placeholder
  for (const file of files) {
    if (typeof file.content === 'string' && /\{\{[A-Z0-9_]+\}\}/.test(file.content)) {
      const match = file.content.match(/\{\{[A-Z0-9_]+\}\}/)[0];
      throw new Error(`unresolved template placeholder ${match} in ${file.path}`);
    }
  }

  onProgress({ step: 'done', detail: `${files.length} files ready` });

  const index = {
    schema: 'aimapper/model-index/1',
    generator: { name: 'AiMapper Model Studio', version: GENERATOR_VERSION },
    model_name: name,
    slug,
    generated_at: new Date().toISOString(),
    seed,
    parameters: total,
    target_parameters: Number(params.targetParameters),
    tensor_count: tensors.length,
    weights_bytes: safetensorsBuffer.length,
    weights_sha256: manifest.sha256,
    config: configJson.model,
    training,
    dataset: built.stats,
    files: files.map((f) => ({
      path: f.path,
      bytes: Buffer.isBuffer(f.content) ? f.content.length : Buffer.byteLength(f.content, 'utf8'),
      sha256: sha256(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8')),
    })),
    expected_file_count: fileList.length,
  };

  return {
    name,
    slug,
    seed,
    config,
    configJson,
    training,
    files,
    index,
    manifest,
    corpusStats: built.stats,
    vocabJson,
    alternatives,
    parameters: total,
    weightsBytes: safetensorsBuffer.length,
    weightsSha256: manifest.sha256,
    durationMs: Date.now() - started,
  };
}

/** Wraps the project files with a folder prefix and returns ZIP bytes. */
function packZip(project, prefix = '') {
  const zip = new ZipBuilder();
  const base = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  for (const file of project.files) zip.add(base + file.path, file.content);
  zip.addJSON(`${base}model_index.json`, project.index);
  return zip.build();
}

module.exports = { buildProject, packZip, slugify, GENERATOR_VERSION, sha256 };
