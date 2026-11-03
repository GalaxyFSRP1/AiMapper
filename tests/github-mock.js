'use strict';
/* In-process mock of the GitHub REST endpoints Model Studio uses.
   Used by tests/github.test.js to exercise the real publishing code path. */

const http = require('node:http');
const crypto = require('node:crypto');

function startMock({ existingRepo = null } = {}) {
  const store = {
    repos: new Map(),          // fullName -> repo
    blobs: new Map(),          // sha -> base64
    trees: new Map(),          // sha -> entries
    commits: new Map(),        // sha -> commit
    refs: new Map(),           // branch -> sha
    contents: new Map(),       // `${repo}:${path}` -> text
    dispatches: [],
    releases: [],
    user: { login: 'test-user', id: 4242, name: 'Test User', avatar_url: '' },
    token: 'ghp_' + 'a'.repeat(30),
  };
  if (existingRepo) {
    store.repos.set(existingRepo, {
      name: existingRepo.split('/')[1],
      full_name: existingRepo,
      owner: { login: existingRepo.split('/')[0], type: 'User' },
      private: false,
      default_branch: 'main',
      html_url: `https://github.com/${existingRepo}`,
      permissions: { push: true },
    });
  }

  const sha = (data) => crypto.createHash('sha1').update(data).digest('hex');
  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const auth = req.headers.authorization || '';
      if (!auth.includes(store.token)) return json(res, 401, { message: 'Bad credentials' });

      // ---- identity ----
      if (p === '/user' && req.method === 'GET') return json(res, 200, store.user);

      if (p === '/user/repos' && req.method === 'GET') {
        return json(res, 200, [...store.repos.values()]);
      }

      if (p === '/user/repos' && req.method === 'POST') {
        const full = `${store.user.login}/${body.name}`;
        if (store.repos.has(full)) return json(res, 422, { message: 'name already exists on this account' });
        const repo = {
          name: body.name, full_name: full, private: Boolean(body.private),
          owner: { login: store.user.login, type: 'User' },
          default_branch: 'main', html_url: `https://github.com/${full}`, permissions: { push: true },
          updated_at: new Date().toISOString(),
        };
        store.repos.set(full, repo);
        return json(res, 201, repo);
      }

      const repoMatch = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (!repoMatch) return json(res, 404, { message: 'Not Found' });
      const full = `${repoMatch[1]}/${repoMatch[2]}`;
      const rest = repoMatch[3] || '';
      const repo = store.repos.get(full);
      if (!repo) return json(res, 404, { message: 'Not Found' });

      // ---- repo meta ----
      if (rest === '' && req.method === 'GET') return json(res, 200, repo);

      // ---- git data ----
      if (rest === '/git/blobs' && req.method === 'POST') {
        const id = sha(Buffer.from(body.content, 'base64'));
        store.blobs.set(id, body.content);
        return json(res, 201, { sha: id });
      }

      if (rest === '/git/trees' && req.method === 'POST') {
        const id = sha(JSON.stringify(body.tree) + (body.base_tree || ''));
        const base = body.base_tree ? store.trees.get(body.base_tree) || [] : [];
        const merged = new Map(base.map((e) => [e.path, e]));
        for (const entry of body.tree) merged.set(entry.path, entry);
        store.trees.set(id, [...merged.values()]);
        return json(res, 201, { sha: id, tree: [...merged.values()] });
      }

      if (rest === '/git/commits' && req.method === 'POST') {
        const id = sha(body.message + body.tree + (body.parents || []).join(','));
        const commit = { sha: id, message: body.message, tree: { sha: body.tree }, parents: (body.parents || []).map((s) => ({ sha: s })) };
        store.commits.set(id, commit);
        return json(res, 201, commit);
      }

      const commitMatch = rest.match(/^\/git\/commits\/([a-f0-9]+)$/);
      if (commitMatch && req.method === 'GET') {
        const commit = store.commits.get(commitMatch[1]);
        if (!commit) return json(res, 404, { message: 'Not Found' });
        return json(res, 200, commit);
      }

      const refMatch = rest.match(/^\/git\/ref\/heads\/(.+)$/);
      if (refMatch && req.method === 'GET') {
        const branch = decodeURIComponent(refMatch[1]);
        const target = store.refs.get(branch);
        if (!target) return json(res, 404, { message: 'Not Found' });
        return json(res, 200, { ref: `refs/heads/${branch}`, object: { sha: target } });
      }

      if (rest === '/git/refs' && req.method === 'POST') {
        const branch = body.ref.replace('refs/heads/', '');
        store.refs.set(branch, body.sha);
        return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
      }

      const refPatch = rest.match(/^\/git\/refs\/heads\/(.+)$/);
      if (refPatch && req.method === 'PATCH') {
        const branch = decodeURIComponent(refPatch[1]);
        store.refs.set(branch, body.sha);
        return json(res, 200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } });
      }

      // ---- contents ----
      const contentMatch = rest.match(/^\/contents\/(.+)$/);
      if (contentMatch && req.method === 'GET') {
        const path = decodeURIComponent(contentMatch[1]);
        const value = store.contents.get(`${full}:${path}`);
        if (value === undefined) return json(res, 404, { message: 'Not Found' });
        return json(res, 200, {
          name: path.split('/').pop(), path, sha: sha(value), size: value.length,
          content: Buffer.from(value, 'utf8').toString('base64'), encoding: 'base64', type: 'file',
        });
      }

      // ---- actions ----
      if (rest === '/actions/workflows' && req.method === 'GET') {
        return json(res, 200, {
          total_count: 2,
          workflows: [
            { id: 1, name: 'Validation', path: '.github/workflows/validate.yml', state: 'active' },
            { id: 2, name: 'Model check', path: '.github/workflows/model-check.yml', state: 'active' },
          ],
        });
      }

      const dispatchMatch = rest.match(/^\/actions\/workflows\/(.+)\/dispatches$/);
      if (dispatchMatch && req.method === 'POST') {
        const file = decodeURIComponent(dispatchMatch[1]);
        store.dispatches.push({ repo: full, file, inputs: body.inputs || {}, ref: body.ref });
        return json(res, 204, {});
      }

      const runsMatch = rest.match(/^\/actions\/workflows\/(.+)\/runs$/);
      if (runsMatch && req.method === 'GET') {
        const file = decodeURIComponent(runsMatch[1]);
        const dispatched = store.dispatches.filter((d) => d.file === file);
        if (!dispatched.length) return json(res, 200, { total_count: 0, workflow_runs: [] });
        return json(res, 200, {
          total_count: 1,
          workflow_runs: [{
            id: 918273,
            name: 'Model check',
            status: 'queued',
            conclusion: null,
            html_url: `https://github.com/${full}/actions/runs/918273`,
            created_at: new Date().toISOString(),
          }],
        });
      }

      if (/^\/actions\/runs\/\d+\/jobs$/.test(rest)) {
        return json(res, 200, { total_count: 1, jobs: [{ id: 5, name: 'check', status: 'queued', conclusion: null, steps: [] }] });
      }

      if (rest === '/releases' && req.method === 'POST') {
        store.releases.push(body);
        return json(res, 201, { id: 1, ...body });
      }

      if (rest === '/tags') return json(res, 200, []);

      return json(res, 404, { message: `mock: unhandled ${req.method} ${p}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}`, store, stop: () => server.close() });
    });
  });
}

module.exports = { startMock };
