/**
 * Search embeddings from EMBED_URL: the transcriber's /embed, or on a hub
 * whose transcriber is elsewhere, hub/embed-server.
 */
const config = require('./config');
const { call } = require('../shared/whisper');

/** /health of the embedding server, or null. */
async function health() {
  try {
    return await call('/health', {}, 3000, config.embedUrl);
  } catch {
    return null;
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
      300000, // the first call loads the model
      config.embedUrl
    );
    model = r.model;
    out.push(...r.vectors);
  }
  return { model, vectors: out };
}

module.exports = { health, embed };
