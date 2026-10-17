/**
 * Browser lifecycle for logins and recording downloads. Each run boots a
 * brand-new Chromium process through launchServer() so we hold the real OS
 * process: its PID proves the run is a cold start, and kill() tears it down
 * even if a graceful close hangs.
 */
const { chromium } = require('playwright');
const config = require('./config');

const CLOSE_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launchColdBrowser(label) {
  const server = await chromium.launchServer({ headless: !config.headful });
  const pid = server.process().pid;
  const browser = await chromium.connect(server.wsEndpoint());
  console.log(`→ ${label}: launched a fresh Chromium (pid ${pid}).`);
  return { server, browser, pid };
}

async function shutdownBrowser({ server, browser, pid }) {
  await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, 'browser.close() timed out').catch((err) =>
    console.error(`⚠ ${err.message}`)
  );
  try {
    await withTimeout(server.close(), CLOSE_TIMEOUT_MS, 'graceful shutdown timed out');
  } catch (err) {
    console.error(`⚠ Chromium pid ${pid}: ${err.message} — killing it.`);
    await server.kill();
  }
  if (isAlive(pid)) await server.kill();

  if (isAlive(pid)) console.error(`⚠ Chromium pid ${pid} is still running after kill.`);
  else console.log(`→ Browser closed (pid ${pid} exited).`);
}

module.exports = { launchColdBrowser, shutdownBrowser, withTimeout };
