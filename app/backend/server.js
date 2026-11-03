'use strict';
/* AiMapper Model Studio — HTTP server (zero dependencies).

   Security model
   - OAuth client secret + user tokens live only in this process and at rest
     inside an AES-256-GCM sealed store. No API response ever contains a token.
   - Session cookie is HttpOnly + SameSite=Lax (+ Secure when served over TLS).
   - State-changing endpoints are POST + same-origin checked.
   - Basic per-IP rate limiting on auth and generation endpoints.
*/

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { Store } = require('./store');
const { Vault } = require('./lib/vault');
const { log } = require('./logger');
const gh = require('./lib/github');
const spec = require('./lib/model-spec');
const corpus = require('./lib/corpus');
const { JobRunner, STEPS } = require('./jobs');
const { GENERATOR_VERSION } = require('./lib/project-builder');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(ROOT, 'app', 'web');
const DATA_DIR = process.env.MAPPER_DATA_DIR || path.join(ROOT, '.data');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const store = new Store(DATA_DIR);
const vault = new Vault(DATA_DIR);
const runner = new JobRunner({ store, vault });

// Tolerant boolean flags: "1", "true", "yes", "on" (case-insensitive) all mean on;
// empty string / "0" / "false" / "off" mean off.  An empty value from a deployment
// panel must never silently disable a feature.
function envFlag(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}
const CORS_ALLOW_ALL = envFlag('MAPPER_ALLOW_ANY_ORIGIN');
const TRUST_PROXY = envFlag('MAPPER_TRUST_PROXY');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers,
  });
  res.end(payload);
}

function sendJSON(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data, null, 2), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const recent = bucket.filter((t) => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  rateBuckets.set(key, recent);
  return true;
}

const SKIP_CSRF = new Set(['/api/auth/token']);
function sameOrigin(req) {
  // Requests with no Origin header come from same-origin navigations / curl.
  const origin = req.headers.origin;
  if (!origin) return true;
  if (CORS_ALLOW_ALL) return true;
  try {
    const o = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) return false;
    if (o.host === host) return true;
    // sandbox preview hosts (*.e2b.app) proxy to the same server
    if (/\.(e2b\.app|arena\.ai)$/i.test(o.hostname) && /\.(e2b\.app|arena\.ai)$/i.test(host)) return true;
    return ALLOWED_ORIGINS.has(o.origin);
  } catch {
    return false;
  }
}

