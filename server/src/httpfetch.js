/**
 * Resumable HTTP download into <dest>.part: a broken or stalled transfer
 * resumes where it stopped (HTTP Range), up to `attempts` times; a stall of
 * `stallMs` counts as broken. The size is checked when it's known, then the
 * file is renamed into place.
 *
 * Used for SharePoint recordings (recordings.js, with the browser's cookies)
 * and by a compute node fetching originals from its hub (node/agent.js).
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

class NotServedError extends Error {} // the server won't hand the file over (refused, or a web page instead)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download into `dest` (absolute) via `${dest}.part`, trying each of `urls`
 * until one serves the file. Returns the size. Throws NotServedError if none
 * will serve it.
 *
 *   expectedSize   checked when given; a shorter file is resumed
 *   headers        object, or async (origin) => object, asked again on every attempt
 *   resume         keep a .part from before and continue it (default: start over)
 *   rotateOnError  after a broken attempt, resume from the next URL (mirrors of one file)
 *   notServed      HTTP statuses that mean "won't serve it" (default 401, 403, 404)
 *   signal         AbortSignal that stops the download
 */
async function download(
  urls,
  dest,
  {
    expectedSize,
    headers = {},
    attempts = 6,
    retryBaseMs = 5000,
    stallMs = 90000,
    timeoutMs = 90 * 60000,
    resume = false,
    rotateOnError = false,
    notServed = [401, 403, 404],
    signal,
    log = console.log,
  } = {}
) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const deadline = Date.now() + timeoutMs;
  const minutes = Math.round(timeoutMs / 60000);
  const headersFor = async (u) => (typeof headers === 'function' ? headers(new URL(u).origin) : headers);
  if (!resume) fs.rmSync(part, { force: true });

  let url = null; // the URL that served the file; later attempts resume from it
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) throw signal.reason || new Error('aborted');
    if (Date.now() > deadline) throw new Error(`download took longer than ${minutes} min`);
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (attempt > 1) {
      if (rotateOnError && url) url = urls[(urls.indexOf(url) + 1) % urls.length];
      log(`  … resuming at ${have} B (attempt ${attempt}/${attempts}): ${lastErr.message}`);
      await sleep(retryBaseMs * attempt);
    }
    const opts = { notServed, stallMs, deadline, minutes, signal };
    try {
      if (url) {
        await fetchInto(url, part, have, await headersFor(url), opts);
      } else {
        const refused = [];
        for (const u of urls) {
          try {
            await fetchInto(u, part, have, await headersFor(u), opts);
            url = u;
            break;
          } catch (err) {
            if (!(err instanceof NotServedError)) {
              url = u; // it served the file, then broke (or couldn't connect): resume from here
              throw err;
            }
            refused.push(`${new URL(u).pathname.split('/').pop()}: ${err.message}`);
          }
        }
        if (!url) throw new NotServedError(refused.join('; '));
      }
    } catch (err) {
      if (err instanceof NotServedError || (signal && signal.aborted)) {
        if (!resume) fs.rmSync(part, { force: true });
        throw err;
      }
      lastErr = err;
      continue;
    }
    const size = fs.statSync(part).size;
    if (expectedSize && size !== expectedSize) {
      lastErr = new Error(`transfer ended early: ${size} of ${expectedSize} bytes`);
      if (size > expectedSize) fs.rmSync(part, { force: true }); // not the file we were promised: start over
      continue;
    }
    fs.renameSync(part, dest);
    if (attempt > 1) log(`  … completed after ${attempt} attempts`);
    return size;
  }
  if (!resume) fs.rmSync(part, { force: true });
  throw new Error(`download kept breaking off after ${attempts} attempts (last: ${lastErr.message})`);
}

/**
 * GET `url` into `part`, from byte `offset` (HTTP Range) when it's > 0. If the
 * server ignores the range, the file is restarted. Aborts after `stallMs` with
 * no data.
 */
async function fetchInto(url, part, offset, headers, { notServed, stallMs, deadline, minutes, signal }) {
  const ac = new AbortController();
  let stall;
  const bump = () => {
    clearTimeout(stall);
    stall = setTimeout(() => ac.abort(new Error(`no data for ${stallMs / 1000}s`)), stallMs);
  };
  const overall = setTimeout(() => ac.abort(new Error(`past the ${minutes} min download limit`)), Math.max(0, deadline - Date.now()));
  const onAbort = () => ac.abort(signal.reason || new Error('aborted'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  bump();
  try {
    const res = await fetch(url, { headers: offset ? { ...headers, range: `bytes=${offset}-` } : headers, signal: ac.signal });
    if (notServed.includes(res.status)) throw new NotServedError(`HTTP ${res.status}`);
    if (res.status === 416 && offset) return; // already complete
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new NotServedError('got a web page (sign-in?) instead of the file');
    const append = offset > 0 && res.status === 206;
    const body = Readable.fromWeb(res.body);
    body.on('data', bump);
    await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
  } catch (err) {
    if (err instanceof NotServedError) throw err;
    const reason = ac.signal.aborted && ac.signal.reason ? ac.signal.reason.message : err.cause ? `${err.message} (${err.cause.code || err.cause.message})` : err.message;
    throw new Error(reason);
  } finally {
    clearTimeout(stall);
    clearTimeout(overall);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { download, NotServedError };
