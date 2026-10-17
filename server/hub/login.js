/**
 * Playwright login (cold, with the .env credentials) that captures what the
 * HTTP client needs: the LMS API headers — the Bearer token plus the role
 * headers — read off the first API request the LMS front-end makes after login.
 *
 * Click path (same as calendar-bm, verified there):
 *   binusmaya.binus.ac.id → "Sign in with Microsoft" → email + password →
 *   dashboard "LMS" tile (opens a new tab on lms.binus.ac.id) → LMS fires API calls.
 *
 * Every attempt is a brand-new Chromium process with an empty context; nothing
 * from an earlier attempt or run is reused. Failed attempts are retried from
 * scratch.
 */
const config = require('./config');
const { launchColdBrowser, shutdownBrowser, withTimeout } = require('./browser');

// Any LMS API call carries the headers we want.
const LMS_API_RE = /^https:\/\/(apim-bm7[\w-]*\.azure-api\.net|func-bm7[\w-]*\.azurewebsites\.net)\//i;
const KEEP_HEADERS = ['authorization', 'roleid', 'roid', 'rolename', 'academiccareer', 'institution'];

const STEP_TIMEOUT_MS = 30000;
const CAPTURE_TIMEOUT_MS = 60000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPasswordSet() {
  return !!config.password && config.password !== 'PUT_YOUR_PASSWORD_HERE';
}

/** Log in and capture a session. */
async function login() {
  if (!config.username || !isPasswordSet()) {
    throw new Error('BINUS_USERNAME / BINUS_PASSWORD must be set in .env.');
  }

  const attempts = Math.max(1, config.loginMaxAttempts);
  const timeoutMs = Math.max(1, config.loginAttemptTimeoutSec) * 1000;
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      console.log(`↻ Cold-start login retry ${attempt}/${attempts} in ${config.loginRetryDelaySec}s …`);
      await sleep(Math.max(0, config.loginRetryDelaySec) * 1000);
    }

    let handle;
    try {
      handle = await launchColdBrowser(`Login attempt ${attempt}`);
      // If the deadline wins, runLogin() keeps going until the browser is torn
      // down; swallow its late rejection so it can't crash the process.
      const run = runLogin(handle.browser);
      run.catch(() => {});
      return await withTimeout(run, timeoutMs, `login attempt exceeded ${config.loginAttemptTimeoutSec}s`);
    } catch (err) {
      lastErr = err;
      console.error(`✗ Login attempt ${attempt}/${attempts} failed: ${err.message}`);
    } finally {
      if (handle) await shutdownBrowser(handle);
    }
  }

  throw new Error(`Login failed after ${attempts} attempt(s): ${lastErr ? lastErr.message : 'unknown error'}`);
}

async function runLogin(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Listen at the CONTEXT level: the LMS opens in a new tab.
  let onRequest;
  const captured = new Promise((resolve) => {
    onRequest = (req) => {
      if (!LMS_API_RE.test(req.url())) return;
      const h = req.headers();
      if (!/^Bearer\s+\S+/i.test(h.authorization || '') || !h.roleid) return;
      resolve(Object.fromEntries(KEEP_HEADERS.filter((k) => h[k]).map((k) => [k, h[k]])));
    };
    context.on('request', onRequest);
  });

  console.log('→ Opening BINUSMAYA …');
  const lmsTile = await reachDashboard(page);
  const lms = await openLms(page, context, lmsTile);

  console.log('→ Waiting for an LMS API request …');
  let headers = await withTimeout(captured, 20000, 'no API request yet').catch(() => null);
  if (!headers) {
    // The dashboard didn't call the API on its own — the Schedule page always does.
    console.log('→ Opening the Schedule page to trigger an API request …');
    const scheduleLink = lms.getByRole('link', { name: 'Schedule', exact: true });
    await scheduleLink.waitFor({ timeout: STEP_TIMEOUT_MS });
    await scheduleLink.click();
    headers = await withTimeout(captured, CAPTURE_TIMEOUT_MS, 'Timed out waiting for an LMS API request.');
  }
  context.off('request', onRequest);
  console.log('✓ Captured LMS API headers.');

  return {
    capturedAt: new Date().toISOString(),
    headers,
    expiresAt: decodeJwtExp(headers.authorization),
  };
}

/**
 * Sign in and wait until the dashboard has fully loaded (the "LMS" tile is
 * visible). BINUSMAYA's post-login redirect sometimes stalls on /home; that
 * fails the attempt and the next one starts from scratch.
 *
 * The dashboard carousel clones slides, so `:visible` picks the on-screen tile.
 */
async function reachDashboard(page) {
  const lmsTile = page.locator('img[alt="LMS"]:visible').first();

  await page.goto('https://binusmaya.binus.ac.id/', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});

  console.log('→ Signing in via Microsoft …');
  const signInBtn = page.getByRole('button', { name: /Sign in with Microsoft/i });
  await signInBtn.waitFor({ timeout: STEP_TIMEOUT_MS });
  await signInBtn.click();
  await doMicrosoftLogin(page, /binusmaya\.binus\.ac\.id/);

  console.log('→ Waiting for the dashboard to finish loading …');
  const ok = await lmsTile
    .waitFor({ timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) throw new Error('Dashboard stalled on /home after sign-in.');
  return lmsTile;
}

/** Click the "LMS" tile; it opens the LMS in a new tab. */
async function openLms(page, context, lmsTile) {
  console.log('→ Opening the LMS …');
  const popupPromise = context.waitForEvent('page', { timeout: STEP_TIMEOUT_MS }).catch(() => null);
  await lmsTile.click();
  const popup = await popupPromise;
  const lms = popup || page;
  await lms.waitForLoadState('domcontentloaded').catch(() => {});
  return lms;
}

/**
 * Microsoft Entra sign-in pages: #idSIButton9 is the primary button on every
 * step. The context is always empty, so the email form must appear. `doneUrl`
 * (anything page.waitForURL accepts) is where the sign-in should land.
 */
async function doMicrosoftLogin(page, doneUrl) {
  if (!config.username || !isPasswordSet()) {
    throw new Error('BINUS_USERNAME / BINUS_PASSWORD must be set in .env.');
  }

  const email = page.locator('input[type="email"]');
  await email.waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => {
    throw new Error(`Microsoft email prompt never appeared (at ${page.url()}).`);
  });

  await email.fill(config.username);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  const pwd = page.locator('input[type="password"]');
  await pwd.waitFor({ timeout: 15000 });
  await pwd.fill(config.password);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  // "Stay signed in?" — answer it if it appears.
  try {
    await page.locator('#idSIButton9').waitFor({ timeout: 8000 });
    await page.locator('#idSIButton9').click();
  } catch {
    /* prompt didn't appear — fine */
  }

  await page.waitForURL(doneUrl, { timeout: 30000 });
}

function decodeJwtExp(token) {
  const raw = (token || '').replace(/^Bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

module.exports = { login, doMicrosoftLogin, decodeJwtExp };
