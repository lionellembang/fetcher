/**
 * HTTP client for the transcriber (transcriber/server.py): health, Whisper
 * transcription and text embeddings.
 *
 * Transcription goes through the transcriber's job queue (POST /jobs, then
 * poll GET /jobs/<id>), so no request stays open for the ~20 min a lecture
 * takes. Only "can't connect" errors throw UnavailableError, which the pipeline
 * treats as "try again later"; anything else is a real failure.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

class UnavailableError extends Error {}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

async function call(pathname, init = {}, timeoutMs = 10000) {
  let res;
  try {
    res = await fetch(`${config.whisperUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = err.cause && (err.cause.code || err.cause.name);
    if (err.name === 'TimeoutError') throw new Error(`transcriber ${pathname} timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (CONNECT_ERRORS.has(code)) throw new UnavailableError(`transcriber not reachable at ${config.whisperUrl} (${code})`);
    throw new Error(`transcriber ${pathname}: ${err.message}${code ? ` (${code})` : ''}`);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `transcriber ${pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** /health, or null when the transcriber isn't up. */
async function health() {
  try {
    return await call('/health', {}, 3000);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 10000;

/**
 * Queue a transcription. `key` identifies the work (item + settings): if a job
 * with that key is already queued, running or done, the transcriber returns it
 * instead of starting another. Resolves { id, status }.
 */
async function submitJob(file, { key, language, model, gateDb }) {
  const form = new FormData();
  form.set('file', await fs.openAsBlob(file), path.basename(file));
  form.set('key', key);
  if (language) form.set('language', language);
  if (model) form.set('model', model);
  if (gateDb != null) form.set('gate_db', String(gateDb));
  return call('/jobs', { method: 'POST', body: form }, 10 * 60000); // upload only
}

/**
 * Wait for a job; resolves Whisper's JSON result ({ text, language, segments[] }).
 * Throws UnavailableError if the transcriber goes away or lost the job (it
 * restarted), and a plain Error if the job failed or took longer than `timeoutMs`.
 */
async function waitJob(id, { timeoutMs, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    let job;
    try {
      job = await call(`/jobs/${id}`, {}, 60000);
    } catch (err) {
      if (err.status === 404) throw new UnavailableError('the transcriber lost the job (it restarted?); resubmitting');
      throw err;
    }
    if (job.status === 'done') return job.result;
    if (job.status === 'failed') throw new Error(`transcription failed: ${job.error}`);
    if (onProgress && job.status !== last) onProgress(job);
    last = job.status;
    if (Date.now() > deadline) throw new Error(`transcription still ${job.status} after ${Math.round(timeoutMs / 60000)} min`);
    await sleep(POLL_MS);
  }
}

/** Normalised embeddings (arrays of numbers) for `texts`; kind is 'query' or 'passage'. */
async function embed(texts, kind) {
  const out = [];
  let model;
  for (let i = 0; i < texts.length; i += 64) {
    const r = await call(
      '/embed',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: texts.slice(i, i + 64), kind }) },
      300000 // the first call loads the model
    );
    model = r.model;
    out.push(...r.vectors);
  }
  return { model, vectors: out };
}

module.exports = { health, submitJob, waitJob, embed, UnavailableError };
