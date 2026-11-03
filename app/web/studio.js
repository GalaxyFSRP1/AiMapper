/* ============================================================
   AiMapper Model Studio — dashboard front-end
   Talks only to the same-origin API. No tokens are ever stored
   or read in the browser: auth state is a server-side session.
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const state = {
    status: null,
    jobId: null,
    job: null,
    pollTimer: null,
    logCursor: 0,
    estimate: null,
    lastResult: null,
    config: null,
  };

  // ---------------------------------------------------------------- helpers
  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const nf = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? '—'));
  const bytes = (n) => {
    if (!n) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
  };
  const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
  const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(message, kind = 'info', ttl = 5000) {
    let host = $('#toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      host.className = 'toasts';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, ttl);
  }

  // ---------------------------------------------------------------- tabs
  function setupTabs() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.panel;
        const panels = {
          generator: ['panel-generator', 'panel-counter'],
          architecture: ['panel-architecture'],
          github: ['panel-github', 'panel-counter'],
          training: ['panel-training', 'panel-counter'],
          validation: ['panel-validation'],
          logs: ['panel-logs'],
          versions: ['panel-versions'],
          monitoring: ['panel-monitoring'],
        }[target] || ['panel-generator'];
        $$('.panel[id^="panel-"]').forEach((p) => { p.hidden = !panels.includes(p.id); });
        if (target === 'monitoring') loadMonitoring();
        if (target === 'architecture' && state.estimate) renderArchitecture(state.estimate);
        if (target === 'github') loadReposIfNeeded();
      });
    });
  }

  // ---------------------------------------------------------------- background
  function setupBackground() {
    const canvas = $('#bg');
    const ctx = canvas.getContext('2d');
    let w = 0;
    let h = 0;
    const particles = Array.from({ length: 42 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0004, vy: -0.0002 - Math.random() * 0.0006,
      r: 0.6 + Math.random() * 1.8,
      hue: Math.random() > 0.5 ? 188 : 330,
    }));
    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);
    function frame() {
      ctx.fillStyle = 'rgba(6,10,18,0.35)';
      ctx.fillRect(0, 0, w, h);
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy;
        if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
        if (p.x < -0.02) p.x = 1.02;
        if (p.x > 1.02) p.x = -0.02;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue},100%,62%,0.20)`;
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    frame();
  }

  // ---------------------------------------------------------------- config & status
  async function loadConfig() {
    try {
      const cfg = await api('/api/config');
      state.config = cfg;
      $('#ver').textContent = `v${cfg.version}`;
      $('#in-repo').value = `${cfg.defaultOwner}/${cfg.defaultRepo}`;
      $('#in-basepath').value = cfg.defaultBasePath;
      $('#in-name').value = cfg.defaults.name;
      $('#in-target').value = String(cfg.defaults.targetParameters);
      $('#in-vocab').value = String(cfg.defaults.vocabSize);
      $('#in-synthetic').value = String(cfg.defaults.syntheticExamples);
      if (!cfg.oauthEnabled) {
        const btn = $('#btn-oauth');
        btn.disabled = true;
        btn.title = 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set on the server — use a token or a sandbox session';
      }
      if (!cfg.manualTokenEnabled) $('.token-box').hidden = true;
      updateTargetHint();
      estimateNow().catch(() => {});
    } catch (err) {
      toast(`Could not load server config: ${err.message}`, 'error');
    }
  }

  async function refreshStatus() {
    try {
      state.status = await api('/api/status');
      renderAuth();
      renderMonitoring(state.status.monitoring);
      renderVersions(state.status.history, state.status.jobs);
      renderPublishTarget();
      $('#health').textContent = `server up ${Math.round(state.status.monitoring.uptimeSeconds)}s · ${state.status.monitoring.memoryMB} MB`;
    } catch (err) {
      $('#health').textContent = 'server unreachable';
    }
  }

  function renderPublishTarget() {
    const repoField = $('#in-repo');
    if ($('#gh-repo')) $('#gh-repo').textContent = repoField?.value || '—';
    const published = (state.status?.history || []).filter((h) => h.published);
    const last = published[0];
    if ($('#gh-branch')) $('#gh-branch').textContent = last?.branch || 'main';
    if ($('#gh-path')) $('#gh-path').textContent = last?.path || $('#in-basepath')?.value || 'models';
    if ($('#gh-last')) {
      $('#gh-last').textContent = last
        ? `${last.model} · ${new Date(last.publishedAt).toLocaleString()}`
        : 'never from this browser';
    }
  }

  function renderAuth() {
    const chip = $('#auth-chip');
    const user = state.status?.user;
    const connected = Boolean(user?.connected);
    chip.className = `chip ${connected ? 'chip-ok' : state.status?.authenticated ? 'chip-warn' : 'chip-muted'}`;
    if (connected) chip.textContent = `@${user.login} · ${user.authMethod === 'oauth' ? 'OAuth' : 'token'}`;
    else if (state.status?.authenticated) chip.textContent = 'sandbox session';
    else chip.textContent = 'not connected';

    $('#connect-box').hidden = connected;
    $('#account-box').hidden = !connected;
    if (connected) {
      $('#acct-login').textContent = `@${user.login}`;
      $('#acct-method').textContent = user.authMethod === 'oauth'
        ? `OAuth · scopes: ${user.scopes || 'repo workflow'}${user.expiresAt ? ' · token refreshes automatically' : ''}`
        : 'personal access token (encrypted at rest)';
      if (user.avatarUrl) $('#acct-avatar').src = user.avatarUrl;
      if (state.status.config) {
        const repoField = $('#in-repo');
        if (!repoField.value || repoField.value.startsWith('local/')) repoField.value = `${user.login}/${state.status.config.defaultRepo}`;
      }
    }
  }

  // ---------------------------------------------------------------- estimate / counter
  function updateTargetHint() {
    const target = Number($('#in-target').value || 0);
    $('#target-hint').textContent = `${nf(target)} — architecture search lands within 0.05%`;
  }

  async function estimateNow() {
    const body = {
      targetParameters: Number($('#in-target').value || 5000000),
      vocabSize: Number($('#in-vocab').value || 2048),
      // the server trains a real tokenizer for this seed, so the predicted
      // architecture is the one the build will produce
      seed: $('#in-name').value.trim() || 'mapper-5m',
      syntheticExamples: Number($('#in-synthetic').value || 64),
    };
    const est = await api('/api/parameters/estimate', { method: 'POST', body });
    state.estimate = est;
    renderCounter(est);
    if (!$('#panel-architecture').hidden) renderArchitecture(est);
    $('#counter-value').textContent = nf(est.config.achieved_parameters);
    return est;
  }

  // Bind the counter to the model that was really built (post-run) rather than
  // the preview estimate, so no number on screen is a guess.
  function counterFromResult(result) {
    if (!result || !result.architecture) return null;
    const a = result.architecture;
    const b = result.parameter_breakdown || {};
    return {
      config: {
        target_parameters: result.targetParameters,
        achieved_parameters: result.parameters,
        deviation: Number(result.deviationPct),
        n_layer: a.n_layer,
        d_model: a.d_model,
        n_head: a.n_head,
        head_dim: a.head_dim,
        d_ff: a.d_ff,
        n_ctx: a.n_ctx,
        vocab_size: a.vocab_size,
        parameter_breakdown: b,
        candidates_considered: result.alternatives ? result.alternatives.length : state.estimate?.config?.candidates_considered,
        exact: true,
        source: 'built model',
      },
      alternatives: result.alternatives || state.estimate?.alternatives || [],
    };
  }

  function renderCounter(est) {
    const c = est.config;
    const b = c.parameter_breakdown;
    $('#counter-value').textContent = nf(c.achieved_parameters);
    $('#counter-grid').innerHTML = [
      ['Target', nf(c.target_parameters)],
      ['Achieved', nf(c.achieved_parameters)],
      ['Deviation', `${c.deviation > 0 ? '+' : ''}${c.deviation}%`],
      ['Layers', c.n_layer],
      ['d_model', c.d_model],
      ['Heads × dim', `${c.n_head} × ${c.head_dim}`],
      ['Feed-forward', nf(c.d_ff)],
      ['Context', c.n_ctx],
      ['Vocabulary', nf(c.vocab_size)],
      ['Embedding', nf(b.embedding)],
      ['Positional', nf(b.positional)],
      ['All blocks', nf(b.blocks)],
      ['Final norm', nf(b.finalLn)],
      ['Configs searched', nf(c.candidates_considered)],
    ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    const verb = c.source === 'built model' ? 'built model has' : 'the search lands on';
    $('#gen-sub').textContent = `target ${nf(c.target_parameters)} · ${verb} ${nf(c.achieved_parameters)} params (${c.deviation > 0 ? '+' : ''}${c.deviation}%)`;
  }

  function renderArchitecture(est) {
    const c = est.config;
    $('#arch-grid').innerHTML = [
      ['Layers', c.n_layer], ['Hidden size', c.d_model], ['Heads', c.n_head], ['Head dim', c.head_dim],
      ['d_ff', nf(c.d_ff)], ['Context', c.n_ctx], ['Vocab', nf(c.vocab_size)],
      ['Tied embeddings', c.tie_word_embeddings ? 'yes' : 'no'],
      ['Activation', c.activation], ['Norm', c.norm],
      ['Parameters', nf(c.achieved_parameters)], ['Search space', nf(c.candidates_considered)],
    ].map(([k, v]) => `<div class="stat"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    // block stack figure
    const canvas = $('#arch-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const rows = [
      { label: `token embedding ${c.vocab_size}×${c.d_model}`, tone: '#00e5ff' },
      { label: `positional ${c.n_ctx}×${c.d_model}`, tone: '#0ea5e9' },
      ...Array.from({ length: Math.min(c.n_layer, 10) }, (_, i) => ({ label: `block ${i + 1} · attn+mlp`, tone: i % 2 ? '#2979ff' : '#a855f7' })),
      ...(c.n_layer > 10 ? [{ label: `… ${c.n_layer - 10} more blocks`, tone: '#334155' }] : []),
      { label: 'final layernorm', tone: '#ff3898' },
      { label: `lm head → ${c.vocab_size} logits (tied)`, tone: '#76ff03' },
    ];
    const rowH = Math.min(34, (H - 30) / rows.length);
    rows.forEach((row, i) => {
      const y = 10 + i * rowH;
      const width = W - 40;
      ctx.fillStyle = row.tone + '2e';
      ctx.strokeStyle = row.tone;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(20, y, width, rowH - 6, 5);
      else ctx.rect(20, y, width, rowH - 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#cfe3f5';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(row.label, 30, y + rowH / 2 + 2);
    });

    if (est.alternatives) {
      $('#arch-alternatives').innerHTML = `
        <thead><tr><th>d_model</th><th>layers</th><th>heads</th><th>d_ff</th><th>ctx</th><th>parameters</th><th>Δ target</th></tr></thead>
        <tbody>${est.alternatives.map((a) => `<tr><td>${a.d_model}</td><td>${a.n_layer}</td><td>${a.n_head}</td><td>${a.d_ff}</td><td>${a.n_ctx}</td><td>${nf(a.total)}</td><td>${a.deviation_pct > 0 ? '+' : ''}${a.deviation_pct}%</td></tr>`).join('')}</tbody>`;
    }
  }

  // ---------------------------------------------------------------- training preview
  function trainingPayload() {
    return {
      batch_size: Number($('#t-batch').value),
      learning_rate: Number($('#t-lr').value),
      max_steps: Number($('#t-steps').value),
      weight_decay: Number($('#t-wd').value),
      grad_clip: Number($('#t-clip').value),
      warmup_ratio: Number($('#t-warm').value),
      optimizer: $('#t-opt').value,
      scheduler: $('#t-sched').value,
    };
  }

  function renderTrainingPreview() {
    const t = trainingPayload();
    $('#training-preview').textContent = JSON.stringify({ training: t }, null, 2);
  }

  // ---------------------------------------------------------------- generation
  function setGenerating(on) {
    $('#btn-generate').disabled = on;
    $('#btn-cancel').hidden = !on;
    $('#progress-block').hidden = !on && !state.job;
  }

  async function ensureSession() {
    if (state.status?.authenticated) return true;
    try {
      await api('/api/session', { method: 'POST' });
      await refreshStatus();
      toast('Sandbox session started — generation runs locally and downloads as a ZIP', 'info', 7000);
      return true;
    } catch (err) {
      toast(`Could not start a session: ${err.message}`, 'error');
      return false;
    }
  }

  async function generate() {
    const publish = $('#in-publish').checked;
    if (publish && !state.status?.user?.connected) {
      toast('Connect GitHub first, or untick “Publish to GitHub”.', 'warn', 7000);
      $$('.tab').find((t) => t.dataset.panel === 'github')?.click();
      return;
    }
    if (!state.status?.authenticated && !(await ensureSession())) return;

    const repoRaw = $('#in-repo').value.trim() || 'GalaxyFSRP1/AiMapper';
    const [owner, repo] = repoRaw.includes('/') ? repoRaw.split('/') : [state.status?.user?.login, repoRaw];

    const body = {
      name: $('#in-name').value.trim() || 'mapper-5m',
      targetParameters: Number($('#in-target').value || 5000000),
      vocabSize: Number($('#in-vocab').value || 2048),
      syntheticExamples: Number($('#in-synthetic').value || 64),
      owner,
      repo,
      basePath: $('#in-basepath').value.trim(),
      privateRepo: $('#in-private').checked,
      publish,
      training: trainingPayload(),
    };

    setGenerating(true);
    state.logCursor = 0;
    state.job = null;
    state.lastResult = null;
    $('#log-body').textContent = '';
    $('#result-block').hidden = true;
    $('#steps').innerHTML = '';
    try {
      const res = await api('/api/generate', { method: 'POST', body });
      state.jobId = res.jobId;
      toast(`Job ${res.jobId} started`, 'ok', 4000);
      pollJob();
    } catch (err) {
      setGenerating(false);
      toast(err.message, 'error', 9000);
      if (err.status === 401) $$('.tab').find((t) => t.dataset.panel === 'github')?.click();
    }
  }

  function renderSteps(steps) {
    if (!steps) return;
    $('#steps').innerHTML = steps.map((s) => {
      const cls = s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : s.status === 'error' ? 'error' : '';
      const icon = s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : s.status === 'active' ? '▸' : '·';
      return `<li class="${cls}"><i>${icon}</i>${esc(s.label)}</li>`;
    }).join('');
  }

  async function pollJob() {
    if (!state.jobId) return;
    clearTimeout(state.pollTimer);
    try {
      const job = await api(`/api/jobs/${state.jobId}`);
      state.job = job;
      renderJob(job);
      if (job.status === 'running' || job.status === 'queued') {
        await pullLogs();
        state.pollTimer = setTimeout(pollJob, 700);
      } else {
        await pullLogs(true);
        setGenerating(false);
        if (job.status === 'success') {
          state.lastResult = job.result;
          renderResult(job.result);
          renderValidation(job.result?.validation);
          toast('Model generated successfully', 'ok', 6000);
        } else if (job.status === 'error') {
          toast(job.error?.message || 'generation failed', 'error', 9000);
        }
        await refreshStatus();
      }
    } catch (err) {
      setGenerating(false);
      toast(`Lost track of the job: ${err.message}`, 'error');
    }
  }

  function renderJob(job) {
    const block = $('#progress-block');
    block.hidden = false;
    // the progress card may be wrapped in a hidden container in some layouts
    if (block.parentElement) block.parentElement.hidden = false;
    $('#progress-fill').style.width = `${job.progress || 0}%`;
    $('#progress-pct').textContent = `${job.progress || 0}%`;
    $('#progress-step').textContent = job.status === 'error'
      ? `failed: ${job.error?.message || 'unknown error'}`
      : job.status === 'success' ? 'complete' : (job.steps?.find((s) => s.status === 'active')?.label || job.step);
    renderSteps(job.steps);
    if (job.status === 'error' && job.error?.hint) {
      $('#gen-hint').textContent = job.error.hint;
    }
  }

  async function pullLogs(final = false) {
    if (!state.jobId) return;
    const data = await api(`/api/jobs/${state.jobId}/logs?since=${state.logCursor}`);
    if (data.lines?.length) {
      const body = $('#log-body');
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
      body.textContent += data.lines.map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.level === 'error' ? '✕ ' : l.level === 'warn' ? '! ' : '  '}${l.message}`).join('\n') + '\n';
      state.logCursor = data.next;
      if ($('#log-follow').checked && (atBottom || final)) body.scrollTop = body.scrollHeight;
    }
  }

  function renderResult(result) {
    // rebind the dashboard to the model that actually exists on disk
    const built = counterFromResult(result);
    if (built) {
      state.builtEstimate = built;
      renderCounter(built);
      if (!$('#panel-architecture').hidden) renderArchitecture(built);
    }
    if (!result) return;
    const gh = result.github;
    const val = result.validation || {};
    const acts = result.actions || {};
    const run = acts.run;
    $('#result-block').hidden = false;
    $('#result-block').innerHTML = `
      <div class="result">
        <div class="result-head">
          <div>
            <h3>${esc(result.name)}</h3>
            <p class="hint">${nf(result.parameters)} trainable parameters · ${result.architecture.n_layer} layers × d${result.architecture.d_model} · ${result.tensorCount} tensors · ${bytes(result.weightsBytes)}</p>
          </div>
          <span class="pill ${val.status === 'pass' ? 'pill-ok' : 'pill-bad'}">${val.status === 'pass' ? 'validated' : 'validation failed'} ${val.passed}/${val.total}</span>
        </div>

        <div class="result-grid">
          <div class="stat"><dt>Parameters</dt><dd>${nf(result.parameters)}</dd></div>
          <div class="stat"><dt>Target</dt><dd>${nf(result.targetParameters)}</dd></div>
          <div class="stat"><dt>Deviation</dt><dd>${result.deviationPct > 0 ? '+' : ''}${result.deviationPct}%</dd></div>
          <div class="stat"><dt>Weights</dt><dd>${bytes(result.weightsBytes)}</dd></div>
          <div class="stat"><dt>Vocab</dt><dd>${nf(result.architecture.vocab_size)}</dd></div>
          <div class="stat"><dt>Context</dt><dd>${result.architecture.n_ctx}</dd></div>
          <div class="stat"><dt>Dataset</dt><dd>${nf(result.dataset.total_examples)} ex · ${nf(result.dataset.tokens)} tok</dd></div>
          <div class="stat"><dt>Files</dt><dd>${result.files.length}</dd></div>
        </div>

        <div class="result-links">
          <a class="btn" href="${esc(result.zip.url)}">Download ZIP</a>
          ${gh ? `<a class="btn btn-primary" href="${esc(gh.commitUrl)}" target="_blank" rel="noopener">View commit ${esc(gh.commitSha.slice(0, 7))}</a>
                  <a class="btn" href="${esc(gh.repoUrl)}/tree/${esc(gh.branch)}/${esc(gh.path)}" target="_blank" rel="noopener">Browse on GitHub</a>` : '<span class="pill">local only — not published</span>'}
          ${run ? `<a class="btn" href="${esc(run.url)}" target="_blank" rel="noopener">Actions run: ${esc(run.status)}${run.conclusion ? ` / ${esc(run.conclusion)}` : ''}</a>` : ''}
        </div>

        ${gh ? `<p class="hint">Pushed <b>${gh.files}</b> files to <code>${esc(gh.repo)}</code> at <code>${esc(gh.path)}</code> on <code>${esc(gh.branch)}</code>${gh.createdRepo ? ' · repository was created' : ''}.</p>` : ''}
        ${acts.errors?.length ? `<p class="hint warn">Actions: ${acts.errors.map(esc).join(' · ')}</p>` : ''}

        <details class="files">
          <summary>Generated files (${result.files.length})</summary>
          <table class="table"><thead><tr><th>Path</th><th>Size</th></tr></thead><tbody>
            ${result.files.map((f) => `<tr><td><code>${esc(f.path)}</code></td><td>${bytes(f.bytes)}</td></tr>`).join('')}
          </tbody></table>
        </details>
      </div>`;
  }

  function renderValidation(validation) {
    const sub = $('#val-sub');
    if (!validation) return;
    sub.textContent = `${validation.passed}/${validation.total} checks passed · ${validation.parameters ? nf(validation.parameters) + ' parameters' : ''}`;
    $('#val-body').innerHTML = `
      <div class="actions-inline" style="margin-bottom:10px">
        <span class="pill ${validation.status === 'pass' ? 'pill-ok' : 'pill-bad'}">${validation.status}</span>
        <span class="hint">validated ${new Date(validation.validatedAt).toLocaleString()}</span>
      </div>
      <ul class="checklist">
        ${validation.checks.map((c) => `<li class="${c.status === 'pass' ? 'ok' : 'bad'}">
          <i>${c.status === 'pass' ? '✓' : '✕'}</i>
          <div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div>
        </li>`).join('')}
      </ul>`;
  }

  // ---------------------------------------------------------------- versions & monitoring
  function renderVersions(history = [], jobs = []) {
    const body = $('#versions-body');
    if (!history.length) {
      body.innerHTML = '<p class="hint">No generations yet.</p>';
      return;
    }
    const jobById = Object.fromEntries(jobs.map((j) => [j.id, j]));
    body.innerHTML = `<table class="table"><thead><tr>
        <th>When</th><th>Model</th><th>Parameters</th><th>Status</th><th>Repository</th><th>Commit</th><th></th>
      </tr></thead><tbody>
      ${history.map((h) => {
        const job = jobById[h.id];
        const gh = job?.result?.github;
        return `<tr>
          <td>${new Date(h.at).toLocaleString()}</td>
          <td>${esc(h.model || '—')}</td>
          <td>${h.parameters ? nf(h.parameters) : '—'}</td>
          <td><span class="pill ${h.status === 'success' ? 'pill-ok' : h.status === 'error' ? 'pill-bad' : ''}">${esc(h.status)}</span></td>
          <td>${h.repo ? `<code>${esc(h.repo)}</code>` : '—'}</td>
          <td>${h.commit ? `<a href="${gh ? esc(gh.commitUrl) : `#`}" target="_blank" rel="noopener"><code>${esc(String(h.commit).slice(0, 7))}</code></a>` : '—'}</td>
          <td>${job ? `<a class="btn btn-ghost" href="${esc(job.artifact?.url || '#')}">ZIP</a>` : ''}</td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  }

  function renderMonitoring(mon) {
    if (!mon) return;
    $('#mon-stats').innerHTML = [
      ['Jobs total', mon.jobs.total], ['Running', mon.jobs.running], ['Succeeded', mon.jobs.success],
      ['Failed', mon.jobs.failed], ['Last 24h', mon.jobs.last24h],
      ['Parameters generated', nf(mon.parameters.totalGenerated)],
      ['Average model', nf(mon.parameters.averageModelSize)],
      ['Uptime', `${Math.round(mon.uptimeSeconds)}s`],
      ['Memory', `${mon.memoryMB} MB`],
    ].map(([k, v]) => `<div class="stat"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    $('#mon-errors').innerHTML = mon.errors.count
      ? `<h3 class="mini">Recent errors</h3><ul class="checklist">${mon.errors.latest.map((e) => `<li class="bad"><i>✕</i><div><b>${esc(e.model || e.jobId)}</b><small>${esc(e.message)}${e.hint ? ` — ${esc(e.hint)}` : ''}</small></div></li>`).join('')}</ul>`
      : '<p class="hint">No failed jobs recorded.</p>';

    $('#mon-logs').textContent = (mon.recentLogs || []).map((l) => `${l.at} ${l.level.toUpperCase().padEnd(5)} ${l.event} ${l.detail ? JSON.stringify(l.detail) : ''}`).join('\n') || 'no server logs';
  }

  async function loadMonitoring() {
    try {
      renderMonitoring(await api('/api/monitoring'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------------------------------------------------------------- github panel
  let reposLoaded = false;
  async function loadReposIfNeeded() {
    if (reposLoaded || !state.status?.user?.connected) return;
    loadRepos();
  }

  async function loadRepos() {
    const host = $('#repo-list');
    host.innerHTML = '<p class="hint">loading…</p>';
    try {
      const data = await api('/api/github/repos');
      reposLoaded = true;
      host.innerHTML = `<table class="table"><thead><tr><th>Repository</th><th>Default branch</th><th>Visibility</th><th>Updated</th><th></th></tr></thead><tbody>
        ${data.repos.slice(0, 40).map((r) => `<tr>
          <td><code>${esc(r.fullName)}</code></td>
          <td>${esc(r.defaultBranch)}</td>
          <td>${r.private ? 'private' : 'public'}</td>
          <td>${r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'}</td>
          <td><button class="btn btn-ghost" data-repo="${esc(r.fullName)}">use</button></td>
        </tr>`).join('')}
      </tbody></table>`;
      host.querySelectorAll('[data-repo]').forEach((btn) => {
        btn.addEventListener('click', () => {
          $('#in-repo').value = btn.dataset.repo;
          toast(`Target set to ${btn.dataset.repo}`, 'ok', 3000);
        });
      });
    } catch (err) {
      host.innerHTML = `<p class="hint warn">${esc(err.message)}</p>`;
    }
  }

  async function verifyRepo() {
    const raw = $('#in-repo').value.trim();
    const [owner, repo] = raw.includes('/') ? raw.split('/') : [state.status?.user?.login, raw];
    $('#verify-out').textContent = 'checking…';
    try {
      const data = await api('/api/github/verify', { method: 'POST', body: { owner, repo } });
      const c = data.checks;
      $('#verify-out').innerHTML = c.repo?.exists === false
        ? `Repository <code>${esc(owner)}/${esc(repo)}</code> does not exist yet — it will be created on next generation.`
        : `Repository <code>${esc(c.repo.fullName)}</code> (${c.repo.private ? 'private' : 'public'}) · branch <code>${esc(c.repo.defaultBranch)}</code> · push permission: <b>${c.canPush ? 'yes' : 'no'}</b> · Actions readable: <b>${c.workflows ? 'yes' : 'no'}</b>`;
    } catch (err) {
      $('#verify-out').innerHTML = `<span class="warn">${esc(err.message)}</span>`;
    }
  }

  // ---------------------------------------------------------------- connect flows
  async function connectToken() {
    const token = $('#in-token').value.trim();
    if (!token) return toast('Paste a token first', 'warn');
    try {
      await api('/api/auth/token', { method: 'POST', body: { token } });
      $('#in-token').value = '';
      toast('GitHub connected — token encrypted server-side', 'ok', 5000);
      await refreshStatus();
      loadRepos();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function sandbox() {
    try {
      await api('/api/session', { method: 'POST' });
      await refreshStatus();
      toast('Sandbox session ready — generations stay local and download as ZIP', 'ok', 7000);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      reposLoaded = false;
      await refreshStatus();
      toast('Disconnected', 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------------------------------------------------------------- wiring
  function setupEvents() {
    $('#btn-generate').addEventListener('click', generate);
    $('#btn-estimate').addEventListener('click', async () => {
      try {
        await estimateNow();
        $$('.tab').find((t) => t.dataset.panel === 'architecture')?.click();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#btn-cancel').addEventListener('click', async () => {
      if (!state.jobId) return;
      try {
        await api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' });
        toast('Cancellation requested', 'info');
      } catch (err) { toast(err.message, 'error'); }
    });
    ['#in-target', '#in-vocab'].forEach((sel) => {
      $(sel).addEventListener('input', updateTargetHint);
      $(sel).addEventListener('change', () => estimateNow().catch(() => {}));
    });
    // a different seed or corpus size changes the trained vocabulary, which
    // changes the architecture — keep the counter honest
    ['#in-repo', '#in-basepath'].forEach((sel) => {
      $(sel).addEventListener('input', renderPublishTarget);
    });
    ['#in-name', '#in-synthetic'].forEach((sel) => {
      let t = null;
      $(sel).addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => estimateNow().catch(() => {}), 450);
      });
    });
    ['#t-batch', '#t-lr', '#t-steps', '#t-wd', '#t-clip', '#t-warm', '#t-opt', '#t-sched'].forEach((sel) => {
      $(sel).addEventListener('input', renderTrainingPreview);
      $(sel).addEventListener('change', renderTrainingPreview);
    });
    $('#btn-oauth').addEventListener('click', () => { window.location.href = '/auth/github'; });
    $('#btn-sandbox').addEventListener('click', sandbox);
    $('#btn-token').addEventListener('click', connectToken);
    $('#in-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectToken(); });
    $('#btn-logout').addEventListener('click', logout);
    $('#btn-repos').addEventListener('click', loadRepos);
    $('#btn-verify').addEventListener('click', verifyRepo);
    $('#btn-copy-log').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#log-body').textContent);
        toast('Log copied', 'ok', 2500);
      } catch { toast('Clipboard blocked by browser', 'warn'); }
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    setupTabs();
    setupBackground();
    setupEvents();
    renderTrainingPreview();
    await loadConfig();
    await refreshStatus();

    // resume an in-flight job after a reload
    const running = state.status?.jobs?.find((j) => j.status === 'running' || j.status === 'queued');
    if (running) {
      state.jobId = running.id;
      state.logCursor = 0;
      setGenerating(true);
      pollJob();
    } else if (state.status?.jobs?.[0]) {
      const last = state.status.jobs[0];
      if (last.status === 'success' && last.result) {
        try {
          const full = await api(`/api/jobs/${last.id}`);
          state.jobId = last.id;
          renderResult(full.result);
          renderValidation(full.result?.validation);
          renderSteps(full.steps);
          $('#progress-block').hidden = false;
          $('#progress-pct').textContent = '100%';
          $('#progress-fill').style.width = '100%';
          $('#progress-step').textContent = 'last run complete';
        } catch { /* ignore */ }
      }
    }

    setInterval(refreshStatus, 20000);
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected')) toast('GitHub connected', 'ok', 5000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