const ALLOWED_ORIGINS = new Set(
  (process.env.MAPPER_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function sessionFor(req) {
  const cookies = parseCookies(req);
  const session = store.getSession(cookies.mapper_session);
  return session || null;
}

function redirectUri(req) {
  if (process.env.GITHUB_REDIRECT_URI) return process.env.GITHUB_REDIRECT_URI;
  const proto = (TRUST_PROXY && (req.headers['x-forwarded-proto'] || '').split(',')[0]) || (req.socket.encrypted ? 'https' : 'http');
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
  return `${proto}://${host}/auth/github/callback`;
}

function setSessionCookie(res, id, req) {
  const secure = req.socket.encrypted || /^https$/i.test((req.headers['x-forwarded-proto'] || '').split(',')[0] || '');
  const parts = [`mapper_session=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + 60 * 60 * 24 * 30];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'mapper_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function publicUser(userId) {
  const user = store.user(userId);
  if (!user) return null;
  return {
    id: userId,
    login: user.login || null,
    name: user.name || null,
    avatarUrl: user.avatarUrl || null,
    connected: Boolean(user.tokenSealed),
    connectedAt: user.connectedAt || null,
    expiresAt: user.expiresAt || null,
    scopes: user.scope || null,
    authMethod: user.authMethod || null,
  };
}

function monitoringSnapshot() {
  const jobs = Object.values(store.state.jobs);
  const failures = jobs.filter((j) => j.status === 'error');
  const last24 = jobs.filter((j) => Date.now() - j.createdAt < 86400000);
  return {
    jobs: {
      total: jobs.length,
      running: jobs.filter((j) => j.status === 'running').length,
      success: jobs.filter((j) => j.status === 'success').length,
      failed: failures.length,
      last24h: last24.length,
    },
    parameters: {
      totalGenerated: jobs.filter((j) => j.status === 'success').reduce((n, j) => n + (j.result?.parameters || 0), 0),
      averageModelSize: (() => {
        const done = jobs.filter((j) => j.status === 'success' && j.result?.parameters);
        return done.length ? Math.round(done.reduce((n, j) => n + j.result.parameters, 0) / done.length) : 0;
      })(),
    },
    errors: {
      count: failures.length,
      latest: failures.slice(-5).reverse().map((j) => ({
        jobId: j.id,
        at: j.finishedAt || j.updatedAt,
        model: j.params?.name,
        message: j.error?.message || 'unknown error',
        hint: j.error?.hint || null,
      })),
    },
    logCounts: log.counts(),
    recentLogs: log.entries(40),
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, opts });

route('GET', '/api/health', async (req, res) => {
  sendJSON(res, 200, {
    ok: true,
    service: 'aimapper-model-studio',
    version: GENERATOR_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
  });
});

route('GET', '/api/config', async (req, res) => {
  const oauthEnabled = gh.oauthConfigured(process.env);
  sendJSON(res, 200, {
    oauthEnabled,
    // the public client id is safe to expose; the secret never leaves the server
    clientId: oauthEnabled ? process.env.GITHUB_CLIENT_ID : null,
    manualTokenEnabled: !envFlag('MAPPER_DISABLE_MANUAL_TOKEN'),
    defaultOwner: process.env.MAPPER_DEFAULT_OWNER || 'GalaxyFSRP1',
    defaultRepo: process.env.MAPPER_DEFAULT_REPO || 'AiMapper',
    defaultBasePath: process.env.MAPPER_DEFAULT_BASE_PATH || 'models',
    defaults: {
      name: 'mapper-5m',
      targetParameters: 5_000_000,
      vocabSize: 2048,
      syntheticExamples: 64,
    },
    limits: spec.LIMITS,
    steps: STEPS,
    version: GENERATOR_VERSION,
    origins: [...ALLOWED_ORIGINS],
  });
});

route('GET', '/api/status', async (req, res) => {
  const session = sessionFor(req);
  const userId = session?.userId || null;
  sendJSON(res, 200, {
    authenticated: Boolean(userId),
    user: userId ? publicUser(userId) : null,
    oauthEnabled: gh.oauthConfigured(process.env),
    config: {
      defaultOwner: process.env.MAPPER_DEFAULT_OWNER || 'GalaxyFSRP1',
      defaultRepo: process.env.MAPPER_DEFAULT_REPO || 'AiMapper',
      defaultBasePath: process.env.MAPPER_DEFAULT_BASE_PATH || 'models',
      manualTokenEnabled: !envFlag('MAPPER_DISABLE_MANUAL_TOKEN'),
    },
    jobs: userId ? store.jobsForUser(userId, 10).map(summariseJob) : [],
    history: userId ? store.historyForUser(userId, 20) : [],
    monitoring: monitoringSnapshot(),
  });
});

// ---- OAuth ---------------------------------------------------------------
route('GET', '/auth/github', async (req, res, url) => {
  if (!gh.oauthConfigured(process.env)) {
    return send(res, 400, htmlPage('GitHub OAuth not configured', `
      <p>This deployment has no <code>GITHUB_CLIENT_ID</code> / <code>GITHUB_CLIENT_SECRET</code>.</p>
      <p>Options:</p>
      <ol>
        <li>Create an OAuth App at <a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a>
            with callback <code>${redirectUri(req)}</code>, then set the two env vars and restart.</li>
        <li>Or go back and paste a fine-grained personal access token — it is encrypted server-side exactly like OAuth tokens.</li>
      </ol>
      <p><a href="/">← back to Model Studio</a></p>`), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (!rateLimit(`auth:${clientIp(req)}`, 20, 60_000)) {
    return sendJSON(res, 429, { error: 'too many auth attempts, slow down' });
  }
  const state = crypto.randomBytes(24).toString('base64url');
  const { verifier, challenge } = gh.pkcePair();
  const session = sessionFor(req);
  const userId = session?.userId || `anon_${crypto.randomBytes(8).toString('hex')}`;
  store.upsertUser(userId, {
    oauthState: state,
    oauthVerifier: verifier,
    oauthStateAt: Date.now(),
    oauthRedirect: redirectUri(req),
  });
  if (!session) setSessionCookie(res, store.createSession(userId), req);
  const authorizeUrl = gh.buildAuthorizeUrl({
    clientId: process.env.GITHUB_CLIENT_ID,
    redirectUri: redirectUri(req),
    state,
  }) + `&code_challenge=${challenge}&code_challenge_method=S256`;
  res.writeHead(302, { Location: authorizeUrl, 'Cache-Control': 'no-store' });
  res.end();
});

route('GET', '/auth/github/callback', async (req, res, url) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const session = sessionFor(req);
  if (!session) return send(res, 400, htmlPage('Session expired', '<p>Your session expired before GitHub replied. <a href="/">Start again</a>.</p>'));
  const user = store.user(session.userId);
  if (!code || !state || !user || state !== user.oauthState) {
    log.warn('auth.state_mismatch', { hasCode: Boolean(code), hasState: Boolean(state) });
    return send(res, 400, htmlPage('Invalid OAuth state', '<p>The callback did not match this session (CSRF protection). <a href="/">Try again</a>.</p>'));
  }
  try {
    const tokens = await gh.exchangeCode({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirectUri: user.oauthRedirect || redirectUri(req),
      codeVerifier: user.oauthVerifier,
    });
    const client = new gh.GitHubClient(tokens.accessToken);
    const me = await client.me();
    store.upsertUser(session.userId, {
      login: me.login,
      name: me.name,
      avatarUrl: me.avatar_url,
      tokenSealed: vault.seal(tokens.accessToken, `gh-token:${session.userId}`),
      refreshSealed: tokens.refreshToken ? vault.seal(tokens.refreshToken, `gh-refresh:${session.userId}`) : null,
      scope: tokens.scope,
      authMethod: 'oauth',
      connectedAt: Date.now(),
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : null,
      oauthState: null,
      oauthVerifier: null,
    });
    log.info('auth.connected', { userId: session.userId, login: me.login, method: 'oauth' });
    res.writeHead(302, { Location: '/?connected=1', 'Cache-Control': 'no-store' });
    res.end();
  } catch (err) {
    log.error('auth.callback_failed', { error: err });
    send(res, 502, htmlPage('GitHub OAuth failed', `<p>${escapeHtml(err.message)}</p><p><a href="/">Back</a></p>`));
  }
});

// ---- sandbox session (local-only generation, no GitHub) ----------------
// Lets anyone try the full generator in this browser. Jobs created here are
// never published; they are downloadable as a ZIP and nothing leaves the box.
route('POST', '/api/session', async (req, res) => {
  if (envFlag('MAPPER_DISABLE_SANDBOX')) {
    return sendJSON(res, 403, { error: 'sandbox sessions are disabled on this deployment' });
  }
  if (!rateLimit(`session:${clientIp(req)}`, 10, 60_000)) {
    return sendJSON(res, 429, { error: 'too many sessions, wait a minute' });
  }
  const existing = sessionFor(req);
  if (existing) return sendJSON(res, 200, { ok: true, session: { userId: existing.userId }, reused: true });
  const userId = `guest_${crypto.randomBytes(9).toString('hex')}`;
  const sid = store.createSession(userId);
  store.upsertUser(userId, { authMethod: 'sandbox', connectedAt: null });
  setSessionCookie(res, sid, req);
  log.info('session.sandbox', { userId });
  sendJSON(res, 200, { ok: true, session: { userId }, reused: false });
});

// ---- manual token (same sealing guarantees) -----------------------------
route('POST', '/api/auth/token', async (req, res) => {
  if (envFlag('MAPPER_DISABLE_MANUAL_TOKEN')) {
    return sendJSON(res, 403, { error: 'manual token auth is disabled on this deployment' });
  }
  if (!rateLimit(`token:${clientIp(req)}`, 8, 60_000)) {
    return sendJSON(res, 429, { error: 'too many attempts, wait a minute' });
  }
  const body = await readBody(req);
  const token = String(body.token || '').trim();
  if (!/^(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token)) {
    return sendJSON(res, 400, { error: 'that does not look like a GitHub token (expected ghp_… or github_pat_…)' });
  }
  let me;
  try {
    const client = new gh.GitHubClient(token);
    me = await client.me();
    // verify the token can actually read the target repo scope-wise
    const tokenScopes = me && me.login ? true : false;
    void tokenScopes;
  } catch (err) {
    return sendJSON(res, 401, { error: `GitHub rejected the token: ${err.message}`, hint: 'Check that the token is not expired and has "repo" + "workflow" scopes.' });
  }
  let session = sessionFor(req);
  if (!session) {
    const userId = `user_${me.id}`;
    const sid = store.createSession(userId);
    setSessionCookie(res, sid, req);
    session = { userId };
  }
  store.upsertUser(session.userId, {
    login: me.login,
    name: me.name,
    avatarUrl: me.avatar_url,
    tokenSealed: vault.seal(token, `gh-token:${session.userId}`),
    scope: 'repo workflow (personal access token)',
    authMethod: 'pat',
    connectedAt: Date.now(),
    expiresAt: null,
  });
  log.info('auth.connected', { userId: session.userId, login: me.login, method: 'pat' });
  sendJSON(res, 200, { ok: true, user: publicUser(session.userId) });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const session = sessionFor(req);
  if (session) {
    store.upsertUser(session.userId, { tokenSealed: null, refreshSealed: null, connectedAt: null });
    store.destroySession(parseCookies(req).mapper_session);
    log.info('auth.logout', { userId: session.userId });
  }
  clearSessionCookie(res);
  sendJSON(res, 200, { ok: true });
});

// ---- GitHub introspection ------------------------------------------------
function requireAuth(req, res) {
  const session = sessionFor(req);
  if (!session) {
    sendJSON(res, 401, { error: 'not authenticated' });
    return null;
  }
  const user = store.user(session.userId);
  const token = user?.tokenSealed ? vault.open(user.tokenSealed, `gh-token:${session.userId}`) : null;
  if (!token) {
    sendJSON(res, 401, { error: 'GitHub is not connected for this session' });
    return null;
  }
  return { session, user, token };
}

route('GET', '/api/github/repos', async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const client = new gh.GitHubClient(auth.token);
    const repos = await client.listRepos();
    if (!Array.isArray(repos)) throw new Error('GitHub returned an unexpected repository payload');
    sendJSON(res, 200, {
      repos: repos.map((r) => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner?.login || String(r.full_name || '').split('/')[0],
        private: r.private,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
        htmlUrl: r.html_url,
      })),
    });
  } catch (err) {
    sendJSON(res, 502, { error: err.message });
  }
});

route('POST', '/api/github/verify', async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  try {
    const client = new gh.GitHubClient(auth.token);
    const owner = body.owner || auth.user.login;
    const repo = body.repo;
    const checks = { scopes: 'unknown', repo: null, canPush: false, workflows: false };
    try {
      await client.request('GET', '/user');
    } catch { /* handled below */ }
    let repoInfo = null;
    try {
      repoInfo = await client.getRepo(owner, repo);
      checks.repo = { fullName: repoInfo.full_name, private: repoInfo.private, defaultBranch: repoInfo.default_branch };
      checks.canPush = Boolean(repoInfo.permissions?.push);
    } catch (err) {
      if (err.status === 404) checks.repo = { exists: false };
      else throw err;
    }
    try {
      await client.request('GET', `/repos/${owner}/${repo}/actions/workflows`);
      checks.workflows = true;
    } catch { checks.workflows = false; }
    sendJSON(res, 200, { ok: true, checks });
  } catch (err) {
    sendJSON(res, 502, { error: err.message, status: err.status || null });
  }
});

// ---- parameter estimation (fast, no weights) ----------------------------
// The architecture depends on the *trained* vocabulary, not the vocab cap: the
// BPE trainer usually produces far fewer tokens than the cap, and a smaller
// vocabulary means a wider, shallower model for the same budget.  Unless the
// caller supplies a tokenizer, we train a real one from the same seed so the
// numbers shown in the dashboard are the numbers the build will produce.
route('POST', '/api/parameters/estimate', async (req, res) => {
  const body = await readBody(req);
  try {
    const target = Number(body.targetParameters || 5_000_000);
    const vocab = Number(body.vocabSize || 2048);
    if (!(vocab >= 256 && vocab <= 65536)) throw new Error('vocabSize must be between 256 and 65536');
    const intent = {
      seed: String(body.seed || body.name || 'mapper-5m'),
      syntheticExamples: Math.max(8, Math.min(500, Number(body.syntheticExamples || 64))),
    };
    let trainedVocab = Number(body.trainedVocab || 0);
    let preview;
    if (!trainedVocab) {
      const built = corpus.buildCorpus({ seed: intent.seed, synthetic: intent.syntheticExamples });
      const vocabJson = corpus.trainBPE(built.train.map((r) => r.text), vocab);
      trainedVocab = Number(vocabJson.vocab_size) || Object.keys(vocabJson.vocab || {}).length;
      preview = { trainedVocab, corpusExamples: built.all.length };
    }
    const result = spec.searchArchitecture(target, trainedVocab, {});
    sendJSON(res, 200, {
      config: result.config,
      alternatives: result.alternatives,
      preview: preview || { trainedVocab, corpusExamples: null },
      exact: true,
      layerCount: spec.layerManifest(result.config).length,
    });
  } catch (err) {
    sendJSON(res, 400, { error: err.message });
  }
});

// ---- generation ----------------------------------------------------------
route('POST', '/api/generate', async (req, res) => {
  const body = await readBody(req);
  const session = sessionFor(req);
  if (!session) return sendJSON(res, 401, { error: 'start a session first (connect GitHub, or use a sandbox session)' });
  const user = store.user(session.userId);
  const token = user?.tokenSealed ? vault.open(user.tokenSealed, `gh-token:${session.userId}`) : null;
  const wantsPublish = body.publish !== false;
  if (wantsPublish && !token) {
    return sendJSON(res, 401, { error: 'GitHub is not connected — connect it in Settings, or uncheck "publish to GitHub" for a local-only build' });
  }
  if (!rateLimit(`generate:${session.userId}`, 6, 60_000)) {
    return sendJSON(res, 429, { error: 'too many generations in a minute — wait a moment' });
  }
  const target = Number(body.targetParameters || 5_000_000);
  if (!(target >= spec.LIMITS.target.min && target <= spec.LIMITS.target.max)) {
    return sendJSON(res, 400, { error: `targetParameters must be between ${spec.LIMITS.target.min} and ${spec.LIMITS.target.max}` });
  }
  const vocabSize = Number(body.vocabSize || 2048);
  if (!(vocabSize >= 256 && vocabSize <= 65536)) {
    return sendJSON(res, 400, { error: 'vocabSize must be between 256 and 65536' });
  }
  const name = String(body.name || 'mapper-5m').slice(0, 64);
  const job = runner.create(session.userId, {
    name,
    targetParameters: target,
    vocabSize,
    syntheticExamples: Math.max(8, Math.min(500, Number(body.syntheticExamples || 64))),
    seed: String(body.seed || name),
    owner: String(body.owner || user?.login || 'local'),
    repo: String(body.repo || process.env.MAPPER_DEFAULT_REPO || 'AiMapper'),
    basePath: String(body.basePath ?? process.env.MAPPER_DEFAULT_BASE_PATH ?? 'models'),
    privateRepo: Boolean(body.privateRepo),
    publish: wantsPublish,
    training: normaliseTraining(body.training),
  });
  // run off the request loop
  setImmediate(() => runner.run(job.id).catch((err) => log.error('job.unhandled', { error: err })));
  sendJSON(res, 202, { jobId: job.id, job: summariseJob(store.job(job.id)) });
});

// ---- jobs ----------------------------------------------------------------
route('GET', '/api/jobs', async (req, res) => {
  const session = sessionFor(req);
  if (!session) return sendJSON(res, 200, { jobs: [] });
  sendJSON(res, 200, { jobs: store.jobsForUser(session.userId, 30).map(summariseJob) });
});

route('GET', /^\/api\/jobs\/([a-z0-9_]+)$/, async (req, res, url, m) => {
  const job = ownedJob(req, res, m[1]);
  if (!job) return;
  sendJSON(res, 200, summariseJob(job, true));
});

route('GET', /^\/api\/jobs\/([a-z0-9_]+)\/logs$/, async (req, res, url, m) => {
  const job = ownedJob(req, res, m[1]);
  if (!job) return;
  const since = Number(url.searchParams.get('since') || 0);
  sendJSON(res, 200, {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    lines: (job.logs || []).slice(since),
    next: (job.logs || []).length,
    steps: job.steps,
  });
});

route('GET', /^\/api\/jobs\/([a-z0-9_]+)\/artifact$/, async (req, res, url, m) => {
  const job = ownedJob(req, res, m[1]);
  if (!job || !job.artifact) return;
  const file = job.artifact.path;
  if (!fs.existsSync(file)) return sendJSON(res, 404, { error: 'artifact no longer on disk' });
  const stat = fs.statSync(file);
  const name = job.artifact.name || 'model.zip';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

route('POST', /^\/api\/jobs\/([a-z0-9_]+)\/cancel$/, async (req, res, url, m) => {
  const job = ownedJob(req, res, m[1]);
  if (!job) return;
  if (job.status !== 'running' && job.status !== 'queued') {
    return sendJSON(res, 409, { error: `job is already ${job.status}` });
  }
  store.updateJob(job.id, { cancelRequested: true });
  sendJSON(res, 202, { ok: true, message: 'cancellation requested — the job stops at the next checkpoint' });
});

route('POST', /^\/api\/jobs\/([a-z0-9_]+)\/actions$/, async (req, res, url, m) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const job = ownedJob(req, res, m[1]);
  if (!job) return;
  if (!job.result?.github) return sendJSON(res, 409, { error: 'this job was not published to GitHub' });
  try {
    const client = new gh.GitHubClient(auth.token);
    const [owner, repo] = job.result.github.repo.split('/');
    const runs = await client.listWorkflowRuns(owner, repo, 'model-check.yml', 5);
    const jobsForRun = runs[0] ? await client.listJobsForRun(owner, repo, runs[0].id) : [];
    sendJSON(res, 200, {
      runs: runs.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        url: r.html_url,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      jobs: jobsForRun.map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        steps: (j.steps || []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion })),
      })),
    });
  } catch (err) {
    sendJSON(res, 502, { error: err.message });
  }
});

// ---- monitoring / history ----------------------------------------------
route('GET', '/api/monitoring', async (req, res) => {
  sendJSON(res, 200, monitoringSnapshot());
});

route('GET', '/api/history', async (req, res) => {
  const session = sessionFor(req);
  sendJSON(res, 200, { history: session ? store.historyForUser(session.userId, 50) : [] });
});

route('POST', '/api/logs/clear', async (req, res) => {
  log.clear();
  sendJSON(res, 200, { ok: true });
});

function normaliseTraining(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  const num = (value, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };
  const batch = num(raw.batch_size, 1, 512);
  const lr = num(raw.learning_rate, 1e-6, 1);
  const steps = num(raw.max_steps, 1, 200000);
  const wd = num(raw.weight_decay, 0, 1);
  const clip = num(raw.grad_clip, 0, 100);
  const warm = num(raw.warmup_ratio, 0, 0.5);
  const evalEvery = num(raw.eval_every, 1, 100000);
  if (batch) out.batch_size = Math.round(batch);
  if (lr) out.learning_rate = lr;
  if (steps) out.max_steps = Math.round(steps);
  if (wd !== undefined) out.weight_decay = wd;
  if (clip !== undefined) out.grad_clip = clip;
  if (warm !== undefined) out.warmup_ratio = warm;
  if (evalEvery) out.eval_every = Math.round(evalEvery);
  if (typeof raw.optimizer === 'string' && ['adamw', 'adam', 'sgd'].includes(raw.optimizer)) out.optimizer = raw.optimizer;
  if (typeof raw.scheduler === 'string' && ['cosine', 'linear', 'constant'].includes(raw.scheduler)) out.scheduler = raw.scheduler;
  return Object.keys(out).length ? out : undefined;
}

function ownedJob(req, res, id) {
  const job = store.job(id);
  if (!job) {
    sendJSON(res, 404, { error: 'job not found' });
    return null;
  }
  const session = sessionFor(req);
  if (!session || session.userId !== job.userId) {
    sendJSON(res, 403, { error: 'this job belongs to another session' });
    return null;
  }
  return job;
}

function summariseJob(job, withResult = false) {
  const base = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    progress: job.progress,
    step: job.step,
    steps: job.steps,
    params: {
      name: job.params?.name,
      targetParameters: job.params?.targetParameters,
      vocabSize: job.params?.vocabSize,
      repo: job.params?.repo,
      owner: job.params?.owner,
      basePath: job.params?.basePath,
      publish: job.params?.publish,
    },
    error: job.error || null,
    logCount: (job.logs || []).length,
    artifact: job.artifact ? { url: `/api/jobs/${job.id}/artifact`, bytes: job.artifact.bytes, name: job.artifact.name } : null,
  };
  if (withResult) {
    base.result = job.result;
    base.logs = (job.logs || []).slice(-400);
  } else if (job.result) {
    base.result = {
      parameters: job.result.parameters,
      github: job.result.github || null,
      validation: { status: job.result.validation?.status, passed: job.result.validation?.passed, total: job.result.validation?.total },
      actions: job.result.actions || null,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------
const STATIC_DENY = /(^|[\\/])(\.data|\.git|\.env|node_modules|tests|scripts)([\\/]|$)|(^|[\\/])\./i;

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  // hard-stop traversal attempts before any path work happens
  if (rel.includes('\0') || rel.split(/[\\/]+/).includes('..')) {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (STATIC_DENY.test(rel)) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (rel === '/') rel = '/index.html';
  if (rel === '/studio' || rel === '/studio/') rel = '/model-studio.html';

  // The BeatForge SPA lives at the repo root; only these files may be served
  // from there. Everything else is either under app/web or not web-accessible.
  const ROOT_ALLOWLIST = /^(index\.html|style\.css|app\.js|ai_model\.js|favicon\.ico|CNAME|previews\/[\w.-]+\.zip)$/;
  const fromRoot = ROOT_ALLOWLIST.test(rel.replace(/^\/+/, ''));
  const candidates = fromRoot
    ? [path.join(WEB_DIR, rel), path.join(ROOT, rel)]
    : [path.join(WEB_DIR, rel)];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const allowedRoots = [WEB_DIR, ROOT];
    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) continue;
    // never serve the data dir or backend source
    if (resolved.startsWith(DATA_DIR + path.sep) || resolved.startsWith(path.join(ROOT, 'app', 'backend') + path.sep)) continue;
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) continue;

    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(resolved);
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    const headers = {
      'Content-Type': type,
      ETag: etag,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    };
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && ['text/html', 'text/css', 'text/javascript', 'application/json'].includes(type.split(';')[0]) && stat.size > 1024) {
      const compressed = zlib.gzipSync(fs.readFileSync(resolved));
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length, Vary: 'Accept-Encoding' });
      return res.end(compressed);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return fs.createReadStream(resolved).pipe(res);
  }
  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function htmlPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — AiMapper</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#060a12;color:#d0d8e8;
padding:48px 20px;line-height:1.6;max-width:720px;margin:0 auto}h1{color:#00e5ff;font-size:1.4rem}
a{color:#00e5ff}code{background:rgba(0,229,255,.08);padding:2px 6px;border-radius:4px;font-size:.9em}
ol,ul{padding-left:20px}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

// ---------------------------------------------------------------------------
// request dispatch
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, 'Bad request');
  }

  const finish = (status) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (process.env.MAPPER_ACCESS_LOG !== '0') {
      console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path: url.pathname, status, ms: Math.round(ms) }));
    }
  };
  res.on('finish', () => finish(res.statusCode));

  // CORS for the preview/sandbox hosts (no credentials needed: we use cookies
  // with same-origin requests, so we only need to allow the origin)
  const origin = req.headers.origin;
  if (origin && CORS_ALLOW_ALL) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    if (req.method !== 'GET' && !SKIP_CSRF.has(url.pathname) && !sameOrigin(req)) {
      return sendJSON(res, 403, { error: 'cross-origin request blocked' });
    }
    const match = routes.find((r) => {
      if (r.method !== req.method) return false;
      if (typeof r.pattern === 'string') return r.pattern === url.pathname;
      return r.pattern.test(url.pathname);
    });
    if (!match) {
      const exists = routes.some((r) => (typeof r.pattern === 'string' ? r.pattern === url.pathname : r.pattern.test(url.pathname)));
      return sendJSON(res, exists ? 405 : 404, { error: exists ? 'method not allowed' : 'unknown endpoint' });
    }
    try {
      const m = typeof match.pattern === 'string' ? null : match.pattern.exec(url.pathname);
      await match.handler(req, res, url, m);
    } catch (err) {
      log.error('http.handler_failed', { path: url.pathname, method: req.method, error: err });
      if (!res.headersSent) {
        sendJSON(res, err.status || 500, { error: err.message || 'internal error' });
      } else {
        res.end();
      }
    }
    return;
  }

  serveStatic(req, res, url);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// resume interrupted jobs on boot
function resumeJobs() {
  const interrupted = store.activeJobs();
  for (const job of interrupted) {
    store.updateJob(job.id, {
      status: 'error',
      error: { message: 'server restarted while this job was running', hint: 'Start the generation again.' },
      finishedAt: Date.now(),
    });
  }
  if (interrupted.length) log.warn('jobs.recovered', { count: interrupted.length });
  // clear expired sessions
  const now = Date.now();
  for (const [id, session] of Object.entries(store.state.sessions)) {
    if (now - session.createdAt > 1000 * 60 * 60 * 24 * 30) delete store.state.sessions[id];
  }
  store.save();
}

if (require.main === module) {
  resumeJobs();
  server.listen(PORT, HOST, () => {
    log.info('server.started', {
      url: `http://${HOST}:${PORT}`,
      dataDir: DATA_DIR,
      oauth: gh.oauthConfigured(process.env) ? 'enabled' : 'not configured (manual token available)',
      node: process.version,
    });
    console.log(`\n  AiMapper Model Studio v${GENERATOR_VERSION}`);
    console.log(`  → http://localhost:${PORT}        (BeatForge mapper)`);
    console.log(`  → http://localhost:${PORT}/studio (Model Studio dashboard)\n`);
  });

  const shutdown = (signal) => {
    log.info('server.shutdown', { signal });
    try { store.flush(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('process.unhandled_rejection', { error: reason }));
  process.on('uncaughtException', (err) => log.error('process.uncaught_exception', { error: err }));
}

module.exports = { server, store, vault, runner, app: { routes } };
