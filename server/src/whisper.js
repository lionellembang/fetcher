/**
 * HTTP client for the transcriber (transcriber/server.py): health, Whisper
 * transcription and text embeddings.
 *
 * A connection failure throws UnavailableError, which the pipeline treats as
 * "try again later" rather than a failed stage.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

class UnavailableError extends Error {}

async function call(pathname, init = {}, timeoutMs = 10000) {
  let res;
  try {
    res = await fetch(`${config.whisperUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
    if (err.name === 'TimeoutError') throw new Error(`transcriber ${pathname} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new UnavailableError(`transcriber not reachable at ${config.whisperUrl}${cause}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`transcriber ${pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`);
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

/** Whisper JSON result ({ text, language, segments[] }) for an audio file. */
async function transcribe(file, { language, model, gateDb, timeoutMs }) {
  const form = new FormData();
  form.set('file', await fs.openAsBlob(file), path.basename(file));
  form.set('format', 'json');
  if (language) form.set('language', language);
  if (model) form.set('model', model);
  if (gateDb != null) form.set('gate_db', String(gateDb));
  return call('/transcribe', { method: 'POST', body: form }, timeoutMs);
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

module.exports = { health, transcribe, embed, UnavailableError };
