/**
 * Central config: reads .env (via dotenv) and resolves data paths.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT = path.join(__dirname, '..');

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes)$/i.test(String(v).trim());
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || './data');
const downloadDir = path.resolve(ROOT, process.env.DOWNLOAD_DIR || './downloads');

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

  // Web UI / API
  accessToken: process.env.ACCESS_TOKEN || '',
  port: int(process.env.PORT, 3100),

  // Scanning
  scanIntervalMinutes: int(process.env.SCAN_INTERVAL_MINUTES, 360),
  periods: list(process.env.PERIODS),
  downloadRecordings: bool(process.env.DOWNLOAD_RECORDINGS, true),
  recordingTimeoutMin: int(process.env.RECORDING_TIMEOUT_MIN, 90),

  timezone: process.env.TZ || 'Asia/Jakarta',
};

config.ensureDirs = function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.downloadDir, { recursive: true });
};

module.exports = config;
