/**
 * The hub's API for its compute node (COMPUTE=remote). The node always calls
 * in (pull), so it needs no open ports. It has its own listener on
 * NODE_HOST:NODE_PORT for the LAN; it is not on the web app, so the tunnel
 * doesn't expose it.
 *
 *   POST /node/claim {nodeId, version, stages, info, held, waitSec≤25}
 *                                       → 200 {job} or 204; long-polls up to waitSec
 *   GET  /node/jobs/:id/source          → the original recording (Range supported)
 *   POST /node/jobs/:id/heartbeat {progress}
 *                                       → {cancel}; extends the lease
 *   GET  /node/jobs/:id/upload/:name    → {size} received so far (name: video | timeline)
 *   PUT  /node/jobs/:id/upload/:name?offset=N
 *                                       → {size}; appends the body; 409 {size} if offset is off
 *   POST /node/jobs/:id/complete        cut: {files: {video, timeline: {size, sha256}}, meta}
 *                                       transcribe: {result: {segments, language}, meta}
 *   POST /node/jobs/:id/fail {error, silent}
 *
 * Every call needs "Authorization: Bearer <NODE_TOKEN>" (anything else is a
 * 404) and, on /jobs, "X-Node-Id" of the node holding the lease (else 409).
 * No filesystem path ever comes from the request: they all come from the job
 * and its item. An upload that breaks off keeps what arrived; the node asks
 * for the size and sends the rest.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { pipeline } = require('stream/promises');
const express = require('express');
const config = require('./config');
const store = require('./store');
const cut = require('../shared/cut');
const remote = require('./remote');
const { loadTimeline } = require('../shared/timeline');

const MAX_WAIT_SEC = 25;
const CLAIM_POLL_MS = 1000;
const UPLOADS = ['video', 'timeline'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const abs = (rel) => path.join(config.downloadDir, rel);
const sizeOf = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0);
const label = (item) => `${item.course_code} ${item.component} S${item.session_number}`;

/** The API only exists on a hub (COMPUTE=remote) with a NODE_TOKEN long enough to put on the internet. */
const enabled = () => config.compute === 'remote' && config.nodeToken.length >= 32;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
function authorized(req) {
  if (!enabled()) return false;
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  return !!m && crypto.timingSafeEqual(digest(m[1]), digest(config.nodeToken));
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Record that the node called in (dashboard: online / last seen). */
function seen(nodeId, version, info) {
  store.setMeta('node_last_seen', new Date().toISOString());
  if (info !== undefined) store.setMeta('node_info', JSON.stringify({ ...(info && typeof info === 'object' ? info : {}), id: nodeId, version: version || null }));
}

function jobForNode(job, item) {
  const probe = store.getStage(item.id, 'probe');
  return {
    id: job.id,
    stage: job.stage,
    key: job.key,
    paramsKey: job.params_key,
    params: job.params,
    item: { id: item.id, label: label(item), rel: item.file_path, size: item.size, probeMeta: probe ? probe.meta : null },
    leaseSec: config.nodeLeaseSec,
  };
}

async function claim(req, res) {
  const { nodeId, version, stages, info, held, waitSec } = req.body || {};
  if (!nodeId || typeof nodeId !== 'string' || nodeId.length > 200) return res.status(400).json({ error: 'nodeId is required' });
  const accepted = (Array.isArray(stages) ? stages : []).filter((s) => remote.REMOTE_STAGES.includes(s));
  const heldIds = (Array.isArray(held) ? held : []).filter((h) => typeof h === 'string').slice(0, 1000);
  const deadline = Date.now() + Math.min(Math.max(Number(waitSec) || 0, 0), MAX_WAIT_SEC) * 1000;
  let gone = false;
  res.on('close', () => (gone = true));

  seen(nodeId, version, info);
  for (;;) {
    const job = store.claimNodeJob({ nodeId, stages: accepted, held: heldIds, leaseMs: config.nodeLeaseSec * 1000 });
    if (job) {
      const item = store.getItem(job.item_id);
      if (!item || !item.file_path || !fs.existsSync(abs(item.file_path))) {
        store.cancelNodeJob(job.id, 'the recording is no longer on disk');
        continue;
      }
      remote.removePartials(job, item); // a new lease starts its uploads from scratch
      console.log(`→ node ${nodeId} took job ${job.id}: ${job.stage} ${label(item)}`);
      return res.json({ job: jobForNode(job, item) });
    }
    if (gone || Date.now() >= deadline) break;
    await sleep(Math.min(CLAIM_POLL_MS, Math.max(0, deadline - Date.now())));
  }
  seen(nodeId);
  if (!gone) res.status(204).end();
}

/** Load the job; only the node holding it (X-Node-Id) gets further. */
function withJob(req, res, next) {
  const id = Number(req.params.id);
  const job = Number.isSafeInteger(id) ? store.getNodeJob(id) : null;
  if (!job) return res.status(404).json({ error: 'no such job' });
  const nodeId = req.get('x-node-id') || '';
  if (!job.node_id || job.node_id !== nodeId) return res.status(409).json({ error: 'this job is not leased to you' });
  req.job = job;
  req.nodeId = nodeId;
  req.item = store.getItem(job.item_id);
  if (!req.item) return res.status(409).json({ error: 'the recording is gone' });
  seen(nodeId);
  next();
}

const leased = (req, res) => {
  if (req.job.status === 'leased') return true;
  res.status(409).json({ error: `job is ${req.job.status}`, cancel: req.job.status === 'cancelled' });
  return false;
};

function source(req, res, next) {
  if (!leased(req, res)) return;
  res.sendFile(abs(req.item.file_path), { cacheControl: false, dotfiles: 'allow', headers: { 'cache-control': 'no-store' } }, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

function heartbeat(req, res) {
  const progress = req.body && req.body.progress && typeof req.body.progress === 'object' ? req.body.progress : null;
  if (store.updateLeasedJob(req.job.id, req.nodeId, { lease_until: Date.now() + config.nodeLeaseSec * 1000, progress })) {
    return res.json({ cancel: false, leaseSec: config.nodeLeaseSec });
  }
  const now = store.getNodeJob(req.job.id);
  if (now && now.status === 'cancelled') return res.json({ cancel: true });
  res.status(409).json({ error: `job is ${now ? now.status : 'gone'}` });
}

function uploadTarget(req, res) {
  if (!leased(req, res)) return null;
  if (req.job.stage !== 'cut') return res.status(400).json({ error: 'only cut jobs upload files' }), null;
  if (!UPLOADS.includes(req.params.name)) return res.status(404).json({ error: `upload name is one of ${UPLOADS.join(', ')}` }), null;
  return abs(remote.partialPath(req.item, req.job.id, req.params.name));
}

function uploadSize(req, res) {
  const file = uploadTarget(req, res);
  if (file) res.json({ size: sizeOf(file) });
}

const uploads = new Map(); // partial file → { req, done } of the PUT writing it

async function upload(req, res) {
  const file = uploadTarget(req, res);
  if (!file) return;
  const offset = Number(req.query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: 'offset is required' });

  // The node sends one upload at a time, so a PUT still writing this file is
  // left over from a connection that broke without the hub noticing: end it.
  const prev = uploads.get(file);
  if (prev) {
    prev.req.destroy();
    await prev.done;
  }
  const have = sizeOf(file);
  if (offset !== have) return res.status(409).json({ error: `expected offset ${have}`, size: have });

  let finished;
  const mine = { req, done: new Promise((resolve) => (finished = resolve)) };
  uploads.set(file, mine);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file, { flags: 'a' });
  try {
    // Bytes that arrive are appended even if the request breaks off: they're
    // the right bytes, and the node resumes from the size it reads back.
    await pipeline(req, out);
    res.json({ size: sizeOf(file) });
  } catch (err) {
    if (!res.headersSent && !res.destroyed) res.status(400).json({ error: err.message, size: sizeOf(file) });
  } finally {
    if (!out.closed) await once(out, 'close'); // everything written before the size is read again
    if (uploads.get(file) === mine) uploads.delete(file);
    finished();
  }
}

async function completeCut(req, res) {
  const { files, meta } = req.body || {};
  const parts = Object.fromEntries(UPLOADS.map((n) => [n, abs(remote.partialPath(req.item, req.job.id, n))]));
  const reject = (msg) => {
    remote.removePartials(req.job, req.item); // the node uploads again from scratch
    console.error(`✗ node job ${req.job.id}: ${msg}`);
    res.status(422).json({ error: msg });
  };
  for (const n of UPLOADS) {
    const f = files && files[n];
    if (!f || !Number.isSafeInteger(f.size) || typeof f.sha256 !== 'string') return res.status(400).json({ error: `files.${n} needs size and sha256` });
    const size = sizeOf(parts[n]);
    if (size !== f.size) return reject(`${n}: received ${size} bytes, expected ${f.size}`);
    if ((await fileSha256(parts[n])) !== f.sha256.toLowerCase()) return reject(`${n}: sha256 does not match`);
  }
  try {
    loadTimeline(parts.timeline);
  } catch (err) {
    return reject(`timeline: ${err.message}`);
  }
  const out = cut.cutPaths(req.item.file_path);
  for (const n of UPLOADS) fsyncFile(parts[n]);
  fs.renameSync(parts.video, abs(out.video));
  fs.renameSync(parts.timeline, abs(out.timeline));
  const result = { outputPath: out.video, meta: { ...(meta && typeof meta === 'object' ? meta : {}), timeline: out.timeline, size: files.video.size } };
  if (!store.updateLeasedJob(req.job.id, req.nodeId, { status: 'done', result, error: null, lease_until: null })) {
    return res.status(409).json({ error: 'the job was taken away while completing' });
  }
  console.log(`✓ node job ${req.job.id}: cut ${label(req.item)} received (${files.video.size} B)`);
  res.json({ ok: true });
}

function completeTranscribe(req, res) {
  const { result, meta } = req.body || {};
  const segments = result && result.segments;
  const valid =
    Array.isArray(segments) && segments.every((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.text === 'string');
  if (!valid) return res.status(400).json({ error: 'result.segments must be [{start, end, text}]' });
  const stored = { segments, language: typeof result.language === 'string' ? result.language : null, meta: meta && typeof meta === 'object' ? meta : {} };
  if (!store.updateLeasedJob(req.job.id, req.nodeId, { status: 'done', result: stored, error: null, lease_until: null })) {
    return res.status(409).json({ error: 'the job was taken away while completing' });
  }
  console.log(`✓ node job ${req.job.id}: transcript of ${label(req.item)} received (${segments.length} segments)`);
  res.json({ ok: true });
}

function complete(req, res, next) {
  if (req.job.status === 'done') return res.json({ ok: true, already: true }); // a retried complete whose answer got lost
  if (!leased(req, res)) return;
  if (req.job.stage === 'cut') return completeCut(req, res).catch(next);
  completeTranscribe(req, res);
}

function fail(req, res) {
  if (!leased(req, res)) return;
  const { error, silent } = req.body || {};
  const status = silent ? 'skipped' : 'failed';
  if (!store.updateLeasedJob(req.job.id, req.nodeId, { status, error: String(error || status), lease_until: null })) {
    return res.status(409).json({ error: 'job is no longer yours' });
  }
  remote.removePartials(req.job, req.item);
  console.log(`${silent ? '–' : '✗'} node job ${req.job.id}: ${req.job.stage} ${label(req.item)} ${status}: ${String(error || '').split('\n')[0]}`);
  res.json({ ok: true });
}

function router() {
  const r = express.Router();
  r.use((req, res, next) => {
    res.set('cache-control', 'no-store');
    if (!authorized(req)) return res.status(404).send('Not found');
    next();
  });
  r.post('/claim', express.json({ limit: '1mb' }), wrap(claim));
  r.get('/jobs/:id/source', withJob, source);
  r.post('/jobs/:id/heartbeat', express.json({ limit: '64kb' }), withJob, heartbeat);
  r.get('/jobs/:id/upload/:name', withJob, uploadSize);
  r.put('/jobs/:id/upload/:name', withJob, wrap(upload));
  r.post('/jobs/:id/complete', express.json({ limit: '25mb' }), withJob, complete);
  r.post('/jobs/:id/fail', express.json({ limit: '1mb' }), withJob, fail);
  r.use((req, res) => res.status(404).send('Not found'));
  return r;
}

/** The LAN listener's app: /node and nothing else. */
function createLanApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use('/node', router());
  app.use((req, res) => res.status(404).set('cache-control', 'no-store').send('Not found'));
  app.use((err, req, res, next) => {
    console.error(`✗ node API ${req.method} ${req.path}: ${err.stack || err}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message });
  });
  return app;
}

/** Start the LAN listener. Uploads are whole cut videos, so a request may take a while. */
function listen(port, host, cb) {
  const server = createLanApp().listen(port, host, cb);
  server.requestTimeout = 60 * 60 * 1000;
  return server;
}

module.exports = { router, createLanApp, listen, enabled };
