'use strict';
/* End-to-end pipeline test: build a project, validate it, write it to disk and
   re-read the artifacts byte-for-byte. Run: node tests/pipeline.test.js */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');

const { buildProject, packZip } = require('../app/backend/lib/project-builder');
const { validateProject } = require('../app/backend/lib/validator');
const { readZip } = require('../app/backend/lib/zip');
const spec = require('../app/backend/lib/model-spec');

const results = [];
function test(name, fn) {
  const t0 = Date.now();
  try {
    fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('\nAiMapper Model Studio — pipeline tests\n');

// ---------------------------------------------------------------- architecture
test('parameter search lands within 2% of 5,000,000', () => {
  const { config } = spec.searchArchitecture(5_000_000, 2048);
  assert.strictEqual(config.achieved_parameters, config.parameter_breakdown.total);
  const dev = Math.abs(config.achieved_parameters - 5_000_000) / 5_000_000;
  assert.ok(dev <= 0.02, `deviation ${(dev * 100).toFixed(3)}% too large`);
  assert.strictEqual(config.d_model % config.n_head, 0);
});

test('analytic counter agrees with layer manifest', () => {
  const { config } = spec.searchArchitecture(5_000_000, 2048);
  const manifestTotal = spec.layerManifest(config).reduce((n, l) => n + l.params, 0);
  assert.strictEqual(manifestTotal, config.parameter_breakdown.total);
});

test('search respects an explicit context size', () => {
  const { config } = spec.searchArchitecture(5_000_000, 2048, { nCtx: 128 });
  assert.strictEqual(config.n_ctx, 128);
});

test('rejects impossible parameter targets', () => {
  assert.throws(() => spec.searchArchitecture(10, 2048));
  assert.throws(() => spec.searchArchitecture(10_000_000_000, 2048));
});

// ---------------------------------------------------------------- weights
test('weights are deterministic for a fixed seed', () => {
  const { config } = spec.searchArchitecture(5_000_000, 2048);
  const a = spec.initialiseWeights(config, 'seed-a');
  const b = spec.initialiseWeights(config, 'seed-a');
  const c = spec.initialiseWeights(config, 'seed-b');
  assert.strictEqual(a.total, b.total);
  const pick = (tensors) => tensors.find((t) => t.name === 'model.tok_emb.weight').data;
  const firstA = pick(a.tensors);
  const firstB = pick(b.tensors);
  const firstC = pick(c.tensors);
  assert.deepStrictEqual(Array.from(firstA.slice(0, 8)), Array.from(firstB.slice(0, 8)));
  assert.notDeepStrictEqual(Array.from(firstA.slice(0, 8)), Array.from(firstC.slice(0, 8)));
});

test('safetensors round-trips every tensor', () => {
  const { config } = spec.searchArchitecture(5_000_000, 2048);
  const { tensors, total } = spec.initialiseWeights(config, 'roundtrip');
  const buf = spec.writeSafetensors(tensors, { hi: 'there' });
  const parsed = spec.readSafetensors(buf);
  assert.strictEqual(parsed.tensors.size, tensors.length);
  assert.strictEqual(parsed.metadata.hi, 'there');
  let seen = 0;
  for (const t of tensors) {
    const got = parsed.tensors.get(t.name);
    assert.ok(got, `missing ${t.name}`);
    assert.deepStrictEqual(got.shape, Array.from(t.shape), `shape mismatch ${t.name}`);
    seen += got.data.length / 4;
  }
  assert.strictEqual(seen, total);
});

// ---------------------------------------------------------------- full project
console.log('\n  building a 5,000,000-parameter project (this is the real thing)…');
const t0 = Date.now();
const project = buildProject({ name: 'mapper-5m', targetParameters: 5_000_000, vocabSize: 2048, syntheticExamples: 48 });
console.log(`  built ${project.files.length} files in ${Date.now() - t0}ms — ${project.parameters.toLocaleString()} parameters\n`);

test('project hits the target parameter budget', () => {
  assert.ok(Math.abs(project.parameters - 5_000_000) / 5_000_000 <= 0.02);
  assert.strictEqual(project.parameters, project.config.parameter_breakdown.total);
});

test('validation suite passes', () => {
  const report = validateProject(project);
  if (report.status !== 'pass') {
    throw new Error(`validation failed: ${report.failures.join(' | ')}`);
  }
  assert.ok(report.total >= 20, `expected >= 20 checks, got ${report.total}`);
});

test('weight bytes are real float32 tensors with sane statistics', () => {
  const file = project.files.find((f) => f.path === 'weights/model.safetensors');
  assert.ok(file && Buffer.isBuffer(file.content));
  const parsed = spec.readSafetensors(file.content);
  const emb = parsed.tensors.get('model.tok_emb.weight');
  const values = new Float32Array(emb.data.buffer, emb.data.byteOffset, emb.data.length / 4);
  let sum = 0;
  let sumSq = 0;
  for (const v of values) { sum += v; sumSq += v * v; }
  const mean = sum / values.length;
  const sd = Math.sqrt(sumSq / values.length - mean * mean);
  assert.ok(Math.abs(mean) < 0.005, `embedding mean ${mean} too far from zero`);
  assert.ok(sd > 0.015 && sd < 0.025, `embedding std ${sd} not ~0.02`);
});

test('tokenizer is trained and lossless', () => {
  const vocab = JSON.parse(project.files.find((f) => f.path === 'tokenizer/vocab.json').content);
  assert.strictEqual(vocab.vocab_size, project.config.vocab_size);
  assert.ok(vocab.merges.length > 500, `only ${vocab.merges.length} merges learned`);
  const stats = project.corpusStats;
  assert.ok(stats.roundtrip_verified, 'round trip not verified');
  assert.ok(stats.tokens > 0);
});

test('every generated python file compiles under py_compile', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimapper-py-'));
  const pyFiles = project.files.filter((f) => f.path.endsWith('.py'));
  assert.ok(pyFiles.length >= 6, `only ${pyFiles.length} python files`);
  for (const file of pyFiles) {
    const target = path.join(dir, file.path.replace(/\//g, '__'));
    fs.writeFileSync(target, file.content);
    execFileSync('python3', ['-m', 'py_compile', target], { stdio: 'pipe' });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('generated JSON/YAML artifacts are well formed', () => {
  for (const file of project.files.filter((f) => f.path.endsWith('.json'))) {
    JSON.parse(file.content);
  }
  const workflow = project.files.find((f) => f.path === '.github/workflows/validate.yml').content;
  assert.ok(/^name:/m.test(workflow) && /runs-on: ubuntu-latest/.test(workflow));
  assert.ok(!/\t/.test(workflow), 'YAML files must not contain tabs');
});

test('zip archive contains every file and extracts cleanly', () => {
  const zip = packZip(project, project.slug);
  const entries = readZip(zip);
  assert.strictEqual(entries.size, project.files.length + 1, 'expected files + model_index.json');
  for (const file of project.files) {
    const key = `${project.slug}/${file.path}`;
    assert.ok(entries.has(key), `zip missing ${key}`);
    const stored = entries.get(key);
    const original = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    assert.strictEqual(stored.length, original.length, `length mismatch for ${key}`);
    assert.ok(stored.equals(original), `content mismatch for ${key}`);
  }
  assert.ok(entries.has(`${project.slug}/model_index.json`));
});

test('model_index matches the actual file set', () => {
  const index = project.index;
  assert.strictEqual(index.files.length, project.files.length);
  assert.strictEqual(index.parameters, project.parameters);
  assert.strictEqual(index.weights_sha256, project.weightsSha256);
});

test('generated config parses the way the Python loader expects', () => {
  const cfg = JSON.parse(project.files.find((f) => f.path === 'config.json').content);
  assert.strictEqual(cfg.model.vocab_size, project.config.vocab_size);
  assert.strictEqual(cfg.model.n_layer, project.config.n_layer);
  assert.strictEqual(cfg.training.seq_len, project.config.n_ctx);
  assert.strictEqual(typeof cfg.model.tie_word_embeddings, 'boolean');
});

// ---------------------------------------------------------------- python validation
console.log('\n  running the generated validate.py on the generated files…');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimapper-validate-'));
for (const file of project.files) {
  const target = path.join(workDir, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.content);
}
let pythonReport = null;
test('generated validate.py reports pass on its own artifacts', () => {
  const { execFileSync } = require('node:child_process');
  let out = '';
  try {
    out = execFileSync('python3', ['validate.py', '--strict-target', '0.02'], {
      cwd: workDir,
      stdio: 'pipe',
      timeout: 180_000,
    }).toString();
  } catch (err) {
    out = (err.stdout || Buffer.from('')).toString() + (err.stderr || Buffer.from('')).toString();
    throw new Error(`validate.py exited non-zero:\n${out.slice(-2000)}`);
  }
  pythonReport = JSON.parse(fs.readFileSync(path.join(workDir, 'validation-report.json'), 'utf8'));
  assert.strictEqual(pythonReport.status, 'pass', JSON.stringify(pythonReport.failures));
  assert.strictEqual(pythonReport.weights.tensor_elements, project.parameters);
});

if (pythonReport && typeof pythonReport.torch_built_parameters === 'number') {
  test('torch-built model parameter count matches', () => {
    assert.strictEqual(pythonReport.torch_built_parameters, project.parameters);
  });
} else {
  console.log('  skip torch build check (torch not installed in this environment)');
}

fs.rmSync(workDir, { recursive: true, force: true });

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
console.log(`model: ${project.parameters.toLocaleString()} parameters, ${project.manifest.tensorCount} tensors, ` +
  `${(project.weightsBytes / 1024 / 1024).toFixed(2)} MiB weights, ${project.files.length} files\n`);
if (failed.length) {
  console.error('FAILURES:');
  for (const f of failed) console.error(` - ${f.name}: ${f.error.message}`);
  process.exit(1);
}
