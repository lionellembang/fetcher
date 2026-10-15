/**
 * Entrypoint: start the web server, schedule periodic scans, and run one scan
 * on boot.
 */
const config = require('./src/config');
const { startServer } = require('./src/server');
const { runScan, isScanning } = require('./src/scan');

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

  const minutes = config.scanIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes < 1) {
    console.error(`✗ Invalid SCAN_INTERVAL_MINUTES "${minutes}" — skipping scheduler.`);
  } else {
    setInterval(() => safeScan('interval'), minutes * 60 * 1000);
    console.log(`→ Scheduled scan: every ${minutes} minute(s).`);
  }

  safeScan('startup');
}

main();
