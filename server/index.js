/**
 * Entrypoint: start the web server, resume the processing pipeline (cut,
 * transcribe, index), schedule periodic scans, and run one scan on boot.
 */
const config = require('./src/config');
const { startServer } = require('./src/server');
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

function main() {
  config.ensureDirs();
  if (!config.accessToken || config.accessToken === 'change-me') {
    console.warn('⚠ ACCESS_TOKEN is unset/default — set a strong value in .env.');
  }

  startServer();
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
