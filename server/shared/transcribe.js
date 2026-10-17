/**
 * Transcribe a recording (the ORIGINAL, not the cut) with the Whisper server
 * on this machine: extract 16 kHz mono FLAC (loudness-normalised when asked),
 * send it, and wait for the segments. Whisper's own VAD + loudness gate skip
 * the silences. Nothing is stored: the hub saves the transcript.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./env');
const whisper = require('./whisper');
const { extractAudio } = require('./media');

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

module.exports = { transcribeFile, cleanSegments };
