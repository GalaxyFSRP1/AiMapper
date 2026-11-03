'use strict';
/* Exercises the real GitHub publishing code path against a mock API:
   repo creation -> blob upload -> single atomic commit -> ref update ->
   ledger update -> Actions dispatch.

   Run: node tests/github.test.js [--live OWNER/REPO]
   With --live and a GITHUB_TOKEN env var it runs against the real GitHub API
   (creates a scratch repo you must delete afterwards). */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startMock } = require('./github-mock');

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, true]); console.log(`  ok   ${name}`); }
  catch (err) { results.push([name, false, err.message]); console.error(`  FAIL ${name}: ${err.message}`); }
}

(async () => {
  const live = process.argv.includes('--live');
  const mock = live ? null : await startMock();
  const apiBase = live ? 'https://api.github.com' : mock.base;
  const token = live ? process.env.GITHUB_TOKEN : mock.store.token;
  if (live && !token) {
    console.error('--live requires GITHUB_TOKEN');
    process.exit(2);
  }

  const PORT = 8600 + Math.floor(Math.random() * 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aimapper-gh-'));
  const server = spawn('node', [path.join(__dirname, '..', 'app', 'backend', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MAPPER_DATA_DIR: DATA_DIR,
      MAPPER_ACCESS_LOG: '0',
      GITHUB_API_BASE: apiBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(d.toString()));
  server.stderr.on('data', (d) => log.push(d.toString()));

  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  let cookie = '';
  async function call(method, url, body, expect = 200) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    if (expect !== null) assert.strictEqual(res.status, expect, `${method} ${url} -> ${res.status}: ${text.slice(0, 400)}`);
    return data;
  }

  try {
    console.log(`\nGITHUB PUBLISHING ${live ? '(LIVE)' : '(mock API)'}\n`);

    const connect = await call('POST', '/api/auth/token', { token });
    check('token auth connects and stores identity', () => assert.strictEqual(connect.user.login, live ? connect.user.login : 'test-user'));

    const status = await call('GET', '/api/status');
    check('status reports connected without leaking the token', () => {
      assert.ok(status.user.connected);
      assert.ok(!JSON.stringify(status).includes(token), 'token leaked to the client');
    });

    const estimate = await call('POST', '/api/parameters/estimate', { targetParameters: 5000000, vocabSize: 2048 });
    check('estimate before publish', () => assert.ok(estimate.config.achieved_parameters > 4_900_000));

    const repoName = live ? `aimapper-live-test-${Date.now()}` : 'AiMapper';
    const job = await call('POST', '/api/generate', {
      name: live ? 'live-test-model' : 'gh-test-model',
      targetParameters: 5000000,
      vocabSize: 2048,
      syntheticExamples: 16,
      owner: live ? undefined : 'test-user',
      repo: repoName,
      basePath: live ? 'models' : 'models',
      publish: true,
    }, 202);
    check('publish job accepted', () => assert.ok(job.jobId));

    let final = null;
    for (let i = 0; i < 300; i++) {
      const poll = await call('GET', `/api/jobs/${job.jobId}`);
      if (poll.status === 'success' || poll.status === 'error') { final = poll; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    check('job completed', () => {
      assert.ok(final, 'job never finished');
      assert.strictEqual(final.status, 'success', final.error?.message || '');
    });

    const gh = final.result?.github;
    check('result links to a commit', () => {
      assert.ok(gh, 'no github summary');
      assert.ok(/^[a-f0-9]{40}$/.test(gh.commitSha), `bad sha ${gh.commitSha}`);
      assert.ok(gh.commitUrl.includes(gh.commitSha));
      assert.strictEqual(gh.path, `models/${final.result.slug}`);
    });

    check('all project files were committed', () => {
      assert.ok(gh.files >= 27, `only ${gh.files} files committed`);
    });

    if (!live) {
      const store = mock.store;
      check('repository was created on the account', () => assert.ok(store.repos.has(`test-user/${repoName}`)));

      check('exactly one atomic commit was created for the upload', () => {
        const uploadCommits = [...store.commits.values()].filter((c) => c.message.includes('feat(model)'));
        assert.strictEqual(uploadCommits.length, 1, `expected 1 upload commit, got ${uploadCommits.length}`);
        // repo was created empty, so the very first commit legitimately has no parent
        assert.strictEqual(uploadCommits[0].parents.length, 0, 'first commit in an empty repo should have no parent');
      });

      check('commit message records the parameter count', () => {
        const commit = [...store.commits.values()].find((c) => c.message.includes('feat(model)'));
        assert.ok(commit.message.includes(final.result.parameters.toLocaleString()), commit.message);
      });

      check('branch head holds the latest commit (upload + ledger)', () => {
        const head = store.refs.get('main');
        assert.ok(head, 'branch main was not created');
        const ledger = [...store.commits.values()].find((c) => c.message.startsWith('docs(models)'));
        assert.ok(ledger, 'no ledger commit');
        assert.strictEqual(head, ledger.sha, 'head should be the newest commit');
        assert.strictEqual(ledger.parents[0].sha, gh.commitSha, 'ledger commit should sit on top of the upload commit');
      });

      check('weights blob equals the generated bytes', () => {
        const tree = store.trees.get([...store.commits.values()].find((c) => c.message.includes('feat(model)')).tree.sha);
        const entry = tree.find((e) => e.path.endsWith('weights/model.safetensors'));
        assert.ok(entry, 'weights entry missing from tree');
        const { readZip } = require('../app/backend/lib/zip');
        const st = require('../app/backend/lib/model-spec');
        const raw = Buffer.from(store.blobs.get(entry.sha), 'base64');
        const parsed = st.readSafetensors(raw);
        let total = 0;
        for (const [, t] of parsed.tensors) total += t.shape.reduce((a, b) => a * b, 1);
        assert.strictEqual(total, final.result.parameters, 'weights in the commit are not the generated tensors');
        void readZip;
      });

      check('Actions workflows were dispatched with the expected inputs', () => {
        assert.ok(mock.store.dispatches.length >= 2, `only ${mock.store.dispatches.length} dispatched`);
        const modelCheck = mock.store.dispatches.find((d) => d.file === 'model-check.yml');
        assert.ok(modelCheck, 'model-check.yml not dispatched');
        assert.strictEqual(modelCheck.inputs.expected_parameters, String(final.result.parameters));
      });

      check('workflow run was reported back', () => {
        assert.ok(final.result.actions.run, 'no run reported');
        assert.ok(final.result.actions.run.url.includes('/actions/runs/'));
      });

      check('model ledger README was written', () => {
        const ledger = store.blobs.get
          ? [...store.blobs.values()].map((b64) => Buffer.from(b64, 'base64').toString('utf8'))
          : [];
        const hasLedger = ledger.some((text) => text.includes('# Generated models') && text.includes(final.result.name));
        assert.ok(hasLedger, 'ledger README not committed');
      });
    }

    if (!live) {
      // ---- second run into a repository that now has history ----
      const job2 = await call('POST', '/api/generate', {
        name: 'gh-test-model-2',
        targetParameters: 5000000,
        vocabSize: 2048,
        syntheticExamples: 16,
        owner: 'test-user',
        repo: repoName,
        basePath: 'models',
        publish: true,
      }, 202);
      let final2 = null;
      for (let i = 0; i < 300; i++) {
        const poll = await call('GET', `/api/jobs/${job2.jobId}`);
        if (poll.status === 'success' || poll.status === 'error') { final2 = poll; break; }
        await new Promise((r) => setTimeout(r, 400));
      }
      check('second generation publishes into the existing repo', () => {
        assert.ok(final2 && final2.status === 'success', final2?.error?.message || 'did not finish');
        assert.strictEqual(final2.result.github.createdRepo, false);
        assert.strictEqual(final2.result.github.repo, `test-user/${repoName}`);
      });
      check('incremental commit chains onto the previous head', () => {
        const uploads = [...mock.store.commits.values()].filter((c) => c.message.includes('feat(model)'));
        assert.strictEqual(uploads.length, 2, `expected 2 upload commits, got ${uploads.length}`);
        const second = uploads.find((c) => c.message.includes('gh-test-model-2'));
        assert.ok(second, 'second upload commit missing');
        assert.strictEqual(second.parents.length, 1, 'incremental commit must have a parent');
      });
      check('both models coexist under models/', () => {
        const paths = [...mock.store.trees.values()].flat().map((e) => e.path);
        assert.ok(paths.some((p) => p.startsWith('models/gh-test-model/')), 'first model missing');
        assert.ok(paths.some((p) => p.startsWith('models/gh-test-model-2/')), 'second model missing');
      });
      check('ledger lists both models', () => {
        const bodies = [...mock.store.blobs.values()].map((b64) => Buffer.from(b64, 'base64').toString('utf8'));
        const ledger = bodies.filter((t) => t.includes('# Generated models')).sort((a, b) => b.length - a.length)[0];
        assert.ok(ledger, 'no ledger found');
        assert.ok(ledger.includes('[gh-test-model-2]'), 'second model missing from ledger');
      });
    }

    // ---- error handling: bad token ----
    const freshPeer = await fetch(`${BASE}/api/status`, { headers: {} });
    check('second client is unauthenticated', async () => assert.strictEqual((await freshPeer.json()).authenticated, false));
  } finally {
    server.kill('SIGTERM');
    if (mock) mock.server.close();
    await new Promise((r) => setTimeout(r, 400));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} GitHub tests passed\n`);
  if (failed.length) {
    console.error(log.join('').split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
})();
