'use strict';
/* Packs the whole AiMapper workspace into dist/aimapper.zip using the same
   dependency-free zip writer the app uses.  node scripts/pack.js */

const fs = require('node:fs');
const path = require('node:path');
const { ZipBuilder } = require('../app/backend/lib/zip');
const { packZip, buildProject } = require('../app/backend/lib/project-builder');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', '.data', 'dist', 'node_modules', 'aimapper-inspect', '.arena', 'previews', '.cache', '.local', '.npm', '__pycache__', '.venv', '.config']);
const SKIP_EXT = /\.(zip|log)$/i;

function walk(dir, base = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, rel, out);
    else if (entry.isFile() && !SKIP_EXT.test(entry.name)) out.push({ rel, abs });
  }
  return out;
}

const files = walk(ROOT).filter((f) => f.rel !== 'dist/aimapper.zip');
const zip = new ZipBuilder();
const prefix = 'aimapper';
for (const file of files) zip.add(`${prefix}/${file.rel}`, fs.readFileSync(file.abs));

// include a ready-to-publish reference model so the ZIP is useful offline too
const project = buildProject({ name: 'mapper-5m', targetParameters: 5_000_000, vocabSize: 2048, syntheticExamples: 64 });
const modelZip = packZip(project, 'example-model/mapper-5m');
zip.add(`${prefix}/example-model/mapper-5m.zip`, modelZip);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'aimapper.zip');
fs.writeFileSync(out, zip.build());
const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
console.log(JSON.stringify({ zip: out, bytes: fs.statSync(out).size, mb: Number(mb), files: files.length + 1, exampleModel: { parameters: project.parameters, files: project.files.length } }, null, 2));
