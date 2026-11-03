'use strict';
/* Trains the generated model for a few steps and asserts the loss is finite
   and decreasing. Proves the generated training loop really optimises.

   Needs python3 + torch.  node tests/train.test.js */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildProject } = require('../app/backend/lib/project-builder');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimapper-train-'));
const project = buildProject({ name: 'train-test', targetParameters: 5_000_000, vocabSize: 2048, syntheticExamples: 24 });

for (const file of project.files) {
  const target = path.join(dir, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.content);
}

console.log('\ntraining the generated model for 12 steps (real optimiser, real data)…\n');

execFileSync('python3', ['data/prepare_data.py', '--synthetic', '24'], { cwd: dir, stdio: 'pipe' });
execFileSync('python3', ['train.py', '--steps', '12', '--batch-size', '4'], { cwd: dir, stdio: 'pipe', timeout: 900000 });

const summary = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoints', 'train_summary.json'), 'utf8'));
const history = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoints', 'history.json'), 'utf8'));
const losses = history.filter((h) => typeof h.loss === 'number').map((h) => h.loss);

assert.strictEqual(summary.steps, 12, 'training did not run the expected number of steps');
assert.strictEqual(summary.trainable_parameters, project.parameters, 'parameter count drifted during training');
assert.ok(losses.length >= 2, 'no loss history recorded');
assert.ok(losses.every((l) => Number.isFinite(l) && l > 0), `non-finite loss: ${losses}`);
assert.ok(losses[losses.length - 1] < losses[0], `loss did not decrease (${losses[0]} -> ${losses[losses.length - 1]})`);
assert.ok(fs.existsSync(path.join(dir, 'checkpoints', 'model.safetensors')), 'no checkpoint written');

console.log(`  ok   trained ${summary.steps} steps, ${summary.trainable_parameters.toLocaleString()} params`);
console.log(`  ok   loss ${losses[0].toFixed(4)} -> ${losses[losses.length - 1].toFixed(4)}`);
console.log(`  ok   checkpoint written (${(fs.statSync(path.join(dir, 'checkpoints', 'model.safetensors')).size / 1024 / 1024).toFixed(1)} MiB)\n`);

fs.rmSync(dir, { recursive: true, force: true });
