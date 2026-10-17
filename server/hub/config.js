/**
 * The hub's config: the settings both machines share (shared/env.js) plus
 * everything only the hub uses: the LMS login, web/MCP, scanning, the
 * pipeline's settings, search, and the compute node link.
 */
const fs = require('fs');
const path = require('path');
const { config: shared, bool, int, num, list, repoPath } = require('../shared/env');

const { dataDir } = shared;
const downloadDir = repoPath(process.env.DOWNLOAD_DIR, './downloads');

const config = {
  ...shared,
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

  // Cut (auto-editor), tuned in docs/cutting (run 2)
  cutEnabled: bool(process.env.CUT_ENABLED, true),
  cutEdit: process.env.CUT_EDIT || 'audio:-30dB',
  cutMargin: process.env.CUT_MARGIN || '0.3s,0.5s',
  cutExtraArgs: String(process.env.CUT_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),

  // Transcribe (the Whisper server, compute/transcriber, at WHISPER_URL)
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
  // A listener for the compute node on the LAN, serving only /node.
  nodeHost: process.env.NODE_HOST || '0.0.0.0',
  nodePort: int(process.env.NODE_PORT, 3102),
  // A leased job goes back to the queue when its node hasn't sent a heartbeat for this long.
  nodeLeaseSec: int(process.env.NODE_LEASE_SEC, 600),
};

if (!['local', 'remote'].includes(config.compute)) {
  throw new Error(`COMPUTE must be "local" or "remote", not "${process.env.COMPUTE}"`);
}

// Search embeddings: the transcriber's /embed by default; on a hub, the separate
// embedding server (hub/embed-server).
config.embedUrl = (process.env.EMBED_URL || config.whisperUrl).replace(/\/+$/, '');

config.ensureDirs = function ensureDirs() {
  shared.ensureDirs();
  fs.mkdirSync(config.downloadDir, { recursive: true });
};

module.exports = config;
