/**
 * The saved session (data/session.json): LMS API headers + token expiry.
 *
 * A login (Playwright, cold, .env credentials) happens only when the session is
 * unusable: missing, past its expiry, or rejected by the API (caller passes
 * force). Concurrent callers share one in-flight login.
 */
const fs = require('fs');
const config = require('./config');
const { login } = require('./login');

let inFlight = null;

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(config.sessionFile, 'utf8'));
  } catch {
    return null;
  }
}

function isExpired(session) {
  if (!session || !session.headers || !session.headers.authorization) return true;
  const exp = Date.parse(session.expiresAt);
  if (Number.isNaN(exp)) return false; // unknown expiry → trust it until a 401
  return exp <= Date.now();
}

/**
 * Return a usable session, logging in if needed. Pass { force: true } to log in
 * even if the saved one looks valid (e.g. after a 401).
 */
function getSession({ force = false } = {}) {
  const current = readSession();
  if (!force && !isExpired(current)) return Promise.resolve(current);

  if (inFlight) {
    console.log('→ Login already running — waiting on it.');
    return inFlight;
  }
  inFlight = (async () => {
    config.ensureDirs();
    console.log(force ? '→ Forcing a new login …' : '→ No usable session — logging in …');
    const session = await login();
    fs.writeFileSync(config.sessionFile, JSON.stringify(session, null, 2), { mode: 0o600 });
    console.log(`✓ Session saved (token expires ${session.expiresAt}).`);
    return session;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

module.exports = { getSession, readSession, isExpired };
