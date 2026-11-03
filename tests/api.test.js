'use strict';
/* API + end-to-end job test. Boots the real server on an ephemeral port,
   creates a sandbox session, runs a local-only generation, streams logs,
   downloads the ZIP and checks the bytes. Run: node tests/api.test.js */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8123 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aimapper-data-'));

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, true]); console.log(`  ok   ${name}`); }
  catch (err) { results.push([name, false, err.message]); console.error(`  FAIL ${name}: ${err.message}`); }
}

let cookie = '';

async function call(method, url, body, expect = 200) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (expect !== null) assert.strictEqual(res.status, expect, `${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, data, headers: res.headers };
}

(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'app', 'backend', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MAPPER_DATA_DIR: DATA_DIR, MAPPER_ACCESS_LOG: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));

  // wait for boot
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  try {
    console.log('\nAiMapper Model Studio — API tests\n');

    const health = await call('GET', '/api/health');
    check('health endpoint responds', () => assert.strictEqual(health.data.ok, true));

    const config = await call('GET', '/api/config');
    check('config exposes no secrets', () => {
      const flat = JSON.stringify(config.data);
      assert.ok(!/client_secret|ghp_|github_pat_/i.test(flat), 'secret leaked in /api/config');
      assert.strictEqual(config.data.defaults.targetParameters, 5000000);
    });

    const unauth = await call('GET', '/api/status');
    check('status is usable before auth', () => assert.strictEqual(unauth.data.authenticated, false));

    const estimate = await call('POST', '/api/parameters/estimate', { targetParameters: 5000000, vocabSize: 2048 });
    check('parameter estimate is exact', () => {
      const c = estimate.data.config;
      assert.strictEqual(c.achieved_parameters, c.parameter_breakdown.total);
      assert.ok(Math.abs(c.achieved_parameters - 5000000) / 5000000 < 0.02);
      assert.ok(estimate.data.layerCount > 0);
    });

    const badEstimate = await call('POST', '/api/parameters/estimate', { targetParameters: 5 }, 400);
    check('invalid target rejected', () => assert.ok(badEstimate.data.error));

    const noSession = await call('POST', '/api/generate', { name: 'x' }, 401);
    check('generation requires a session', () => assert.ok(/session/i.test(noSession.data.error)));

    const session = await call('POST', '/api/session');
    check('sandbox session created', () => assert.strictEqual(session.data.ok, true));

    const status = await call('GET', '/api/status');
    check('session is authenticated', () => assert.strictEqual(status.data.authenticated, true));

    // publish:false -> local only
    const job = await call('POST', '/api/generate', {
      name: 'api-test-5m',
      targetParameters: 5000000,
      vocabSize: 2048,
      syntheticExamples: 24,
      publish: false,
    }, 202);
    check('job accepted', () => assert.ok(job.data.jobId.startsWith('job_')));

    const jobId = job.data.jobId;
    let final = null;
    let sawLogs = false;
    for (let i = 0; i < 240; i++) {
      const poll = await call('GET', `/api/jobs/${jobId}`);
      const logs = await call('GET', `/api/jobs/${jobId}/logs?since=0`);
      if (logs.data.lines?.length) sawLogs = true;
      if (poll.data.status === 'success' || poll.data.status === 'error') { final = poll.data; break; }
      await new Promise((r) => setTimeout(r, 400));
    }

    check('job completes successfully', () => {
      assert.ok(final, 'job never finished');
      assert.strictEqual(final.status, 'success', final.error ? final.error.message : 'unknown');
    });
    check('job streamed real logs', () => assert.ok(sawLogs, 'no log lines were produced'));
    check('job reports real parameter count', () => {
      const p = final.result.parameters;
      assert.ok(Math.abs(p - 5000000) / 5000000 < 0.02, `parameters ${p} outside 2% of target`);
      assert.strictEqual(p, final.result.validation.parameters);
    });
    check('validation passed every check', () => {
      assert.strictEqual(final.result.validation.status, 'pass', JSON.stringify(final.result.validation.failures));
      assert.ok(final.result.validation.total >= 20);
    });
    check('progress reached 100%', () => assert.strictEqual(final.progress, 100));

    // artifact download
    const zipRes = await fetch(`${BASE}/api/jobs/${jobId}/artifact`, { headers: { Cookie: cookie } });
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    check('ZIP artifact downloads and is a valid archive', () => {
      assert.strictEqual(zipRes.status, 200);
      assert.ok(zipBuf.length > 1_000_000, `zip only ${zipBuf.length} bytes`);
      assert.strictEqual(zipBuf.slice(0, 2).toString(), 'PK');
      const { readZip } = require('../app/backend/lib/zip');
      const entries = readZip(zipBuf);
      assert.ok(entries.has('api-test-5m/weights/model.safetensors'));
      assert.ok(entries.has('api-test-5m/config.json'));
      assert.ok(entries.has('api-test-5m/.github/workflows/validate.yml'));
      // the weights in the zip must be the real tensors
      const w = entries.get('api-test-5m/weights/model.safetensors');
      const headerLen = Number(w.readBigUInt64LE(0));
      const header = JSON.parse(w.slice(8, 8 + headerLen).toString());
      const manifest = JSON.parse(entries.get('api-test-5m/weights/tensor_manifest.json').toString());
      assert.strictEqual(manifest.total_parameters, final.result.parameters);
      assert.strictEqual(Object.keys(header).filter((k) => k !== '__metadata__').length, manifest.tensor_count);
    });

    // cross-session access must be denied
    const stolen = await fetch(`${BASE}/api/jobs/${jobId}`, { headers: {} });
    check('another client cannot read the job', () => assert.strictEqual(stolen.status, 403));

    // history + monitoring
    const history = await call('GET', '/api/history');
    check('history records the generation', () => {
      assert.ok(history.data.history.length >= 1);
      assert.strictEqual(history.data.history[0].status, 'success');
    });

    const mon = await call('GET', '/api/monitoring');
    check('monitoring reports job stats', () => {
      assert.ok(mon.data.jobs.total >= 1);
      assert.ok(mon.data.parameters.totalGenerated >= 5000000);
    });

    // static assets
    for (const [label, url] of [['studio page', '/studio'], ['studio css', '/studio.css'], ['studio js', '/studio.js'], ['beatforge', '/']]) {
      const res = await fetch(BASE + url);
      check(`${label} is served`, () => assert.strictEqual(res.status, 200));
    }

    const notFound = await fetch(`${BASE}/nope.js`);
    check('unknown paths 404', () => assert.strictEqual(notFound.status, 404));

    for (const probe of ['/..%2F..%2Fpackage.json', '/%2e%2e/%2e%2e/package.json', '/package.json', '/app/backend/server.js', '/tests/api.test.js']) {
      const res = await fetch(BASE + probe);
      check(`not web-accessible: ${probe}`, () => assert.ok([400, 403, 404].includes(res.status), `got ${res.status}`));
    }
    const traversal = await fetch(`${BASE}/..%2F..%2Fpackage.json`);
    check('path traversal blocked', () => assert.ok([400, 403, 404].includes(traversal.status)));

    const dataLeak = await fetch(`${BASE}/.data/store.json`);
    check('data directory is not web-accessible', () => assert.ok([403, 404].includes(dataLeak.status)));

    const badMethod = await fetch(`${BASE}/api/health`, { method: 'POST' });
    check('wrong method rejected', () => assert.ok([403, 405].includes(badMethod.status)));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} API tests passed\n`);
  if (failed.length) {
    console.error('server log tail:\n' + serverLog.join('').split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
})();
