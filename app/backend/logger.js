'use strict';
/* Structured logging: JSON lines to stderr + in-memory ring buffer that
   powers the dashboard "Error Monitoring" panel. */

const MAX = 500;
const buffer = [];

function record(level, event, detail) {
  const entry = {
    at: new Date().toISOString(),
    level,
    event,
    detail: detail === undefined ? undefined : sanitize(detail),
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

function sanitize(detail) {
  if (detail instanceof Error) {
    return { message: detail.message, code: detail.code, stack: String(detail.stack || '').split('\n').slice(0, 6).join('\n') };
  }
  if (typeof detail === 'string') return detail.replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '[REDACTED]');
  if (detail && typeof detail === 'object') {
    const out = Array.isArray(detail) ? [] : {};
    for (const [k, v] of Object.entries(detail)) {
      if (/token|secret|password|authorization|cookie/i.test(k)) out[k] = '[REDACTED]';
      else out[k] = v instanceof Error ? sanitize(v) : v;
    }
    return out;
  }
  return detail;
}

const log = {
  info: (event, detail) => record('info', event, detail),
  warn: (event, detail) => record('warn', event, detail),
  error: (event, detail) => record('error', event, detail),
  entries: (limit = 100) => buffer.slice(-limit).reverse(),
  counts: () => buffer.reduce((acc, e) => ((acc[e.level] = (acc[e.level] || 0) + 1), acc), {}),
  clear: () => (buffer.length = 0),
};

module.exports = { log };
