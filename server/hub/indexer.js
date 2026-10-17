/**
 * Index stage: group a transcript's segments into ~45 s overlapping windows
 * and embed them (transcriber /embed) for semantic search.
 */
const config = require('./config');
const store = require('./store');
const { embed } = require('./embed');

const paramsKey = () => [config.embedModel, `w${config.chunkWindowSec}`, `o${config.chunkOverlapSec}`].join('|');

/**
 * Windows of consecutive segments, about `windowSec` long, each starting
 * about `overlapSec` before the previous one ended. Cuts only at segment
 * boundaries. Returns [{ start, end, segFrom, segTo, text }].
 */
function chunkSegments(segments, windowSec, overlapSec) {
  const chunks = [];
  let i = 0;
  while (i < segments.length) {
    let j = i;
    while (j + 1 < segments.length && segments[j].end - segments[i].start < windowSec) j++;
    const part = segments.slice(i, j + 1);
    chunks.push({
      start: segments[i].start,
      end: segments[j].end,
      segFrom: segments[i].idx,
      segTo: segments[j].idx,
      text: part.map((s) => s.text).join(' '),
    });
    if (j + 1 >= segments.length) break;
    // next window starts at the first segment beginning after (end - overlap), always moving forward
    const from = segments[j].end - overlapSec;
    let k = i + 1;
    while (k < j && segments[k].start < from) k++;
    i = k;
  }
  return chunks;
}

/** Resolves { meta }. Throws UnavailableError (shared/whisper.js) if the embedding server is down. */
async function indexRecording(item) {
  const segments = store.getSegments(item.id);
  const chunks = chunkSegments(segments, config.chunkWindowSec, config.chunkOverlapSec);
  if (!chunks.length) {
    store.saveChunks(item.id, config.embedModel, []);
    return { meta: { chunks: 0 } };
  }
  // A course prefix gives each passage some context ("which class is this").
  const prefix = `[${item.course_code} ${item.course_title}] `;
  const { model, vectors } = await embed(chunks.map((c) => prefix + c.text), 'passage');
  if (model && model !== config.embedModel) {
    throw new Error(`transcriber embeds with ${model} but EMBED_MODEL is ${config.embedModel}; set the same value for both`);
  }
  store.saveChunks(
    item.id,
    config.embedModel,
    chunks.map((c, i) => ({ ...c, embedding: vectors[i] }))
  );
  return { meta: { chunks: chunks.length } };
}

module.exports = { indexRecording, chunkSegments, paramsKey };
