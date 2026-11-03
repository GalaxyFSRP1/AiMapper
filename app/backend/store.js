'use strict';
/* JSON-file persistence that survives restarts without any native module.

   data/store.json holds: oauth sessions, user credentials (sealed), job
   records, build logs (ring-buffered) and the version history ledger.
   Writes are atomic (tmp + rename) and debounced. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_LOG_LINES = 4000;

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.jobsDir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.state = this.#load();
    this._flushTimer = null;
  }

  #load() {
    if (!fs.existsSync(this.file)) return { schemaVersion: SCHEMA_VERSION, sessions: {}, users: {}, jobs: {}, history: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        schemaVersion: parsed.schemaVersion || SCHEMA_VERSION,
        sessions: parsed.sessions || {},
        users: parsed.users || {},
        jobs: parsed.jobs || {},
        history: parsed.history || [],
      };
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.file, backup); } catch { /* ignore */ }
      return { schemaVersion: SCHEMA_VERSION, sessions: {}, users: {}, jobs: {}, history: [] };
    }
  }

  save() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, 120);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  flush() {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- sessions ---------------------------------------------------------
  createSession(userId) {
    const id = crypto.randomBytes(32).toString('base64url');
    this.state.sessions[id] = { userId, createdAt: Date.now() };
    this.save();
    return id;
  }

  getSession(id) {
    if (!id) return null;
    const s = this.state.sessions[id];
    if (!s) return null;
    if (Date.now() - s.createdAt > 1000 * 60 * 60 * 24 * 30) {
      delete this.state.sessions[id];
      this.save();
      return null;
    }
    return s;
  }

  destroySession(id) {
    delete this.state.sessions[id];
    this.save();
  }

  // ---- users ------------------------------------------------------------
  user(userId) {
    return this.state.users[userId] || null;
  }

  upsertUser(userId, patch) {
    this.state.users[userId] = { ...(this.state.users[userId] || {}), ...patch, updatedAt: Date.now() };
    this.save();
    return this.state.users[userId];
  }

  // ---- jobs -------------------------------------------------------------
  createJob(job) {
    this.state.jobs[job.id] = job;
    this.save();
    return job;
  }

  job(id) {
    return this.state.jobs[id] || null;
  }

  updateJob(id, patch) {
    const job = this.state.jobs[id];
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.save();
    return job;
  }

  jobsForUser(userId, limit = 25) {
    return Object.values(this.state.jobs)
      .filter((j) => j.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  activeJobs() {
    return Object.values(this.state.jobs).filter((j) => j.status === 'queued' || j.status === 'running');
  }

  appendLog(id, line) {
    const job = this.state.jobs[id];
    if (!job) return;
    job.logs = job.logs || [];
    job.logs.push(line);
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    this.save();
  }

  // ---- version history ledger ------------------------------------------
  addHistory(entry) {
    this.state.history.unshift(entry);
    if (this.state.history.length > 200) this.state.history.length = 200;
    this.save();
  }

  historyForUser(userId, limit = 40) {
    return this.state.history.filter((h) => h.userId === userId).slice(0, limit);
  }

  // ---- generated file artifacts (kept out of store.json) ----------------
  artifactPath(jobId, name) {
    const dir = path.join(this.jobsDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }
}

module.exports = { Store };
