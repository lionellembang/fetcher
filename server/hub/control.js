/**
 * The web process's line to the worker (worker.js): pipeline status, "scan
 * now", "redo this stage" and fresh SharePoint links. The worker is the only
 * process that runs scans and stages or talks to the LMS; the web process
 * reads the database directly for everything else.
 *
 * When the worker isn't running, calls throw WorkerDownError (status() returns
 * null instead), so the dashboard and MCP keep working read-only.
 */
const config = require('./config');

class WorkerDownError extends Error {}

const base = () => `http://127.0.0.1:${config.workerPort}`;

async function call(pathname, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new WorkerDownError(`the pipeline worker isn't running (${(err.cause && err.cause.code) || err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `worker → HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

module.exports = {
  WorkerDownError,
  /** { lastScan, scanning, pipeline }, or null when the worker is down. */
  status: () => call('/status', { timeoutMs: 3000 }).catch((err) => (err instanceof WorkerDownError ? null : Promise.reject(err))),
  /** Start a scan; { started, scanning }. */
  scan: () => call('/scan', { method: 'POST' }),
  /** Redo a stage; { result: 'queued' | 'running' }. */
  retry: (itemId, stage) => call('/retry', { method: 'POST', body: { itemId, stage } }),
  /** A fresh SharePoint link for a session (the LMS hands out ~12 h links). */
  recordingLink: (sessionId) => call(`/recording-link/${encodeURIComponent(sessionId)}`, { timeoutMs: 120000 }),
};
