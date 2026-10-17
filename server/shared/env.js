/**
 * Settings both machines read from .env, and the parsers hub/config.js and
 * compute/config.js build on.
 *
 * The .env lives at the repo root (shared with the transcriber and
 * scripts/fetcher); server/.env is still read as a fallback. Relative paths
 * (DATA_DIR, …) resolve against the repo root.
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const REPO = path.join(SERVER, '..');
require('dotenv').config({ path: [path.join(REPO, '.env'), path.join(SERVER, '.env')], quiet: true });

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes)$/i.test(String(v).trim());
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function num(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A path from .env, relative to the repo root. */
const repoPath = (v, def) => path.resolve(REPO, v || def);

const dataDir = repoPath(process.env.DATA_DIR, './data');

const config = {
  dataDir,
  // Big temporary files (audio for Whisper); on disk, not in RAM.
  tmpDir: path.join(dataDir, 'tmp'),

  // Tools (defaults: found on PATH)
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  autoEditorBin: process.env.AUTO_EDITOR_BIN || 'auto-editor',
  cutTimeoutMin: int(process.env.CUT_TIMEOUT_MIN, 180),

  // The Whisper transcriber on this machine (compute/transcriber/server.py)
  whisperUrl: (process.env.WHISPER_URL || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
};

config.ensureDirs = function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
};

module.exports = { config, bool, int, num, list, repoPath };
