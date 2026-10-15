/**
 * Transcribe a recording (the ORIGINAL, not the cut) with the Whisper server:
 * extract 16 kHz mono FLAC (loudness-normalised for quiet recordings), send it,
 * and store the segments. Whisper's own VAD + loudness gate skip the silences.
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

/** Resolves { meta }. Throws whisper.UnavailableError if the server is down. */
async function transcribeRecording(item, probeMeta) {
  const h = await whisper.health();
  if (!h) throw new whisper.UnavailableError(`transcriber not reachable at ${config.whisperUrl}`);

  config.ensureDirs();
  const src = path.join(config.downloadDir, item.file_path);
  const audio = path.join(config.tmpDir, `${crypto.randomUUID()}.flac`);
  try {
    const loudnorm = useLoudnorm(probeMeta);
    await extractAudio(src, audio, { loudnorm });

    // The job can wait behind others the transcriber is already running (e.g. from
    // before a restart of this server), so allow 2× real time plus an hour.
    const dur = (probeMeta && probeMeta.duration) || 3600;
    const timeoutMs = (dur * 2 + 3600) * 1000;
    const started = Date.now();
    const job = await whisper.submitJob(audio, {
      key: `${item.id}|${paramsKey()}|${loudnorm}`,
      language: config.transcribeLang,
      model: config.transcribeModel,
      gateDb: config.transcribeGateDb,
    });
    const result = await whisper.waitJob(job.id, {
      timeoutMs,
      onProgress: (j) =>
        console.log(`  … transcribe ${item.course_code} S${item.session_number}: ${j.status}${j.ahead ? ` (${j.ahead} ahead)` : ''}`),
    });

    const segments = (result.segments || [])
      .map((s) => ({ ...s, text: String(s.text || '').trim() }))
      .filter((s) => s.text);
    store.saveTranscript(
      item.id,
      { model: config.transcribeModel, language: result.language || config.transcribeLang, paramsKey: paramsKey(), duration: dur },
      segments
    );
    return {
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

module.exports = { transcribeRecording, paramsKey };
