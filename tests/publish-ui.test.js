'use strict';
/* End-to-end publish test through the *front end*.
 *
 * Boots a mock GitHub REST API and the real server pointed at it, then drives
 * the real app/web/studio.js exactly as a user would: connect with a token,
 * load repos, verify access, generate a model with "publish" ticked, and read
 * back the commit / Actions links that appear on screen.  This is the closest
 * we can get to the real GitHub round-trip without credentials, and it covers
 * the wiring between the browser, the API and the publisher.
 *
 *   node tests/publish-ui.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { startMock } = require('./github-mock');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------------ DOM shim
// (kept in step with tests/ui.test.js — the shim only implements the DOM
// surface studio.js actually touches)
class El {
  constructor(tag = 'div', id = '', cls = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = cls;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.listeners = {};
    this.attrs = {};
    this.parentElement = null;
    this.scrollTop = 0;
    this.clientHeight = 200;
    this.scrollHeight = 200;
    this.classList = {
      add: (...c) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...c])].join(' '); },
      remove: (...c) => { this.className = this.className.split(' ').filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => this.className.split(' ').includes(c),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerText() { return this._text; }
  set innerText(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  insertAdjacentElement(_p, c) { c.parentElement = this; this.children.push(c); return c; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  dispatch(ev, arg = {}) { for (const fn of this.listeners[ev] || []) fn({ target: this, preventDefault() {}, key: '', ...arg }); }
  querySelector(sel) { return document.querySelector(sel); }
  querySelectorAll(sel) { return document.querySelectorAll(sel); }
  getContext() {
    const noop = () => {};
    return {
      clearRect: noop, beginPath: noop, arc: noop, fill: noop, fillRect: noop, moveTo: noop,
      lineTo: noop, stroke: noop, roundRect: noop, rect: noop, fillText: noop, closePath: noop,
      measureText: () => ({ width: 24 }), set fillStyle(_v) {}, set strokeStyle(_v) {},
      set lineWidth(_v) {}, set font(_v) {}, set textAlign(_v) {}, set globalAlpha(_v) {},
      createLinearGradient: () => ({ addColorStop: noop }),
    };
  }
  getBoundingClientRect() { return { top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400 }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  remove() {}
  click() { this.dispatch('click'); }
  focus() {}
}

const IDS = [
  'bg', 'ver', 'in-repo', 'in-basepath', 'in-name', 'in-target', 'in-vocab', 'in-synthetic',
  'in-publish', 'in-private', 'in-actions', 'btn-generate', 'btn-estimate', 'btn-cancel',
  'gen-hint', 'gen-sub', 'target-hint', 'progress-block', 'progress-step', 'progress-pct',
  'progress-fill', 'steps', 'result-block', 'counter-value', 'counter-grid', 'arch-grid',
  'arch-canvas', 'arch-alternatives', 'auth-chip', 'connect-box', 'account-box', 'acct-login',
  'acct-method', 'acct-avatar', 'btn-oauth', 'btn-sandbox', 'btn-token', 'in-token', 'btn-logout',
  'btn-repos', 'btn-verify', 'repo-list', 'verify-out', 't-batch', 't-lr', 't-steps', 't-wd',
  't-clip', 't-warm', 't-opt', 't-sched', 'training-preview', 'val-sub', 'val-body', 'log-follow',
  'btn-copy-log', 'log-body', 'versions-body', 'mon-stats', 'mon-errors', 'mon-logs', 'health',
  'panel-generator', 'panel-counter', 'panel-architecture', 'panel-github', 'panel-training',
  'panel-validation', 'panel-logs', 'panel-versions', 'panel-monitoring',
];

function makeDom() {
  const els = new Map();
  const root = new El('main', 'app-root');
  for (const id of IDS) {
    const el = new El('div', id);
    el.parentElement = root;
    root.appendChild(el);
    els.set(`#${id}`, el);
  }
  const set = (sel, v) => { if (els.has(sel)) els.get(sel).value = v; };
  set('#in-target', '5000000');
  set('#in-vocab', '2048');
  set('#in-synthetic', '16');
  set('#in-name', 'publish-e2e');
  set('#in-basepath', 'models');
  set('#t-batch', '16'); set('#t-lr', '0.0003'); set('#t-steps', '2000'); set('#t-wd', '0.1');
  set('#t-clip', '1'); set('#t-warm', '0.03'); set('#t-opt', 'adamw'); set('#t-sched', 'cosine');
  els.get('#in-publish').checked = true;
  els.get('#in-actions').checked = true;
  els.get('#log-follow').checked = true;

  const tabs = ['generator', 'architecture', 'github', 'training', 'validation', 'logs', 'versions', 'monitoring']
    .map((n) => { const t = new El('button', '', 'tab'); t.dataset.panel = n; return t; });
  let boot = null;
  const created = [];

  const document = {
    querySelector(sel) {
      if (els.has(sel)) return els.get(sel);
      if (sel === '.token-box') return els.get('#in-token');
      if (sel.startsWith('#')) return created.find((c) => `#${c.id}` === sel) || null;
      if (sel.startsWith('.')) return created.find((c) => c.classList.contains(sel.slice(1))) || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.tab') return tabs;
      return [];
    },
    createElement(tag) { const el = new El(tag); created.push(el); return el; },
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') boot = fn; },
    body: new El('body'),
    documentElement: new El('html'),
  };
  return { document, els, created, tabs, boot: () => boot() };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(base) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) return resolve(await res.json());
      } catch (_) { /* keep waiting */ }
      if (Date.now() - started > 15000) return reject(new Error('server did not start'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

(async () => {
  console.log('\nAiMapper publish-through-the-UI test');
  const mock = await startMock({ existingRepo: 'test-user/AiMapper' });
  const mockBase = mock.base;
  const mockToken = mock.store.token;
  console.log(`  mock GitHub at ${mockBase}`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-publish-'));

  const server = spawn(process.execPath, [path.join(ROOT, 'app/backend/server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      MAPPER_DATA_DIR: dataDir,
      GITHUB_API_BASE: mockBase,
      MAPPER_DEFAULT_OWNER: 'test-user',
      MAPPER_DEFAULT_REPO: 'AiMapper',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (c) => serverLog.push(c.toString()));
  server.stderr.on('data', (c) => serverLog.push(c.toString()));
  const cleanup = () => { try { server.kill('SIGKILL'); } catch (_) {} try { mock.stop(); } catch (_) {} };
  process.on('exit', cleanup);

  try {
    await waitForHealth(base);
  } catch (err) {
    console.log(serverLog.join(''));
    check('server boots against the mock GitHub', false, err.message);
    process.exit(1);
  }

  let cookie = '';
  const realFetch = globalThis.fetch.bind(globalThis);
  const shimFetch = async (url, opts = {}) => {
    const full = String(url).startsWith('http') ? String(url) : base + String(url);
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await realFetch(full, { ...opts, headers });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const pair = c.split(';')[0];
      if (pair.includes('=')) cookie = pair;
    }
    return res;
  };

  const dom = makeDom();
  const g = globalThis;
  g.document = dom.document;
  g.fetch = shimFetch;
  g.navigator = { clipboard: { writeText: async () => {} } };
  g.window = { location: { href: `${base}/studio`, search: '', origin: base }, innerWidth: 1440, innerHeight: 900, fetch: shimFetch, addEventListener() {}, requestAnimationFrame: () => 0 };
  g.setInterval = () => 0;

  const errors = [];
  const src = fs.readFileSync(path.join(ROOT, 'app/web/studio.js'), 'utf8');
  const run = new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'setTimeout', 'requestAnimationFrame', 'console', src);
  run(g.window, g.document, g.navigator, shimFetch, g.setInterval,
    (fn, ms) => setTimeout(fn, Math.min(ms || 0, 50)), () => 0,
    { log() {}, warn() {}, info() {}, error: (...a) => errors.push(a.join(' ')) });
  dom.boot();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (sel) => dom.els.get(sel)?.textContent ?? '';
  const html = (sel) => dom.els.get(sel)?.innerHTML ?? '';

  await sleep(1800);

  // ---- connect ---------------------------------------------------------
  check('starts disconnected', /not connected|sandbox/i.test(text('#auth-chip')), text('#auth-chip'));
  dom.els.get('#in-token').value = mockToken;
  dom.els.get('#btn-token').dispatch('click');
  await sleep(2500);
  check('token connection succeeds', /@test-user/.test(text('#auth-chip')), text('#auth-chip'));
  check('account panel shows the login', /@test-user/.test(text('#acct-login')), text('#acct-login'));
  check('the token is never echoed into the page', !html('#account-box').includes(mockToken) && !text('#auth-chip').includes(mockToken));

  // ---- repo manager ----------------------------------------------------
  dom.els.get('#btn-repos').dispatch('click');
  await sleep(1200);
  check('repository list loads', /test-user\/AiMapper/.test(html('#repo-list')), html('#repo-list').replace(/\s+/g, ' ').slice(0, 160) || '(empty)');
  dom.els.get('#btn-verify').dispatch('click');
  await sleep(1200);
  check('access verification reports push rights', /push|write|ok|access/i.test(text('#verify-out')), text('#verify-out').slice(0, 120));

  // ---- generate + publish ----------------------------------------------
  dom.els.get('#in-repo').value = 'test-user/AiMapper';
  dom.els.get('#in-name').value = 'publish-e2e';
  dom.els.get('#in-publish').checked = true;
  dom.els.get('#btn-generate').dispatch('click');

  let status = '';
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    if (dom.els.get('#result-block').hidden === false) { status = 'success'; break; }
    if (/failed/i.test(text('#progress-step'))) { status = 'error'; break; }
  }
  check('published generation completes', status === 'success', text('#progress-step').slice(0, 120));

  const resultHtml = html('#result-block');
  check('result links to the commit', /View commit/.test(resultHtml), (resultHtml.match(/View commit [0-9a-f]+/) || [''])[0]);
  check('result links to the repo tree', /Browse on GitHub/.test(resultHtml), /github\.com[^"]*/.exec(resultHtml)?.[0] || '');
  check('result reports the pushed path', /models\/publish-e2e/.test(resultHtml), (resultHtml.match(/models\/[a-z0-9-]+/) || [''])[0]);
  check('no longer says "local only"', !/local only|not published/i.test(resultHtml));
  check('Actions run is surfaced', /Actions run|actions\/runs/.test(resultHtml), (resultHtml.match(/actions run: \w+/i) || ['no run yet'])[0]);

  // ---- what the mock actually received ---------------------------------
  const state = mock.store;
  // the mock records the upload as blobs + a tree, which is exactly what the
  // GitHub data API receives; `contents` only holds API-read files
  const treePaths = [...state.trees.values()].flat().map((e) => e.path || e);
  const blobText = [...state.blobs.values()].map((b64) => Buffer.from(b64, 'base64').toString('utf8'));
  const allPaths = [...treePaths, ...state.contents.keys()];
  const allText = [...blobText, ...state.contents.values()].join('\n');
  check('repository existed and was reused', state.repos.has('test-user/AiMapper'));
  check('a commit was created', state.commits.size >= 1, `${state.commits.size} commits`);
  const modelPaths = allPaths.filter((k) => k.includes('models/publish-e2e'));
  check('the model files landed in the repo', modelPaths.some((k) => k.endsWith('config.json')), `${modelPaths.length} files under models/publish-e2e`);
  check('training + inference code was committed', modelPaths.some((k) => k.endsWith('train.py')) && modelPaths.some((k) => k.endsWith('inference.py')));
  check('the tokenizer was committed', modelPaths.some((k) => k.endsWith('tokenizer/vocab.json')));
  check('the dataset was committed', modelPaths.some((k) => k.includes('data/corpus/train.jsonl')));
  check('weights were committed', modelPaths.some((k) => k.endsWith('weights/model.safetensors')));
  check('CI workflows were committed', modelPaths.some((k) => k.includes('.github/workflows/')));
  check('README ledger exists', allPaths.some((k) => k.endsWith('models/README.md')));
  check('the actions workflow was dispatched', state.dispatches.length >= 1, JSON.stringify(state.dispatches[0] || {}).slice(0, 120));
  check('committed README records the parameter count', /5,00\d,\d{3}|50\d{4,5}/.test(allText), 'README present in blobs');

  const rawState = JSON.stringify({ paths: allPaths, dispatches: state.dispatches, text: allText.slice(0, 4000) });
  check('no token material reached the repository', !rawState.includes(mockToken));

  // ---- log + monitoring reflect the publish ----------------------------
  const logText = text('#log-body');
  const publishLines = logText.split('\n').filter((l) => /github|push|commit|actions/i.test(l));
  check('publish appears in the build log', publishLines.length >= 2, publishLines.slice(-3).join(' | ').slice(0, 200));
  check('the build log names the commit sha', /[0-9a-f]{7,40}/.test(logText), (logText.match(/([0-9a-f]{7,40})/) || [''])[0]);

  check('no uncaught front-end errors', errors.length === 0, errors.join('; '));
  const bad = serverLog.join('').split('\n').filter((l) => /"status":5\d\d/.test(l));
  check('server logged no 5xx responses', bad.length === 0, bad.slice(0, 3).join(' | ') || 'none');

  cleanup();
  console.log(`\n  ${passed} passed, ${failed} failed${failed ? ': ' + failures.join(', ') : ''}`);
  if (failed) {
    console.log('\nserver log tail:\n' + serverLog.join('').split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\npublish-ui test crashed:', err);
  process.exit(1);
});
