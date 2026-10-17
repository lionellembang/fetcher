/**
 * Probe stage: a recording's duration and loudness, and what the hub's
 * thresholds (SILENT_DB, QUIET_DB, …) make of them.
 */
const config = require('./config');
const { run, tailLines, duration } = require('../shared/media');

/**
 * { duration, maxVolume, meanVolume } in seconds / dB. A file with no audio
 * stream reports -Infinity for both volumes. Decodes only the audio.
 */
async function probe(file) {
  const dur = await duration(file);
  const r = await run(
    config.ffmpegBin,
    ['-nostats', '-hide_banner', '-vn', '-i', file, '-map', '0:a:0?', '-af', 'volumedetect', '-f', 'null', '-'],
    { timeoutMs: 30 * 60000 }
  );
  if (r.code !== 0) throw new Error(`ffmpeg volumedetect failed: ${tailLines(r.stderr, 5)}`);
  const db = (name) => {
    const m = r.stderr.match(new RegExp(`${name}:\\s*(-?[\\d.]+|-inf) dB`));
    if (!m) return -Infinity; // no audio stream → nothing measured
    return m[1] === '-inf' ? -Infinity : parseFloat(m[1]);
  };
  return { duration: dur, maxVolume: db('max_volume'), meanVolume: db('mean_volume') };
}

/**
 * { silent, quiet } from probe() numbers (peak and average dB). Worked out on
 * use, not stored, so changing the thresholds needs no re-probe.
 */
function audioClass({ maxVolume, meanVolume }) {
  const max = maxVolume == null ? -Infinity : maxVolume;
  const mean = meanVolume == null ? -Infinity : meanVolume;
  const silent = max < config.silentDb || mean < config.silentMeanDb;
  return { silent, quiet: !silent && (max < config.quietDb || mean < config.quietMeanDb) };
}

module.exports = { probe, audioClass };
