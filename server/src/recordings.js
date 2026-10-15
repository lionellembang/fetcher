/**
 * Recording downloads from SharePoint, done entirely in one Playwright browser.
 *
 * The LMS recording endpoint returns a fresh (~12h) SharePoint share link
 * (guestaccess.aspx?share=…) on a bm5-zoomN site. The link isn't anonymous:
 * opening it redirects to the Microsoft sign-in. So each batch runs like this:
 *
 *   cold Chromium → for each recording that isn't on disk yet:
 *     fresh recordingUrl (LMS API) → open it in the browser
 *       → Microsoft sign-in with the .env credentials (first recording only;
 *         the SharePoint cookies carry over to the rest of the batch)
 *       → lands on the player (stream.aspx?id=<server-relative file path>)
 *     → file name + size from SharePoint's REST API (same cookies)
 *     → Playwright download of <site>/_layouts/15/download.aspx?SourceUrl=<path>,
 *       falling back to the share link with download=1
 *     → <file>.part, size check, rename
 *
 * A failed recording is marked `failed` and retried on the next run. A failed
 * sign-in stops the batch without touching any item.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const lms = require('./lms');
const store = require('./store');
const { launchColdBrowser, shutdownBrowser, withTimeout } = require('./browser');
const { doMicrosoftLogin } = require('./login');

const NAV_TIMEOUT_MS = 60000;
const DOWNLOAD_START_TIMEOUT_MS = 60000;
const VIDEO_PATH_RE = /\/(?:sites|teams)\/[^"'<>?#\\]+?\.(?:mp4|m4a|mov|mkv|webm)/i;

class SignInError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Make a string safe as a single path segment on macOS/Linux/Windows. */
function safeName(s, max = 120) {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'untitled').slice(0, max).trim();
}

/** Absolute path for `relPath` under DOWNLOAD_DIR, with its folder created. */
function resolveDest(relPath) {
  const dest = path.join(config.downloadDir, relPath);
  if (!dest.startsWith(config.downloadDir + path.sep)) throw new Error(`Refusing to write outside DOWNLOAD_DIR: ${relPath}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return dest;
}

const isMsLogin = (u) => /^login\.(microsoftonline|microsoft|live)\.com$/i.test(u.hostname);
const isSharePointContent = (u) =>
  /\.sharepoint\.com$/i.test(u.hostname) &&
  !/\/(authenticate|guestaccess)\.aspx$/i.test(u.pathname) &&
  !/^\/_forms\//i.test(u.pathname);

const onDisk = (it) => !!it.file_path && fs.existsSync(path.join(config.downloadDir, it.file_path));
const needsDownload = (it) =>
  it.status === 'available' || it.status === 'failed' || (it.status === 'downloaded' && !onDisk(it));

/** Recordings to download: all that aren't on disk, or just those for `sessionIds`. */
function pendingRecordings(sessionIds) {
  const all = store.listItems({ kind: 'recording' });
  if (!sessionIds || !sessionIds.length) return all.filter(needsDownload);

  const want = new Set(sessionIds.map(String));
  const picked = all.filter((it) => want.has(String(it.session_id)));
  const missing = [...want].filter((id) => !picked.some((it) => String(it.session_id) === id));
  if (missing.length) throw new Error(`No recording known for session(s) ${missing.join(', ')}. Run a scan first.`);
  for (const it of picked.filter((it) => !needsDownload(it))) {
    console.log(`→ Skipping session ${it.session_id}: ${it.status === 'not_yet' ? 'no recording yet' : 'already downloaded'}.`);
  }
  return picked.filter(needsDownload);
}

/**
 * Download every recording that isn't on disk yet (or only those for
 * `sessionIds`). Returns { pending, downloaded, failed }.
 */
async function downloadRecordings({ sessionIds } = {}) {
  config.ensureDirs();
  const items = pendingRecordings(sessionIds);
  const summary = { pending: items.length, downloaded: 0, failed: 0 };
  if (!items.length) return summary;

  console.log(`→ Downloading ${items.length} recording(s) from SharePoint …`);
  const handle = await launchColdBrowser('Recording downloads');
  try {
    const context = await handle.browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    for (const item of items) {
      const label = `${item.course_code} ${item.component} S${item.session_number}`;
      try {
        const { rel, size } = await downloadOne(page, item);
        store.markDownloaded(item.id, rel, size);
        summary.downloaded++;
        console.log(`  ↓ ${rel} (${size} B)`);
      } catch (err) {
        if (err instanceof SignInError) throw err;
        store.markFailed(item.id, err.message);
        summary.failed++;
        console.error(`  ✗ ${label} recording: ${err.message}`);
      }
    }
  } finally {
    await shutdownBrowser(handle);
  }
  console.log(`✓ Recordings: ${summary.downloaded} downloaded, ${summary.failed} failed.`);
  return summary;
}

async function downloadOne(page, item) {
  // Share links last ~12h, so always ask for a fresh one right before use.
  const rec = await lms.zoomRecording(item.session_id);
  if (!rec || !rec.recordingUrl) throw new Error('The LMS no longer returns a recording link for this session.');

  console.log(`→ ${item.course_code} ${item.component} S${item.session_number}: opening the recording …`);
  await openShareLink(page, rec.recordingUrl);
  const file = await locateFile(page);
  const info = await fileInfo(page, file);
  console.log(`  … ${file.path} (${info && info.size ? `${info.size} B expected` : 'size unknown, not checked'})`);

  const ext = path.extname((info && info.name) || file.path) || '.mp4';
  const nn = String(item.session_number).padStart(2, '0');
  const rel = path.join(
    safeName(item.period),
    safeName(`${item.course_code} ${item.course_title} (${item.component})`),
    safeName(`${item.course_code} ${item.component} S${nn} recording${ext}`)
  );

  const download = await startFirstDownload(page, [
    `${file.origin}${file.sitePath}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(file.path)}`,
    withParam(rec.recordingUrl, 'download', '1'),
  ]);
  const size = await saveDownload(download, rel, info && info.size);
  return { rel, size };
}

/**
 * Open a share link and end up on the SharePoint page behind it, signing in to
 * Microsoft when SharePoint asks for it.
 */
async function openShareLink(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForURL((u) => isMsLogin(u) || isSharePointContent(u), { timeout: NAV_TIMEOUT_MS });

  if (isMsLogin(new URL(page.url()))) {
    console.log('→ Signing in to SharePoint via Microsoft …');
    try {
      await doMicrosoftLogin(page, isSharePointContent);
    } catch (err) {
      throw new SignInError(`SharePoint sign-in failed: ${err.message}`);
    }
    console.log('✓ Signed in to SharePoint.');
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * Find the video behind the current SharePoint page: its server-relative path
 * (the player's `id` parameter, else the first video path in the page) and the
 * site it lives on.
 */
async function locateFile(page) {
  const found = await page.evaluate((reSource) => {
    const id = new URL(location.href).searchParams.get('id');
    const html = document.documentElement.innerHTML.replace(/\\u002f/gi, '/');
    const m = id ? null : html.match(new RegExp(reSource, 'i'));
    const ctx = window._spPageContextInfo || {};
    return { id, fromHtml: m ? m[0] : null, web: ctx.webServerRelativeUrl || null };
  }, VIDEO_PATH_RE.source);

  const filePath = found.id || (found.fromHtml && decodeURIComponent(found.fromHtml));
  if (!filePath || !filePath.startsWith('/')) {
    const title = await page.title().catch(() => '');
    throw new Error(`Couldn't find the video file on ${page.url().replace(/\?.*/, '')} (page title "${title}").`);
  }
  const sitePath =
    found.web && found.web !== '/' && filePath.startsWith(found.web + '/')
      ? found.web
      : filePath.split('/').slice(0, 3).join('/'); // /sites/bm5-zoom8
  return { origin: new URL(page.url()).origin, sitePath, path: filePath };
}

