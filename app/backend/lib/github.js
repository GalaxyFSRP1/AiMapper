'use strict';
/* GitHub integration: OAuth (web flow + PKCE, supports expiring user tokens
   and refresh) and a REST client with retry/backoff.

   Tokens live only on the server: they are sealed by lib/vault.js and are
   never included in any response body returned to the browser.
*/

const crypto = require('node:crypto');
const { log } = require('../logger');

const API = process.env.GITHUB_API_BASE || 'https://api.github.com';
const OAUTH_AUTHORIZE = process.env.GITHUB_OAUTH_AUTHORIZE || 'https://github.com/login/oauth/authorize';
const OAUTH_TOKEN = process.env.GITHUB_OAUTH_TOKEN_URL || 'https://github.com/login/oauth/access_token';
const SCOPES = ['repo', 'workflow'];

class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function oauthConfigured(env) {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new GitHubError(`OAuth exchange failed: ${json.error_description || json.error || res.status}`, res.status, json);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresIn: json.expires_in || null,
    refreshTokenExpiresIn: json.refresh_token_expires_in || null,
    scope: json.scope || SCOPES.join(' '),
    tokenType: json.token_type || 'bearer',
  };
}

async function refreshToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new GitHubError(`Token refresh failed: ${json.error_description || json.error || res.status}`, res.status, json);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresIn: json.expires_in || null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GitHubClient {
  /**
   * @param {string} token
   * @param {{userAgent?: string, onRateLimit?: Function}} [opts]
   */
  constructor(token, opts = {}) {
    if (!token) throw new GitHubError('Missing GitHub access token', 401, null);
    this.token = token;
    this.userAgent = opts.userAgent || 'AiMapper-Model-Studio';
    this.onTokenRefresh = opts.onTokenRefresh || null;
  }

  async request(method, path, body, { retries = 3, raw = false, accept } = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: accept || 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': this.userAgent,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt++ < retries) { await sleep(400 * attempt); continue; }
        throw new GitHubError(`Network error calling GitHub: ${err.message}`, 0, null);
      }

      if (res.status === 204) return raw ? res : {};
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

      if (res.status === 401 && this.onTokenRefresh && attempt === 0) {
        attempt++;
        const fresh = await this.onTokenRefresh();
        if (fresh) { this.token = fresh; continue; }
      }

      if (res.ok) return raw ? res : json;

      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504 ||
        (res.status === 403 && /rate limit|secondary/i.test(text));
      if (retryable && attempt < retries) {
        const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
        const waitMs = Math.min(8000, Math.max(700, reset ? reset - Date.now() : 0)) * (attempt + 1);
        log.warn('github.rate_limited', { status: res.status, waitMs, path });
        await sleep(waitMs);
        attempt++;
        continue;
      }

      throw new GitHubError(
        `GitHub API ${method} ${path} failed (${res.status}): ${json?.message || text.slice(0, 240)}`,
        res.status,
        json
      );
    }
  }

  // ---- identity ---------------------------------------------------------
  me() { return this.request('GET', '/user'); }
  listRepos() { return this.request('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator'); }
  getRepo(owner, repo) { return this.request('GET', `/repos/${owner}/${repo}`); }

  async createRepo({ name, description, isPrivate }) {
    return this.request('POST', '/user/repos', {
      name,
      description,
      private: Boolean(isPrivate),
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    });
  }

  // ---- git data ---------------------------------------------------------
  async getRepoMeta(owner, repo) {
    return this.getRepo(owner, repo);
  }

  async getBranchHead(owner, repo, branch) {
    try {
      const ref = await this.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      return ref.object.sha;
    } catch (err) {
      if (err.status === 404) return null; // empty repository
      throw err;
    }
  }

  async createBlob(owner, repo, contentBase64) {
    const blob = await this.request('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: contentBase64,
      encoding: 'base64',
    });
    return blob.sha;
  }

  async createTree(owner, repo, entries, baseTree) {
    const tree = await this.request('POST', `/repos/${owner}/${repo}/git/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries,
    });
    return tree.sha;
  }

  async createCommit(owner, repo, { message, tree, parents, author }) {
    const commit = await this.request('POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree,
      parents,
      ...(author ? { author } : {}),
    });
    return commit.sha;
  }

  async updateBranch(owner, repo, branch, sha, { force = false } = {}) {
    return this.request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force });
  }

  async createBranch(owner, repo, branch, sha) {
    return this.request('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  /** Upload a batch of files as ONE atomic commit. */
  async commitFiles(owner, repo, { branch = 'main', files, message, author }) {
    if (!files.length) throw new GitHubError('commitFiles: no files given', 400, null);

    const headSha = await this.getBranchHead(owner, repo, branch);
    if (!headSha) {
      // Fresh/empty repo: create the branch at the first commit.
      const treeEntries = [];
      for (const file of files) {
        const sha = await this.createBlob(owner, repo, toBase64(file.content));
        treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha });
      }
      const treeSha = await this.createTree(owner, repo, treeEntries, null);
      const commitSha = await this.createCommit(owner, repo, { message, tree: treeSha, parents: [], author });
      await this.createBranch(owner, repo, branch, commitSha);
      return { commitSha, treeSha, files: files.length, branch, baseSha: null };
    }

    let baseCommit;
    try {
      baseCommit = await this.request('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
    } catch {
      baseCommit = { tree: { sha: null } };
    }

    const treeEntries = [];
    for (const file of files) {
      const sha = await this.createBlob(owner, repo, toBase64(file.content));
      treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha });
    }
    const treeSha = await this.createTree(owner, repo, treeEntries, baseCommit.tree?.sha || null);
    const commitSha = await this.createCommit(owner, repo, { message, tree: treeSha, parents: [headSha], author });
    await this.updateBranch(owner, repo, branch, commitSha);
    return { commitSha, treeSha, files: files.length, branch, baseSha: headSha };
  }

  // ---- contents ---------------------------------------------------------
  async getFile(owner, repo, path, ref) {
    try {
      const data = await this.request(
        'GET',
        `/repos/${owner}/${repo}/contents/${encodeURI(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
      );
      if (!data || Array.isArray(data)) return null;
      return { content: Buffer.from(data.content || '', 'base64').toString('utf8'), sha: data.sha, size: data.size };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async listDir(owner, repo, path) {
    try {
      const data = await this.request('GET', `/repos/${owner}/${repo}/contents/${encodeURI(path)}`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  // ---- actions ----------------------------------------------------------
  async dispatchWorkflow(owner, repo, workflowFile, inputs = {}, ref = 'main') {
    return this.request('POST', `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`, {
      ref,
      inputs,
    });
  }

  async listWorkflowRuns(owner, repo, workflowFile, perPage = 5) {
    const data = await this.request(
      'GET',
      `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=${perPage}`
    );
    return data.workflow_runs || [];
  }

  async getWorkflowRun(owner, repo, runId) {
    return this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`);
  }

  async listJobsForRun(owner, repo, runId) {
    const data = await this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
    return data.jobs || [];
  }

  async checkRunsForCommit(owner, repo, ref) {
    const data = await this.request('GET', `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=50`, null, {
      accept: 'application/vnd.github+json',
    });
    return data.check_runs || [];
  }

  async listTags(owner, repo, perPage = 10) {
    try {
      return await this.request('GET', `/repos/${owner}/${repo}/tags?per_page=${perPage}`);
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  async createRelease(owner, repo, { tag, name, body, target }) {
    return this.request('POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      name,
      body,
      target_commitish: target,
    });
  }

  async listCommits(owner, repo, perPage = 10) {
    return this.request('GET', `/repos/${owner}/${repo}/commits?per_page=${perPage}`);
  }
}

function toBase64(content) {
  if (Buffer.isBuffer(content)) return content.toString('base64');
  if (content instanceof Uint8Array) return Buffer.from(content).toString('base64');
  return Buffer.from(String(content), 'utf8').toString('base64');
}

module.exports = {
  GitHubClient,
  GitHubError,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  oauthConfigured,
  pkcePair,
  SCOPES,
  toBase64,
};
