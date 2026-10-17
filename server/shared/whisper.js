/**
 * HTTP client for the transcriber (compute/transcriber/server.py): health and Whisper
 * transcription. (Search embeddings are the hub's: hub/embed.js, through call().)
 *
 * Transcription goes through the transcriber's job queue (POST /jobs, then
 * poll GET /jobs/<id>), so no request stays open for the ~20 min a lecture
 * takes. Only "can't connect" errors throw UnavailableError, which the pipeline
 * treats as "try again later"; anything else is a real failure.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./env');

class UnavailableError extends Error {}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

/** JSON from `base` + `pathname`; UnavailableError when nothing answers there. */
async function call(pathname, init = {}, timeoutMs = 10000, base = config.whisperUrl) {
  let res;
  try {
    res = await fetch(`${base}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = err.cause && (err.cause.code || err.cause.name);
    if (err.name === 'TimeoutError') throw new Error(`transcriber ${pathname} timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (CONNECT_ERRORS.has(code)) throw new UnavailableError(`transcriber not reachable at ${base} (${code})`);
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
 * onProgress(job) is called when its status or phase changes (decoding audio,
 * transcribing, …), onPoll(job) on every poll (job.progress: 0–1 of the audio).
 */
async function waitJob(id, { timeoutMs, onProgress, onPoll, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    if (signal && signal.aborted) throw signal.reason || new Error('aborted');
    let job;
    try {
      job = await call(`/jobs/${id}`, {}, 60000);
    } catch (err) {
      if (err.status === 404) throw new UnavailableError('the transcriber lost the job (it restarted?); resubmitting');
      throw err;
    }
    if (job.status === 'done') return job.result;
    if (job.status === 'failed') throw new Error(`transcription failed: ${job.error}`);
    if (onPoll) onPoll(job);
    const state = `${job.status}|${job.phase || ''}`;
    if (onProgress && state !== last) onProgress(job);
    last = state;
    if (Date.now() > deadline) throw new Error(`transcription still ${job.status} after ${Math.round(timeoutMs / 60000)} min`);
    await sleep(POLL_MS);
  }
}

module.exports = { call, health, submitJob, waitJob, UnavailableError };
