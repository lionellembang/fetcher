/**
 * Transcribe a recording (the ORIGINAL, not the cut) with the Whisper server:
 * extract 16 kHz mono FLAC (loudness-normalised for quiet recordings), send it,
 * and store the segments. Whisper's own VAD + loudness gate skip the silences.
 *
 * transcribeFile() does the work without touching the database, so a compute
 * node (src/node/agent.js) runs it too; transcribeRecording() adds the saving.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const whisper = require('./whisper');
const { extractAudio } = require('./media');

const paramsKey = () =>
  [config.transcribeModel, config.transcribeLang, `gate${config.transcribeGateDb}`, `loudnorm:${config.transcribeLoudnorm}`].join('|');

function useLoudnorm(probeMeta) {
  if (config.transcribeLoudnorm === 'always') return true;
  if (config.transcribeLoudnorm === 'never') return false;
  return !!(probeMeta && probeMeta.quiet);
}

/** Whisper segments with trimmed text, blank ones dropped. */
const cleanSegments = (segments) =>
  (segments || []).map((s) => ({ ...s, text: String(s.text || '').trim() })).filter((s) => s.text);

/**
 * Transcribe the audio of `file`. `key` identifies the work to the transcriber
 * (see whisper.submitJob). Resolves { segments, language, meta }. Throws
 * whisper.UnavailableError if the transcriber is down.
 */
async function transcribeFile(file, { key, language, model, gateDb, loudnorm, duration, label = path.basename(file), signal }) {
  const h = await whisper.health();
  if (!h) throw new whisper.UnavailableError(`transcriber not reachable at ${config.whisperUrl}`);

  config.ensureDirs();
  const audio = path.join(config.tmpDir, `${crypto.randomUUID()}.flac`);
  try {
    await extractAudio(file, audio, { loudnorm });

    // The job can wait behind others the transcriber is already running (e.g. from
    // before a restart of this server), so allow 2× real time plus an hour.
    const dur = duration || 3600;
    const timeoutMs = (dur * 2 + 3600) * 1000;
    const started = Date.now();
    const job = await whisper.submitJob(audio, { key, language, model, gateDb });
    const result = await whisper.waitJob(job.id, {
      timeoutMs,
      signal,
      onProgress: (j) => console.log(`  … transcribe ${label}: ${j.status}${j.ahead ? ` (${j.ahead} ahead)` : ''}`),
    });

    const segments = cleanSegments(result.segments);
    return {
      segments,
      language: result.language || language,
      meta: {
        segments: segments.length,
        language: result.language,
        loudnorm,
        speechSec: Math.round(segments.reduce((a, s) => a + (s.end - s.start), 0)),
        tookSec: Math.round((Date.now() - started) / 1000),
      },
    };
  } finally {
    fs.rmSync(audio, { force: true });
  }
}

/** Store a transcript made with the current settings. */
function saveResult(item, { segments, language, duration }) {
  store.saveTranscript(
    item.id,
    { model: config.transcribeModel, language: language || config.transcribeLang, paramsKey: paramsKey(), duration },
    cleanSegments(segments)
  );
}

/** Resolves { meta }. Throws whisper.UnavailableError if the server is down. */
async function transcribeRecording(item, probeMeta) {
  const loudnorm = useLoudnorm(probeMeta);
  const duration = (probeMeta && probeMeta.duration) || 3600;
  const r = await transcribeFile(path.join(config.downloadDir, item.file_path), {
    key: `${item.id}|${paramsKey()}|${loudnorm}`,
    language: config.transcribeLang,
    model: config.transcribeModel,
    gateDb: config.transcribeGateDb,
    loudnorm,
    duration,
    label: `${item.course_code} S${item.session_number}`,
  });
  saveResult(item, { segments: r.segments, language: r.language, duration });
  return { meta: r.meta };
}

module.exports = { transcribeRecording, transcribeFile, saveResult, cleanSegments, useLoudnorm, paramsKey };