/**
 * { name, size } from SharePoint's REST API, or null if it won't say. Fetched
 * from inside the SharePoint page so it carries the browser's own cookies.
 */
async function fileInfo(page, file) {
  const quoted = encodeURIComponent(file.path.replace(/'/g, "''"));
  const url = `${file.origin}${file.sitePath}/_api/web/GetFileByServerRelativePath(decodedurl='${quoted}')?$select=Name,Length`;
  const j = await withTimeout(
    page.evaluate(async (u) => {
      const res = await fetch(u, { headers: { accept: 'application/json;odata=nometadata' }, credentials: 'include' });
      return res.ok ? res.json() : null;
    }, url),
    NAV_TIMEOUT_MS,
    'file info timed out'
  ).catch(() => null);
  return j && j.Name ? { name: j.Name, size: Number(j.Length) || undefined } : null;
}

/** Try each URL in turn until one starts a browser download. */
async function startFirstDownload(page, urls) {
  const errors = [];
  for (const url of urls) {
    try {
      const download = await startDownload(page, url);
      console.log(`  … downloading via ${new URL(url).pathname.split('/').pop()}`);
      return download;
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(`SharePoint wouldn't start a download (${errors.join('; ')})`);
}

/**
 * Navigate to `url` expecting a file. page.goto() rejects ("Download is
 * starting") when the response is a download; if it resolves, SharePoint served
 * a page instead (access denied, download blocked, …).
 */
async function startDownload(page, url) {
  const label = new URL(url).pathname.split('/').pop();
  const started = page.waitForEvent('download', { timeout: DOWNLOAD_START_TIMEOUT_MS });
  started.catch(() => {});

  const nav = await page
    .goto(url, { timeout: DOWNLOAD_START_TIMEOUT_MS })
    .then((res) => ({ res }), (err) => ({ err }));
  if (nav.res) {
    const late = await Promise.race([started, sleep(5000).then(() => null)]).catch(() => null);
    if (late) return late;
    const title = await page.title().catch(() => '');
    throw new Error(`${label}: got a page instead of a file (HTTP ${nav.res.status()}, "${title}")`);
  }
  return started.catch(() => {
    throw new Error(`${label}: ${String(nav.err.message).split('\n')[0]}`);
  });
}

/** Save a browser download to `rel` via <file>.part; returns the size. */
async function saveDownload(download, rel, expectedSize) {
  const dest = resolveDest(rel);
  const part = `${dest}.part`;
  const minutes = Math.max(1, config.recordingTimeoutMin);
  try {
    await withTimeout(download.saveAs(part), minutes * 60000, `download took longer than ${minutes} min`);
    const failure = await download.failure();
    if (failure) throw new Error(`download failed: ${failure}`);
    const size = fs.statSync(part).size;
    if (expectedSize && size !== expectedSize) {
      throw new Error(`Size mismatch: got ${size} bytes, expected ${expectedSize}`);
    }
    fs.renameSync(part, dest);
    return size;
  } catch (err) {
    await download.cancel().catch(() => {});
    fs.rmSync(part, { force: true });
    throw err;
  }
}

function withParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

module.exports = { downloadRecordings };
