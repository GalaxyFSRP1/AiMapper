'use strict';
/* Builds one model project into a directory (used by CI and by hand).

   node scripts/generate-artifact.js --out dist/model --params 5000000
*/
const fs = require('node:fs');
const path = require('node:path');
const { buildProject, packZip } = require('../app/backend/lib/project-builder');
const { validateProject } = require('../app/backend/lib/validator');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const out = path.resolve(arg('out', 'dist/model'));
const params = Number(arg('params', '5000000'));
const vocab = Number(arg('vocab', '2048'));
const synthetic = Number(arg('synthetic', '64'));

const project = buildProject({ name: arg('name', 'mapper-5m'), targetParameters: params, vocabSize: vocab, syntheticExamples: synthetic });
const report = validateProject(project);

for (const file of project.files) {
  const target = path.join(out, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.content);
}
fs.writeFileSync(path.join(out, 'model_index.json'), JSON.stringify(project.index, null, 2) + '\n');

const zipPath = path.join(out, '..', `${project.slug}.zip`);
fs.mkdirSync(path.dirname(zipPath), { recursive: true });
fs.writeFileSync(zipPath, packZip(project, project.slug));

console.log(JSON.stringify({
  model: project.name,
  parameters: project.parameters,
  target: params,
  deviation_pct: project.config.deviation,
  tensors: project.manifest.tensor_count,
  weights_bytes: project.weightsBytes,
  weights_sha256: project.weightsSha256,
  vocab_size: project.config.vocab_size,
  merges: project.vocabJson.merges.length,
  files: project.files.length,
  validation: { status: report.status, passed: report.passed, total: report.total },
  output: out,
  zip: zipPath,
}, null, 2));

if (report.status !== 'pass') {
  console.error('validation failures:', report.failures);
  process.exit(1);
}
