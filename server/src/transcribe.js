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

    // ~5× real time on the GPU; give up if it's slower than 2× real time (min 10 min).
    const dur = (probeMeta && probeMeta.duration) || 3600;
    const timeoutMs = Math.max(10 * 60, dur * 0.5) * 1000;
    const started = Date.now();
    const result = await whisper.transcribe(audio, {
      language: config.transcribeLang,
      model: config.transcribeModel,
      gateDb: config.transcribeGateDb,
      timeoutMs,
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
