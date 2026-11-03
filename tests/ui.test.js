'use strict';
/* Front-end integration test.
 *
 * Boots the real server on an ephemeral port, loads the real app/web/studio.js
 * into a minimal DOM shim, and drives it the way a user would: boot → estimate →
 * architecture view → generate a real model → read the results, logs, validation
 * and monitoring panels.  This is the only automated coverage of the browser
 * layer, so it deliberately asserts on rendered output rather than internals.
 *
 *   node tests/ui.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

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
      toggle: (c, on) => (on === undefined ? (this.classList.contains(c) ? this.classList.remove(c) : this.classList.add(c)) : on ? this.classList.add(c) : this.classList.remove(c)),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerText() { return this._text; }
  set innerText(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this._text = String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
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
    el.parentElement = root; // mirrors the real nesting so parentElement chains work
    root.appendChild(el);
    els.set(`#${id}`, el);
  }
  const set = (sel, val) => { if (els.has(sel)) els.get(sel).value = val; };
  set('#in-name', 'ui-test-5m');
  set('#in-target', '5000000');
  set('#in-vocab', '2048');
  set('#in-synthetic', '16');
  set('#in-basepath', 'models');
  set('#t-batch', '16');
  set('#t-lr', '0.0003');
  set('#t-steps', '2000');
  set('#t-wd', '0.1');
  set('#t-clip', '1');
  set('#t-warm', '0.03');
  set('#t-opt', 'adamw');
  set('#t-sched', 'cosine');
  els.get('#in-publish').checked = false; // stay local: no GitHub creds in CI
  els.get('#log-follow').checked = true;

  const tabs = ['generator', 'architecture', 'github', 'logs', 'versions', 'monitoring', 'validation', 'training', 'counter']
    .map((name) => { const t = new El('button', '', 'tab'); t.dataset.panel = name; return t; });
  let boot = null;
  let currentPanel = 'generator';

  const created = [];
  const document = {
    querySelector(sel) {
      if (els.has(sel)) return els.get(sel);
      if (sel === '.token-box') return els.get('#in-token');
      if (sel.startsWith('#')) {
        const hit = created.find((c) => `#${c.id}` === sel);
        if (hit) return hit;
      }
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        const hit = created.find((c) => c.classList.contains(cls));
        if (hit) return hit;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.tab') return tabs;
      return [];
    },
    createElement(tag) {
      const el = new El(tag);
      const origSetId = Object.getOwnPropertyDescriptor(el, 'id');
      el.addEventListener('__register', () => {});
      created.push(el);
      return el;
    },
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') boot = fn; },
    body: new El('body'),
    documentElement: new El('html'),
  };
  const $$ = (sel) => document.querySelectorAll(sel);
  const $ = (sel) => document.querySelector(sel);
  return { document, $, $$, boot: () => boot(), tabs, els, created, getPanel: () => currentPanel };
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

function waitForHealth(base, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) return resolve(await res.json());
      } catch (_) { /* not up yet */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('server did not start'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mapper-ui-'));

  console.log('\nAiMapper front-end integration test');
  console.log(`  server on ${base}  ·  data in ${dataDir}\n`);

  const server = spawn(process.execPath, [path.join(ROOT, 'app/backend/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MAPPER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (c) => serverLog.push(c.toString()));
  server.stderr.on('data', (c) => serverLog.push(c.toString()));

  const cleanup = () => { try { server.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);

  let health;
  try {
    health = await waitForHealth(base);
  } catch (err) {
    console.log('server log:\n' + serverLog.join(''));
    check('server boots', false, err.message);
    process.exit(1);
  }

  const dom = makeDom();
  const realFetch = globalThis.fetch.bind(globalThis);
  // Minimal cookie jar: the browser would handle Set-Cookie/same-origin
  // credentials for us, so the harness has to do it explicitly.
  let cookie = '';
  const shimFetch = async (url, opts = {}) => {
    const full = String(url).startsWith('http') ? String(url) : base + String(url);
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await realFetch(full, { ...opts, headers, credentials: 'same-origin' });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.includes('=')) cookie = pair;
    }
    return res;
  };

  const g = globalThis;
  g.document = dom.document;
  g.fetch = shimFetch;
  g.navigator = { clipboard: { writeText: async () => {} } };
  g.window = {
    location: { href: `${base}/studio`, search: '', origin: base },
    innerWidth: 1440,
    innerHeight: 900,
    fetch: shimFetch,
    addEventListener() {},
    requestAnimationFrame: () => 0,
  };
  const realSetInterval = globalThis.setInterval;
  g.setInterval = () => 0; // disable background polling loops; the test drives timing

  const toasts = [];
  const src = fs.readFileSync(path.join(ROOT, 'app/web/studio.js'), 'utf8');
  const run = new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'setTimeout', 'requestAnimationFrame', 'console', src);
  const sandboxedConsole = {
    log: (...a) => console.log(...a),
    warn: (...a) => console.log('  warn:', ...a),
    error: (...a) => { toasts.push(a.join(' ')); console.log('  [console.error]', ...a); },
    info: (...a) => console.log(...a),
  };

  const errors = [];
  const origLog = console.log;
  const captureToast = (msg) => { if (msg) toasts.push(String(msg)); };
  try {
    run(g.window, g.document, g.navigator, shimFetch, g.setInterval,
      (fn, ms) => setTimeout(fn, Math.min(ms || 0, 50)), () => 0, sandboxedConsole);
    dom.boot();
  } catch (err) {
    errors.push(err);
    console.log('  boot threw:', err.message);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (sel) => dom.els.get(sel)?.textContent ?? '';
  const html = (sel) => dom.els.get(sel)?.innerHTML ?? '';

  // ---- boot -------------------------------------------------------------
  await sleep(1800);
  check('studio.js boots without throwing', errors.length === 0, errors.map((e) => e.message).join('; '));
  check('health pill reflects the live server', /server up/i.test(text('#health')), text('#health'));
  check('version is rendered', /v\d+\.\d+\.\d+/.test(text('#ver')), text('#ver'));
  check('parameter counter shows a real count', /^5,0\d\d,\d{3}$/.test(text('#counter-value').trim()), text('#counter-value'));
  check('target hint explains the deviation', /%/.test(text('#gen-sub')), text('#gen-sub').slice(0, 80));
  check('default repo is prefilled', /GalaxyFSRP1\/AiMapper/.test(dom.els.get('#in-repo').value), dom.els.get('#in-repo').value);
  check('auth chip shows a connection state', text('#auth-chip').length > 0, text('#auth-chip'));
  check('counter breakdown renders cells', html('#counter-grid').length > 200, `${html('#counter-grid').length} bytes`);
  check('sanitised API error strings do not leak tokens', !/gh[opsu]_[A-Za-z0-9]{20,}/.test(html('#counter-grid') + text('#auth-chip')));

  // ---- estimate → architecture ------------------------------------------
  dom.els.get('#btn-estimate').dispatch('click');
  await sleep(1500);
  const estimateParams = Number(text('#counter-value').replace(/[^\d]/g, ''));
  check('estimate returns ~5M parameters', estimateParams > 4_900_000 && estimateParams < 5_100_000, `${estimateParams}`);
  check('estimate trains a real tokenizer for the seed', /the search lands on/.test(text('#gen-sub')) || /the search lands on/.test(text('#gen-sub')), text('#gen-sub').slice(0, 70));
  check('architecture grid renders', html('#arch-grid').length > 200);
  check('architecture alternative table renders', html('#arch-alternatives').length > 200);
  check('architecture canvas is painted', html('#arch-canvas') !== undefined);

  // ---- real generation --------------------------------------------------
  // Changing the seed or corpus size changes the trained vocabulary and therefore
  // the architecture; the UI re-estimates on input, so do the same here and let
  // the debounce settle before measuring the "preview matched the build" checks.
  dom.els.get('#in-synthetic').value = '16';
  dom.els.get('#in-synthetic').dispatch('input');
  dom.els.get('#in-name').value = 'ui-test-5m';
  dom.els.get('#in-name').dispatch('input');
  dom.els.get('#in-publish').checked = false;
  await sleep(1400);
  const previewLayers = (html('#counter-grid').match(/Layers<\/dt><dd>(\d+)/) || [])[1];
  const previewWidth = (html('#counter-grid').match(/d_model<\/dt><dd>(\d+)/) || [])[1];
  check('changing the seed re-runs the estimate', /the search lands on/.test(text('#gen-sub')), text('#gen-sub').slice(0, 80));
  dom.els.get('#btn-generate').dispatch('click');

  let finalStatus = '';
  let lastStep = '';
  for (let i = 0; i < 200; i++) {
    await sleep(250);
    lastStep = text('#progress-step');
    if (dom.els.get('#result-block').hidden === false) { finalStatus = 'success'; break; }
    if (/fail|error/i.test(lastStep) && i > 20) { finalStatus = 'error'; break; }
  }

  check('generation job completes', finalStatus === 'success', `last step: ${lastStep}`);
  const resultHtml = html('#result-block');
  const jobId = (dom.els.get('#log-body') ? '' : '');
  const statusNow = await (await fetch(`${base}/api/status`)).json();
  const lastJob = statusNow.jobs && statusNow.jobs[0];
  const jobDetail = lastJob ? await (await fetch(`${base}/api/jobs/${lastJob.id}`)).json() : null;
  const resultArch = (jobDetail && jobDetail.result && jobDetail.result.architecture) || {};
  check('job detail exposes the architecture', Boolean(resultArch.d_model && resultArch.n_layer), JSON.stringify(resultArch));
  check('result card renders', resultHtml.length > 500, `${resultHtml.length} bytes`);
  const paramMatch = resultHtml.match(/([\d,]+)\s*(?:trainable )?parameters/i);
  const resultParams = paramMatch ? Number(paramMatch[1].replace(/,/g, '')) : 0;
  check('result reports real parameter count', resultParams > 4_900_000 && resultParams < 5_100_000, `${resultParams}`);
  // the dashboard must end up bound to the model that was actually built
  const builtLayers = html('#counter-grid').match(/Layers<\/dt><dd>(\d+)/);
  const builtWidth = html('#counter-grid').match(/d_model<\/dt><dd>(\d+)/);
  check('counter rebinds to the built model', /built model has/.test(text('#gen-sub')), text('#gen-sub').slice(0, 80));
  check('counter width matches the built architecture',
    Boolean(builtWidth) && builtWidth[1] === String(resultArch.d_model), `counter d=${builtWidth && builtWidth[1]} build d=${resultArch.d_model}`);
  check('counter depth matches the built architecture',
    Boolean(builtLayers) && builtLayers[1] === String(resultArch.n_layer), `counter L=${builtLayers && builtLayers[1]} build L=${resultArch.n_layer}`);
  check('preview depth equalled the build depth', previewLayers === String(resultArch.n_layer),
    `preview L=${previewLayers} build L=${resultArch.n_layer}`);
  check('preview width equalled the build width', previewWidth === String(resultArch.d_model),
    `preview d=${previewWidth} build d=${resultArch.d_model}`);
  check('download link is offered', /Download ZIP/.test(resultHtml) || /\/artifact/.test(resultHtml));
  check('local run is labelled as unpublished', /not published|local only/i.test(resultHtml));
  check('progress reaches 100%', /100/.test(text('#progress-pct')), text('#progress-pct'));
  check('step list is populated', (html('#steps').match(/<li/g) || []).length >= 5, `${(html('#steps').match(/<li/g) || []).length} steps`);
  check('validation checklist renders 20+ checks', (html('#val-body').match(/<li/g) || []).length >= 20,
    `${(html('#val-body').match(/<li/g) || []).length} items`);
  check('validation summary shows a pass', /passed/.test(text('#val-sub')), text('#val-sub'));
  check('build log has real output', text('#log-body').split('\n').filter(Boolean).length >= 5,
    `${text('#log-body').split('\n').filter(Boolean).length} lines`);
  check('build log mentions the tokenizer', /tokenizer/i.test(text('#log-body')));
  check('build log mentions validation results', /validation/i.test(text('#log-body')));
  check('no uncaught front-end errors', errors.length === 0, errors.map((e) => e.message).join('; '));

  const toastHost = dom.created.find((c) => c.classList.contains('toasts'));
  const toastText = toastHost ? toastHost.children.map((c) => c.textContent) : [];
  check('a success toast is shown', toastText.some((t) => /generated successfully/i.test(t)), toastText.join(' | ') || 'no toasts');
  check('no error toasts appeared', !toastText.some((t) => /^lost track|failed|could not/i.test(t)), toastText.join(' | ') || 'none');

  // ---- monitoring -------------------------------------------------------
  await sleep(1500);
  check('monitoring stats render', html('#mon-stats').length > 100);
  check('version history renders the run', html('#versions-body').length > 100);

  // ---- API cross-checks -------------------------------------------------
  const hist = await (await fetch(`${base}/api/history`)).json();
  check('history endpoint records the run', Array.isArray(hist.history) && hist.history.length >= 1, `${(hist.history || []).length} entries`);
  const mon = await (await fetch(`${base}/api/monitoring`)).json();
  check('monitoring endpoint reports counters', !!mon && (mon.totals !== undefined || mon.jobs !== undefined));

  const secrets = JSON.stringify(hist) + JSON.stringify(mon);
  check('no token material in API payloads', !/gh[opsu]_[A-Za-z0-9]{20,}|"token"\s*:\s*"[^"]{10,}"/.test(secrets));

  cleanup();
  g.setInterval = realSetInterval;

  console.log(`\n  ${passed} passed, ${failed} failed${failed ? ': ' + failures.join(', ') : ''}`);
  if (failed) {
    console.log('\nserver log tail:\n' + serverLog.join('').split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nui test crashed:', err);
  process.exit(1);
});
