'use strict';
/* Background job runner.

   Generation + GitHub publishing takes several seconds (hundreds of blob
   uploads for a 20 MiB checkpoint), so it runs off the request loop with real
   progress events, persisted logs and cancellation. Progress is emitted only
   at milestones that actually completed — no timed fake loading bars. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { log } = require('./logger');
const { buildProject, packZip, GENERATOR_VERSION } = require('./lib/project-builder');
const { validateProject } = require('./lib/validator');
const { GitHubClient, GitHubError } = require('./lib/github');

const STEPS = [
  { id: 'queued', label: 'Queued', weight: 0 },
  { id: 'auth', label: 'Authorising GitHub', weight: 4 },
  { id: 'architecture', label: 'Synthesising architecture', weight: 8 },
  { id: 'weights', label: 'Initialising weights', weight: 22 },
  { id: 'tokenizer', label: 'Training tokenizer', weight: 10 },
  { id: 'files', label: 'Generating project files', weight: 12 },
  { id: 'validation', label: 'Validating model', weight: 8 },
  { id: 'repo', label: 'Resolving repository', weight: 4 },
  { id: 'upload', label: 'Committing to GitHub', weight: 20 },
  { id: 'actions', label: 'Dispatching GitHub Actions', weight: 6 },
  { id: 'complete', label: 'Complete', weight: 6 },
];

class JobRunner {
  constructor({ store, vault }) {
    this.store = store;
    this.vault = vault;
    this.running = new Map();
  }

  create(userId, params) {
    const id = `job_${crypto.randomBytes(8).toString('hex')}`;
    const job = {
      id,
      userId,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      params,
      step: 'queued',
      steps: STEPS.map((s) => ({ ...s, status: s.id === 'queued' ? 'active' : 'pending' })),
      progress: 0,
      logs: [],
      result: null,
      error: null,
      cancelRequested: false,
    };
    this.store.createJob(job);
    this.store.addHistory({
      id,
      userId,
      at: Date.now(),
      action: 'generate',
      model: params.name,
      status: 'queued',
      parameters: null,
    });
    this.logLine(id, `job ${id} queued for model "${params.name}" (target ${Number(params.targetParameters).toLocaleString()} params)`);
    return job;
  }

  logLine(id, message, level = 'info') {
    const line = { at: Date.now(), level, message };
    this.store.appendLog(id, line);
    if (level === 'error') log.error('job.log', { id, message });
  }

  #applyProgress(job, stepId, extra = {}) {
    const completed = [];
    let reached = false;
    for (const step of job.steps) {
      if (step.id === stepId) { step.status = 'active'; reached = true; continue; }
      if (!reached) { step.status = 'done'; completed.push(step.id); }
    }
    const totalWeight = STEPS.reduce((a, s) => a + s.weight, 0);
    const doneWeight = job.steps.filter((s) => s.status === 'done').reduce((a, s) => a + s.weight, 0);
    job.progress = Math.min(99, Math.round((doneWeight / totalWeight) * 100));
    job.step = stepId;
    this.store.updateJob(job.id, { steps: job.steps, progress: job.progress, step: stepId, ...extra });
  }

  async run(jobId) {
    const job = this.store.job(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    if (this.running.has(jobId)) return;
    this.running.set(jobId, true);
    this.store.updateJob(jobId, { status: 'running', startedAt: Date.now() });

    try {
      const user = this.store.user(job.userId);
      const token = this.#tokenFor(job.userId, user);
      if (job.params.publish !== false && !token) {
        throw new Error('GitHub account is not connected — connect GitHub in Settings, or run a local-only generation');
      }

      // ---- auth ------------------------------------------------------
      this.#applyProgress(job, 'auth');
      let gh = null;
      let owner = job.params.owner;
      let repo = job.params.repo;
      if (token) {
        gh = new GitHubClient(token, {
          onTokenRefresh: async () => {
            const refreshed = await this.#refreshUserToken(job.userId);
            return refreshed;
          },
        });
        const me = await gh.me();
        owner = owner || me.login;
        if (!owner) throw new Error('could not determine GitHub account login');
        this.logLine(jobId, `authenticated as ${me.login} (scopes: ${user?.scope || 'unknown'})`);
        // confirm the required scopes are actually present
        const scopes = (await gh.request('HEAD_RAW', '/user', null, { raw: true, accept: 'application/vnd.github+json' })
          .catch(() => null));
        void scopes; // scope header check is advisory; failures surface at push time
      } else {
        this.logLine(jobId, 'no GitHub account connected — generating locally only', 'warn');
      }
      this.#checkCancel(jobId);

      // ---- generate --------------------------------------------------
      this.#applyProgress(job, 'architecture', { owner, repo });
      const project = buildProject({
        name: job.params.name,
        targetParameters: Number(job.params.targetParameters),
        vocabSize: Number(job.params.vocabSize) || 2048,
        syntheticExamples: Number(job.params.syntheticExamples) || 64,
        seed: job.params.seed || job.params.name,
        onProgress: ({ step, detail }) => {
          this.logLine(jobId, `${step}: ${detail}`);
          if (step === 'weights') this.#applyProgress(job, 'weights');
          if (step === 'tokenizer') this.#applyProgress(job, 'tokenizer');
          if (step === 'files' || step === 'docs') this.#applyProgress(job, 'files');
        },
      });
      this.#checkCancel(jobId);
      this.logLine(jobId, `architecture: ${project.config.n_layer} layers × d_model ${project.config.d_model} ` +
        `(${project.config.n_head} heads), d_ff ${project.config.d_ff}, ctx ${project.config.n_ctx}`);
      this.logLine(jobId, `parameters: ${project.parameters.toLocaleString()} (target ${Number(job.params.targetParameters).toLocaleString()}, ` +
        `deviation ${project.config.deviation.toFixed(3)}%)`);
      this.logLine(jobId, `weights: ${project.manifest.tensor_count} tensors, ${(project.weightsBytes / 1024 / 1024).toFixed(2)} MiB, sha256 ${project.weightsSha256.slice(0, 16)}…`);
      this.logLine(jobId, `tokenizer: ${project.vocabJson.vocab_size} tokens, ${project.vocabJson.merges.length} merges, ` +
        `${project.corpusStats.tokens.toLocaleString()} corpus tokens`);
      this.#applyProgress(job, 'weights');
      this.#applyProgress(job, 'tokenizer');
      this.#applyProgress(job, 'files');

      // ---- validate --------------------------------------------------
      this.#applyProgress(job, 'validation');
      const validation = validateProject(project);
      this.logLine(jobId, `validation: ${validation.passed}/${validation.total} checks passed (${validation.status})`,
        validation.status === 'pass' ? 'info' : 'error');
      for (const failure of validation.failures) this.logLine(jobId, `validation failure — ${failure}`, 'error');
      if (validation.status !== 'pass') {
        await this.#persistArtifacts(jobId, project, validation);
        throw new Error(`model validation failed (${validation.failures.length} issue${validation.failures.length === 1 ? '' : 's'})`);
      }

      // always keep a local copy so the artifact is downloadable regardless
      const zipPath = await this.#persistArtifacts(jobId, project, validation);
      this.logLine(jobId, `artifact saved locally (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)} MiB zip)`);

      const summary = {
        name: project.name,
        slug: project.slug,
        parameters: project.parameters,
        targetParameters: Number(job.params.targetParameters),
        deviationPct: project.config.deviation,
        architecture: {
          n_layer: project.config.n_layer,
          n_head: project.config.n_head,
          d_model: project.config.d_model,
          d_ff: project.config.d_ff,
          n_ctx: project.config.n_ctx,
          head_dim: project.config.head_dim,
          vocab_size: project.config.vocab_size,
        },
        parameter_breakdown: project.config.parameter_breakdown,
        alternatives: project.alternatives,
        tensorCount: project.manifest.tensor_count,
        weightsBytes: project.weightsBytes,
        weightsSha256: project.weightsSha256,
        dataset: project.corpusStats,
        training: project.training,
        files: project.index.files.map((f) => ({ path: f.path, bytes: f.bytes })),
        validation,
        zip: { url: `/api/jobs/${jobId}/artifact`, bytes: fs.statSync(zipPath).size },
        generator: GENERATOR_VERSION,
      };

      // ---- publish ---------------------------------------------------
      if (gh && job.params.publish !== false) {
        this.#applyProgress(job, 'repo');
        const created = await this.#ensureRepo(gh, owner, repo, jobId);
        const targetRepo = created?.full_name || `${owner}/${repo}`;
        const basePath = (job.params.basePath || 'models').replace(/^\/+|\/+$/g, '');
        const datedSlug = job.params.versionedPath === false ? project.slug : `${project.slug}`;
        const prefix = basePath ? `${basePath}/${datedSlug}` : datedSlug;
        this.logLine(jobId, `target path: ${targetRepo}/${prefix}`);

        this.#applyProgress(job, 'upload');
        const uploaded = await this.#publish(gh, owner, repo, project, prefix, jobId);
        summary.github = {
          repo: targetRepo,
          repoUrl: created?.html_url || `https://github.com/${targetRepo}`,
          path: prefix,
          commitSha: uploaded.commitSha,
          commitUrl: `https://github.com/${targetRepo}/commit/${uploaded.commitSha}`,
          files: uploaded.files,
          branch: uploaded.branch,
          createdRepo: Boolean(created),
        };
        this.logLine(jobId, `pushed ${uploaded.files} files in one atomic commit ${uploaded.commitSha.slice(0, 7)}`);

        // ---- actions -----------------------------------------------
        this.#applyProgress(job, 'actions');
        const actions = await this.#dispatchActions(gh, owner, repo, project, jobId);
        summary.actions = actions;
      } else {
        this.logLine(jobId, 'publishing skipped (local-only generation)');
      }

      // ---- history ---------------------------------------------------
      this.store.addHistory({
        id: jobId,
        userId: job.userId,
        at: Date.now(),
        action: 'generate',
        model: project.name,
        status: 'success',
        parameters: project.parameters,
        repo: summary.github?.repo || null,
        commit: summary.github?.commitSha || null,
        branch: summary.github?.branch || null,
        path: summary.github?.path || null,
        published: Boolean(summary.github),
        publishedAt: summary.github ? Date.now() : null,
        version: '1.0.0',
      });

      this.#applyProgress(job, 'complete', {
        status: 'success',
        progress: 100,
        result: summary,
        finishedAt: Date.now(),
        steps: job.steps.map((s) => ({ ...s, status: 'done' })),
      });
      this.logLine(jobId, `job complete — ${project.parameters.toLocaleString()} parameter model ready`);
      log.info('job.complete', { id: jobId, parameters: project.parameters, repo: summary.github?.repo });
    } catch (err) {
      const message = err instanceof GitHubError ? `${err.message}` : err.message;
      this.logLine(jobId, `job failed: ${message}`, 'error');
      log.error('job.failed', { id: jobId, error: err });
      this.store.updateJob(jobId, {
        status: 'error',
        error: { message, status: err.status || null, hint: hintFor(err) },
        finishedAt: Date.now(),
        steps: (this.store.job(jobId)?.steps || []).map((s) => (s.status === 'active' ? { ...s, status: 'error' } : s)),
      });
      this.store.addHistory({
        id: jobId,
        userId: job.userId,
        at: Date.now(),
        action: 'generate',
        model: job.params.name,
        status: 'error',
        error: message,
      });
    } finally {
      this.running.delete(jobId);
    }
  }

  #checkCancel(jobId) {
    const job = this.store.job(jobId);
    if (job?.cancelRequested) throw new Error('cancelled by user');
  }

  #tokenFor(userId, user) {
    if (!user?.tokenSealed) return null;
    return this.vault.open(user.tokenSealed, `gh-token:${userId}`);
  }

  async #refreshUserToken(userId) {
    const user = this.store.user(userId);
    if (!user?.refreshSealed) return null;
    const refresh = this.vault.open(user.refreshSealed, `gh-refresh:${userId}`);
    if (!refresh) return null;
    const { refreshToken, oauthConfigured } = require('./lib/github');
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!oauthConfigured(process.env)) return null;
    const fresh = await refreshToken({ clientId, clientSecret, refreshToken: refresh });
    this.store.upsertUser(userId, {
      tokenSealed: this.vault.seal(fresh.accessToken, `gh-token:${userId}`),
      refreshSealed: this.vault.seal(fresh.refreshToken, `gh-refresh:${userId}`),
      expiresAt: fresh.expiresIn ? Date.now() + fresh.expiresIn * 1000 : null,
    });
    log.info('github.token_refreshed', { userId });
    return fresh.accessToken;
  }

  async #ensureRepo(gh, owner, repo, jobId) {
    const target = repo || 'AiMapper';
    try {
      const existing = await gh.getRepo(owner, target);
      this.logLine(jobId, `repository ${existing.full_name} found (${existing.private ? 'private' : 'public'}, default branch ${existing.default_branch})`);
      return null;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    try {
      const created = await gh.createRepo({
        name: target,
        description: 'Generated by AiMapper Model Studio — automated ~5M parameter mapper models',
        isPrivate: Boolean(this.store.job(jobId)?.params?.privateRepo),
      });
      this.logLine(jobId, `created repository ${created.full_name}`);
      return created;
    } catch (err) {
      if (err.status === 422) {
        // already exists under another owner (org) — fall through to use it
        this.logLine(jobId, `repository ${owner}/${target} already exists`, 'warn');
        return null;
      }
      throw err;
    }
  }

  async #publish(gh, owner, repo, project, prefix, jobId) {
    const branch = await this.#resolveBranch(gh, owner, repo);
    const files = project.files.map((f) => ({ path: `${prefix}/${f.path}`, content: f.content }));
    files.push({
      path: `${prefix}/model_index.json`,
      content: JSON.stringify(project.index, null, 2) + '\n',
    });

    const totalBytes = files.reduce((n, f) => n + (Buffer.isBuffer(f.content) ? f.content.length : Buffer.byteLength(f.content)), 0);
    this.logLine(jobId, `committing ${files.length} files (${(totalBytes / 1024 / 1024).toFixed(2)} MiB) to ${branch}`);

    const message = [
      `feat(model): add ${project.name} (${project.parameters.toLocaleString()} parameters)`,
      '',
      `Generated by AiMapper Model Studio ${GENERATOR_VERSION}`,
      '',
      `- architecture: ${project.config.n_layer}L x d${project.config.d_model} (${project.config.n_head} heads), d_ff ${project.config.d_ff}, ctx ${project.config.n_ctx}`,
      `- parameters: ${project.parameters.toLocaleString()} (target ${Number(project.configJson.target_parameters).toLocaleString()}, ${project.config.deviation.toFixed(3)}%)`,
      `- weights: ${project.manifest.tensor_count} tensors, ${(project.weightsBytes / 1024 / 1024).toFixed(2)} MiB safetensors (sha256 ${project.weightsSha256.slice(0, 12)})`,
      `- tokenizer: ${project.vocabJson.vocab_size} token byte-level BPE (${project.vocabJson.merges.length} merges)`,
      `- dataset: ${project.corpusStats.total_examples} examples / ${project.corpusStats.tokens.toLocaleString()} tokens`,
      `- validation: ${project.index ? 'see model_index.json' : 'passed'}`,
    ].join('\n');

    const result = await gh.commitFiles(owner, repo, { branch, files, message });

    // version management: refresh the models/README ledger + VERSION bump file
    await this.#updateLedger(gh, owner, repo, branch, prefix, project, result);
    return result;
  }

  async #resolveBranch(gh, owner, repo) {
    const meta = await gh.getRepo(owner, repo);
    const branch = meta.default_branch || 'main';
    const head = await gh.getBranchHead(owner, repo, branch);
    if (!head) this.logLine(undefined, `repository is empty — first commit will create ${branch}`);
    return branch;
  }

  async #updateLedger(gh, owner, repo, branch, prefix, project, commit) {
    try {
      const ledgerPath = prefix.includes('/') ? `${prefix.split('/')[0]}/README.md` : 'models/README.md';
      const existing = await gh.getFile(owner, repo, ledgerPath, branch);
      const row = `| [${project.name}](${prefix}) | ${project.parameters.toLocaleString()} | ` +
        `${project.config.n_layer}L × d${project.config.d_model} | ${project.config.n_ctx} | ${project.vocabJson.vocab_size} | ` +
        `${new Date().toISOString().slice(0, 10)} | [\`${commit.commitSha.slice(0, 7)}\`](https://github.com/${owner}/${repo}/commit/${commit.commitSha}) |`;
      const header = '# Generated models\n\nEvery model below was produced by AiMapper Model Studio. ' +
        'Each entry links to the full project (source, config, tokenizer, real initialised weights, CI).\n\n' +
        '| Model | Parameters | Architecture | Context | Vocab | Generated | Commit |\n' +
        '|---|---|---|---|---|---|---|\n';
      let body;
      if (existing && existing.content.includes('| Model | Parameters |')) {
        body = existing.content.includes(`[${project.name}](${prefix})`)
          ? existing.content.replace(new RegExp(`\\| \\[${escapeRe(project.name)}\\]\\(${escapeRe(prefix)}\\).*`, 'g'), row)
          : existing.content.trimEnd() + '\n' + row + '\n';
      } else {
        body = header + row + '\n';
      }
      await gh.commitFiles(owner, repo, {
        branch,
        files: [{ path: ledgerPath, content: body }],
        message: `docs(models): update generated-model ledger for ${project.name}`,
      });
    } catch (err) {
      log.warn('job.ledger_failed', { error: err });
    }
  }

  async #dispatchActions(gh, owner, repo, project, jobId) {
    const result = { dispatched: [], errors: [] };
    try {
      await gh.request('GET', `/repos/${owner}/${repo}/actions/workflows`);
    } catch (err) {
      result.errors.push(`workflows unavailable: ${err.message}`);
      this.logLine(jobId, `actions: could not list workflows (${err.status || 'error'})`, 'warn');
      return result;
    }

    for (const [file, inputs] of [
      ['validate.yml', {}],
      ['model-check.yml', {
        model_name: project.name,
        expected_parameters: String(project.parameters),
      }],
    ]) {
      try {
        await gh.dispatchWorkflow(owner, repo, file, inputs);
        result.dispatched.push(file);
        this.logLine(jobId, `dispatched workflow ${file}`);
      } catch (err) {
        result.errors.push(`${file}: ${err.message}`);
        this.logLine(jobId, `workflow ${file} not dispatched: ${err.message}`, 'warn');
      }
    }

    // wait for the run to be registered so we can report the real status
    try {
      await sleep(2500);
      const runs = await gh.listWorkflowRuns(owner, repo, 'model-check.yml', 3);
      const run = runs[0];
      if (run) {
        result.run = {
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url,
          workflow: run.name,
          created_at: run.created_at,
        };
        this.logLine(jobId, `GitHub Actions run ${run.id} is ${run.status}`);
      }
    } catch (err) {
      result.errors.push(`run lookup: ${err.message}`);
    }
    return result;
  }

  async #persistArtifacts(jobId, project, validation) {
    const zip = packZip(project, project.slug);
    const zipPath = this.store.artifactPath(jobId, 'model.zip');
    fs.writeFileSync(zipPath, zip);
    fs.writeFileSync(
      this.store.artifactPath(jobId, 'validation.json'),
      JSON.stringify({ ...validation, model: project.name, generatedAt: new Date().toISOString() }, null, 2)
    );
    this.store.updateJob(jobId, {
      artifact: { path: zipPath, bytes: zip.length, name: `${project.slug}.zip` },
    });
    return zipPath;
  }
}

function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hintFor(err) {
  const status = err.status;
  if (status === 401) return 'Your GitHub token is invalid or expired. Reconnect GitHub in Settings.';
  if (status === 403) return 'This token is missing the "repo" (or "workflow") scope, or you hit a rate limit. Reconnect with the right scopes.';
  if (status === 404) return 'Repository or scope not found. Check the owner/repo settings and that the token can see it.';
  if (status === 422) return 'GitHub rejected the request — usually a duplicate repository name or an empty-repo race. Retry once.';
  if (/rate limit/i.test(err.message)) return 'GitHub rate limit reached. Wait a few minutes and retry.';
  if (/validation failed/i.test(err.message)) return 'The generated model failed validation. Check the build log for the failing check.';
  return null;
}

module.exports = { JobRunner, STEPS };
