/**
 * ffmpeg / ffprobe helpers: run a tool, read a file's duration and loudness,
 * extract 16 kHz mono audio for Whisper.
 */
const { spawn } = require('child_process');
const config = require('./config');

const MAX_OUTPUT = 4 * 1024 * 1024; // keep at most the last 4 MB of a tool's output
const children = new Set(); // running tools, so shutdown can stop them

/** Kill every running tool (on shutdown, so no auto-editor/ffmpeg is left orphaned). */
function killAll() {
  for (const child of children) child.kill('SIGKILL');
}

/**
 * Run a command and resolve { code, stdout, stderr } (never rejects on a
 * non-zero exit). Rejects if it can't be started or runs past `timeoutMs`.
 */
function run(cmd, args, { timeoutMs = 0, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
    children.add(child);
    let stdout = '';
    let stderr = '';
    const keep = (buf, chunk) => (buf + chunk).slice(-MAX_OUTPUT);
    child.stdout.on('data', (c) => (stdout = keep(stdout, c)));
    child.stderr.on('data', (c) => (stderr = keep(stderr, c)));

    let timer;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} took longer than ${Math.round(timeoutMs / 60000)} min`));
      }, timeoutMs);
    }
    child.on('error', (err) => {
      children.delete(child);
      clearTimeout(timer);
      reject(new Error(`couldn't run ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      children.delete(child);
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Last `n` meaningful lines of tool output: progress-bar redraws and colour codes removed. */
function tailLines(text, n = 20) {
  return String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('⏳'))
    .slice(-n)
    .join('\n');
}

/** Duration in seconds (container), or null. */
async function duration(file) {
  const r = await run(config.ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    timeoutMs: 60000,
  });
  const d = parseFloat(r.stdout);
  return Number.isFinite(d) ? d : null;
}

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

/** Write 16 kHz mono FLAC (what Whisper uses internally), optionally loudness-normalised. */
async function extractAudio(file, out, { loudnorm = false } = {}) {
  const args = ['-v', 'error', '-y', '-i', file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000'];
  if (loudnorm) args.push('-af', 'loudnorm=I=-20:TP=-2:LRA=11');
  args.push('-c:a', 'flac', out);
  const r = await run(config.ffmpegBin, args, { timeoutMs: 30 * 60000 });
  if (r.code !== 0) throw new Error(`ffmpeg audio extract failed: ${tailLines(r.stderr, 5)}`);
}

module.exports = { run, killAll, tailLines, duration, probe, extractAudio };
