/**
 * Central config: reads .env (via dotenv) and resolves data paths.
 *
 * The .env lives at the repo root (shared with the transcriber and
 * scripts/start.sh); server/.env is still read as a fallback. Relative paths
 * (DATA_DIR, DOWNLOAD_DIR) resolve against the repo root.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
require('dotenv').config({ path: [path.join(REPO, '.env'), path.join(ROOT, '.env')], quiet: true });

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

const dataDir = path.resolve(REPO, process.env.DATA_DIR || './data');
const downloadDir = path.resolve(REPO, process.env.DOWNLOAD_DIR || './downloads');

const config = {
  root: ROOT,
  dataDir,
  downloadDir,
  sessionFile: path.join(dataDir, 'session.json'),
  dbFile: path.join(dataDir, 'downloads.db'),

  // BINUSMAYA login (Playwright)
  username: process.env.BINUS_USERNAME || '',
  password: process.env.BINUS_PASSWORD || '',
  headful: bool(process.env.HEADFUL, false),
  loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 3),
  loginRetryDelaySec: int(process.env.LOGIN_RETRY_DELAY_SEC, 30),
  loginAttemptTimeoutSec: int(process.env.LOGIN_ATTEMPT_TIMEOUT_SEC, 300),

  // Web UI / API / MCP
  accessToken: process.env.ACCESS_TOKEN || '',
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 3100),
  // The worker (scan + pipeline) takes commands from the web process on this
  // local-only port.
  workerPort: int(process.env.WORKER_PORT, 3101),
  // Base URL for links handed out by MCP (e.g. https://lectures.example.com).
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 3100)}`).replace(/\/+$/, ''),

  // Scanning
  scanIntervalMinutes: int(process.env.SCAN_INTERVAL_MINUTES, 360),
  periods: list(process.env.PERIODS),
  downloadRecordings: bool(process.env.DOWNLOAD_RECORDINGS, true),
  recordingTimeoutMin: int(process.env.RECORDING_TIMEOUT_MIN, 90),

  // Tools
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  autoEditorBin: process.env.AUTO_EDITOR_BIN || 'auto-editor',

  // Pipeline: at most this many cut + transcribe jobs at once (1 = never overlap them).
  heavyConcurrency: Math.max(1, int(process.env.HEAVY_CONCURRENCY, 2)),

  // Probe: a peak below SILENT_DB, or an average below SILENT_MEAN_DB (e.g. silence
  // plus one click), = no audio: cut + transcribe are skipped. A peak below QUIET_DB
  // or an average below QUIET_MEAN_DB = quiet (loudness-normalised before Whisper).
  // Normal lectures average about -25 dB; a very quiet one about -48 dB.
  silentDb: num(process.env.SILENT_DB, -60),
  silentMeanDb: num(process.env.SILENT_MEAN_DB, -55),
  quietDb: num(process.env.QUIET_DB, -20),
  quietMeanDb: num(process.env.QUIET_MEAN_DB, -40),

  // Cut (auto-editor), tuned in the cutting repo's run 2
  cutEnabled: bool(process.env.CUT_ENABLED, true),
  cutEdit: process.env.CUT_EDIT || 'audio:-30dB',
  cutMargin: process.env.CUT_MARGIN || '0.3s,0.5s',
  cutExtraArgs: String(process.env.CUT_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
  cutTimeoutMin: int(process.env.CUT_TIMEOUT_MIN, 180),

  // Transcribe (transcriber/ Whisper server)
  whisperUrl: (process.env.WHISPER_URL || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
  transcribeEnabled: bool(process.env.TRANSCRIBE_ENABLED, true),
  transcribeLang: process.env.TRANSCRIBE_LANG || 'id',
  transcribeModel: process.env.TRANSCRIBE_MODEL || process.env.WHISPER_MODEL || 'large-v3',
  transcribeGateDb: num(process.env.TRANSCRIBE_GATE_DB, 12),
  transcribeLoudnorm: process.env.TRANSCRIBE_LOUDNORM || 'quiet', // quiet | always | never

  // Index (embeddings for search, via the transcriber's /embed)
  indexEnabled: bool(process.env.INDEX_ENABLED, true),
  embedModel: process.env.EMBED_MODEL || 'intfloat/multilingual-e5-base',
  chunkWindowSec: num(process.env.CHUNK_WINDOW_SEC, 45),
  chunkOverlapSec: num(process.env.CHUNK_OVERLAP_SEC, 15),

  // Search match labels. A passage needs the cosine floor, and (once at least
  // SEARCH_MIN_CHUNKS_FOR_Z chunks are indexed) must stand out from the query's
  // average over all chunks by the z-score. Tune with real study questions.
  searchStrongCos: num(process.env.SEARCH_STRONG_COS, 0.82),
  searchPossibleCos: num(process.env.SEARCH_POSSIBLE_COS, 0.795),
  searchStrongZ: num(process.env.SEARCH_STRONG_Z, 3),
  searchPossibleZ: num(process.env.SEARCH_POSSIBLE_Z, 2),
  searchMinChunksForZ: int(process.env.SEARCH_MIN_CHUNKS_FOR_Z, 200),

  timezone: process.env.TZ || 'Asia/Jakarta',

  // Where cut + transcribe run: 'local' (this machine, as always) or 'remote'
  // (queued for a compute node that pulls them over the /node API).
  compute: (process.env.COMPUTE || 'local').trim().toLowerCase(),
  // Shared secret between the hub and its compute node (separate from ACCESS_TOKEN).
  nodeToken: process.env.NODE_TOKEN || '',
  // Hub: a second listener for the compute node on the LAN, serving only /node.
  nodeHost: process.env.NODE_HOST || '0.0.0.0',
  nodePort: int(process.env.NODE_PORT, 3102),
  // A leased job goes back to the queue when its node hasn't sent a heartbeat for this long.
  nodeLeaseSec: int(process.env.NODE_LEASE_SEC, 600),

  // Compute node: the hub's node API on the LAN, e.g. http://192.168.1.20:3102
  hubUrl: String(process.env.HUB_URL || '').trim().replace(/\/+$/, ''),
  nodeId: process.env.NODE_ID || os.hostname(),
  nodeStages: list(process.env.NODE_STAGES || 'cut,transcribe'),
  nodeCacheDir: path.resolve(REPO, process.env.NODE_CACHE_DIR || './data/node-cache'),
  // Originals kept on the node (least recently used go first), so cut and
  // transcribe of the same lecture download it once.
  nodeCacheGb: num(process.env.NODE_CACHE_GB, 20),
};

if (!['local', 'remote'].includes(config.compute)) {
  throw new Error(`COMPUTE must be "local" or "remote", not "${process.env.COMPUTE}"`);
}

// Search embeddings: the transcriber's /embed by default; on a hub, the separate
// embedding server (transcriber/embed_server.py).
config.embedUrl = (process.env.EMBED_URL || config.whisperUrl).replace(/\/+$/, '');

config.tmpDir = path.join(dataDir, 'tmp');

config.ensureDirs = function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.downloadDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
};

module.exports = config;
