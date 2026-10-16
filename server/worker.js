/**
 * Worker: the backend. Resumes the processing pipeline (probe, cut,
 * transcribe, index), scans the LMS on boot and every SCAN_INTERVAL_MINUTES,
 * and is the only process that writes pipeline state or talks to the LMS.
 *
 * The web process (web.js) sends it commands on 127.0.0.1:WORKER_PORT:
 *
 *   GET  /status                    → { lastScan, scanning, pipeline }
 *   POST /scan                      → { started, scanning }
 *   POST /retry  { itemId, stage }  → { result }
 *   GET  /recording-link/<session>  → { url }   (fresh SharePoint link)
 *
 * Restarting the web process doesn't touch running work; restarting this one
 * redoes only the stages that were running (see pipeline.js).
 */
const express = require('express');
const config = require('./src/config');
const store = require('./src/store');
const lms = require('./src/lms');
const { runScan, isScanning } = require('./src/scan');
const pipeline = require('./src/pipeline');
const media = require('./src/media');

async function safeScan(reason) {
  if (isScanning()) {
    console.log(`(scan trigger: ${reason}) skipped — previous scan still running`);
    return;
  }
  try {
    console.log(`(scan trigger: ${reason})`);
    await runScan();
  } catch (err) {
    console.error('✗ scan failed:', err.message);
  }
}

function controlApi() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/status', (req, res) => {
    res.json({ lastScan: store.getMeta('last_scan'), scanning: isScanning(), pipeline: pipeline.status() });
  });

  app.post('/scan', (req, res) => {
    const already = isScanning();
    safeScan('requested');
    res.status(202).json({ started: !already, scanning: true });
  });

  app.post('/retry', (req, res) => {
    const { itemId, stage } = req.body || {};
    try {
      res.status(202).json({ result: pipeline.retry(String(itemId), String(stage)) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/recording-link/:sessionId', async (req, res) => {
    try {
      const rec = await lms.zoomRecording(req.params.sessionId);
      if (!rec || !rec.recordingUrl) return res.status(404).json({ error: 'No recording for this session (yet).' });
      res.json({ url: rec.recordingUrl });
    } catch (err) {
      res.status(502).json({ error: `Could not get the recording link: ${err.message}` });
    }
  });

  return app;
}

function main() {
  config.ensureDirs();

  // Local only: the web process is the public face.
  controlApi().listen(config.workerPort, '127.0.0.1', () => console.log(`→ Worker control API on 127.0.0.1:${config.workerPort}`));
  pipeline.start();

  const minutes = config.scanIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes < 1) {
    console.error(`✗ Invalid SCAN_INTERVAL_MINUTES "${minutes}" — skipping scheduler.`);
  } else {
    // setInterval takes a 32-bit delay (~24.8 days); anything longer would fire immediately.
    setInterval(() => safeScan('interval'), Math.min(minutes * 60 * 1000, 2 ** 31 - 1));
    console.log(`→ Scheduled scan: every ${minutes} minute(s).`);
  }

  safeScan('startup');

  // Stop child tools (auto-editor, ffmpeg) with us; unfinished stages restart on the next boot.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`→ ${sig}: stopping.`);
      media.killAll();
      process.exit(0);
    });
  }
}

main();
