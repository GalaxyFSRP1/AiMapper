'use strict';
/* Runs every test suite in order. `npm run verify`

   Suites:
     tests/pipeline.test.js  generation + validation + zip (needs python3)
     tests/api.test.js       HTTP API + background jobs + artifact download
     tests/github.test.js    publishing against a mock GitHub API
     tests/ui.test.js        front-end: boots the real studio.js against the real server
     tests/publish-ui.test.js full publish flow through the browser against a mock GitHub
     tests/train.test.js     optional, runs when torch is installed

   Flags:
     --zip     also builds the deliverable zip into dist/aimapper.zip
     --quick   skip the slower suites (train)
*/
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const suites = [
  ['pipeline', 'tests/pipeline.test.js'],
  ['api', 'tests/api.test.js'],
  ['github', 'tests/github.test.js'],
  ['ui', 'tests/ui.test.js'],
  ['publish-ui', 'tests/publish-ui.test.js'],
];

let failed = 0;
const report = [];

function hasPython() {
  const probe = spawnSync('python3', ['--version'], { stdio: 'pipe' });
  return probe.status === 0;
}

function hasTorch() {
  const probe = spawnSync('python3', ['-c', 'import torch'], { stdio: 'pipe' });
  return probe.status === 0;
}

console.log('\n=== AiMapper verification ===\n');

for (const [name, file] of suites) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', file)], { stdio: 'inherit' });
  const ok = res.status === 0;
  if (!ok) failed++;
  report.push({ suite: name, status: ok ? 'pass' : 'fail', ms: Date.now() - started });
}

if (hasPython() && hasTorch() && process.env.SKIP_TRAIN !== '1') {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'tests', 'train.test.js')], { stdio: 'inherit' });
  const ok = res.status === 0;
  if (!ok) failed++;
  report.push({ suite: 'train', status: ok ? 'pass' : 'fail', ms: Date.now() - started });
} else {
  console.log('\n  skip train suite (python3 + torch not available)\n');
}

// zip the workspace deliverable when asked
if (process.argv.includes('--zip')) {
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pack.js')], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/verify-report.json', JSON.stringify({ at: new Date().toISOString(), suites: report, failed }, null, 2) + '\n');

console.log('\n=== summary ===');
for (const r of report) console.log(` ${r.status === 'pass' ? 'PASS' : 'FAIL'}  ${r.suite.padEnd(10)} ${(r.ms / 1000).toFixed(1)}s`);
console.log(failed ? `\n${failed} suite(s) failed\n` : '\nall suites passed\n');
process.exit(failed ? 1 : 0);
