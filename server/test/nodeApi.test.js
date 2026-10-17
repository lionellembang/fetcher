const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-api-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.DOWNLOAD_DIR = dir;
process.env.DATA_DIR = path.join(dir, 'data');
process.env.COMPUTE = 'remote';
process.env.NODE_TOKEN = 'n'.repeat(48);
process.env.ACCESS_TOKEN = 'a'.repeat(48);
process.env.NODE_LEASE_SEC = '600';

const store = require('../src/store');
const remote = require('../src/remote');
const cut = require('../src/cut');
const nodeApi = require('../src/nodeApi');
const { createApp } = require('../src/server');

const AUTH = { authorization: `Bearer ${process.env.NODE_TOKEN}` };
const ORIGINAL = crypto.randomBytes(256 * 1024);
const TIMELINE = JSON.stringify({ version: '1', timebase: '25/1', chunks: [[0, 500, 1], [500, 600, 99999], [600, 1200, 1]] });

let n = 0;
/** A downloaded recording with a probe result; returns the item. */
function addRecording() {
  n++;
  const it = {
    id: `recording:${n}`, kind: 'recording', period: '2610', classId: 'c', courseCode: 'COMP6', courseTitle: 'Algorithms',
    component: 'LEC', classCode: 'L1', sessionId: String(n), sessionNumber: n, sessionDate: '2026-10-01', title: `S${n}`,
  };
  store.upsertItem(it, 'available');
  const rel = path.join('2610', 'COMP6 Algorithms (LEC)', `COMP6 LEC S0${n} recording.mp4`);
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), ORIGINAL);
  store.markDownloaded(it.id, rel, ORIGINAL.length);
  store.setStage(it.id, 'probe', { status: 'done', params_key: 'v2', meta: { duration: 60, maxVolume: -5, meanVolume: -25 } });
  return store.getItem(it.id);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

let hub; // the web app (dashboard, MCP; what the tunnel exposes)
let lan; // the LAN listener
test.before(async () => {
  hub = await listen(createApp());
  lan = await listen(nodeApi.createLanApp());
});
test.after(() => {
  for (const { server } of [hub, lan]) {
    server.closeAllConnections();
    server.close();
  }
});

/** Call the node API as `node`. Resolves { status, body }. */
async function api(method, pathname, { node = 'pc', json, body, headers = {}, base = lan.base, auth = AUTH } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...auth, 'x-node-id': node, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

const claim = (node = 'pc', extra = {}) => api('POST', '/node/claim', { node, json: { nodeId: node, version: 't', stages: ['cut', 'transcribe'], waitSec: 0, ...extra } });

/** A job queued the way the worker queues one (without waiting on it). */
function queue(item, stage) {
  const paramsKey = stage === 'cut' ? cut.paramsKey() : require('../src/transcribe').paramsKey();
  return store.upsertNodeJob({ itemId: item.id, stage, paramsKey, key: `${item.id}|${stage}|${paramsKey}`, params: {} });
}

/** PUT `buf` from wherever the hub is, retrying 409s, like the node does. */
async function uploadAll(jobId, name, buf, node = 'pc') {
  for (let i = 0; i < 20; i++) {
    const { body } = await api('GET', `/node/jobs/${jobId}/upload/${name}`, { node });
    if (body.size === buf.length) return;
    const r = await api('PUT', `/node/jobs/${jobId}/upload/${name}?offset=${body.size}`, { node, body: buf.subarray(body.size) });
    if (r.status === 200 && r.body.size === buf.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('upload did not finish');
}

/** Send part of a PUT body, then break the connection. */
function brokenPut(jobId, name, buf, sendBytes) {
  return new Promise((resolve) => {
    const u = new URL(`${lan.base}/node/jobs/${jobId}/upload/${name}?offset=0`);
    const req = http.request(u, { method: 'PUT', headers: { ...AUTH, 'x-node-id': 'pc', 'content-length': buf.length } });
    req.on('error', () => {});
    req.write(buf.subarray(0, sendBytes), () => setTimeout(() => {
      req.destroy();
      setTimeout(resolve, 50);
    }, 50));
  });
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('a wrong token gets 404; the LAN listener serves only /node, and the web app (tunnel) not /node', async () => {
  assert.equal((await api('POST', '/node/claim', { auth: { authorization: 'Bearer nope' }, json: { nodeId: 'pc' } })).status, 404);
  assert.equal((await api('POST', '/node/claim', { auth: {}, json: { nodeId: 'pc' } })).status, 404);
  assert.equal((await api('POST', '/node/claim', { json: { nodeId: 'pc', stages: [] } })).status, 204);

  // the web app is what the tunnel exposes: no node API there, whatever the token
  assert.equal((await api('POST', '/node/claim', { base: hub.base, json: { nodeId: 'pc', stages: [] } })).status, 404);
  assert.equal((await api('GET', '/node/jobs/1/source', { base: hub.base })).status, 404);

  assert.equal((await fetch(`${lan.base}/d/${process.env.ACCESS_TOKEN}/`)).status, 404);
  assert.equal((await fetch(`${lan.base}/d/${process.env.ACCESS_TOKEN}/files/x`)).status, 404);
  assert.equal((await fetch(`${lan.base}/healthz`)).status, 404);
});

test('claim leases the oldest queued job; an expired lease goes back to the queue', async () => {
  const a = addRecording();
  const b = addRecording();
  const ja = queue(a, 'cut').job;
  const jb = queue(b, 'transcribe').job;

  const first = await claim('pc');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.body.job.id, ja.id);
  assert.equal(first.body.job.item.rel, a.file_path);
  assert.equal(first.body.job.item.probeMeta.duration, 60);
  assert.equal(store.getNodeJob(ja.id).status, 'leased');
  assert.ok(remote.nodeState().online);

  // another node gets the next one; nothing is left after that
  assert.equal((await claim('other')).body.job.id, jb.id);
  assert.equal((await claim('third')).status, 204);

  // only the lease holder may use the job
  assert.equal((await api('GET', `/node/jobs/${ja.id}/source`, { node: 'other' })).status, 409);

  // the lease runs out (PC shut down mid-job): queued again, not failed
  remote.sweep(Date.now() + 601 * 1000);
  assert.equal(store.getNodeJob(ja.id).status, 'queued');
  assert.equal(store.getNodeJob(ja.id).node_id, null);
  assert.equal((await api('POST', `/node/jobs/${ja.id}/heartbeat`, { json: { progress: {} } })).status, 409);
  assert.equal((await claim('third')).body.job.id, ja.id);

  // a node that claims again gives up what it held (it only claims when idle)
  assert.equal((await claim('third', { stages: [] })).status, 204);
  assert.equal(store.getNodeJob(ja.id).status, 'queued');
  store.cancelNodeJob(ja.id, 'test done');
  store.cancelNodeJob(jb.id, 'test done');
});

test('claim prefers the item whose original the node already holds', async () => {
  const a = addRecording();
  const b = addRecording();
  const ja = queue(a, 'cut').job;
  const jb = queue(b, 'cut').job;
  assert.equal((await claim('pc', { held: [b.id] })).body.job.id, jb.id);
  store.cancelNodeJob(ja.id, 'test done');
  store.cancelNodeJob(jb.id, 'test done');
});

test('a restarted worker re-attaches to its job, and takes a finished transcript', async () => {
  const item = addRecording();
  const running = remote.run(item, 'transcribe', { probeMeta: { duration: 60 }, pollMs: 20 });
  const job = store.listNodeJobs({ itemId: item.id, stage: 'transcribe' })[0];
  assert.equal(job.status, 'queued');
  assert.equal(job.params.model, require('../src/config').transcribeModel);

  // a worker restart upserts the same key: same job, not a second one
  const again = queue(item, 'transcribe');
  assert.equal(again.attached, true);
  assert.equal(again.job.id, job.id);

  const c = await claim('pc');
  assert.equal(c.body.job.id, job.id);
  const hb = await api('POST', `/node/jobs/${job.id}/heartbeat`, { json: { progress: { phase: 'transcribe', pct: 50 } } });
  assert.deepEqual(hb.body.cancel, false);
  assert.deepEqual(store.getNodeJob(job.id).progress, { phase: 'transcribe', pct: 50 });

  const segments = [
    { start: 1, end: 3, text: ' halo semuanya ' },
    { start: 4, end: 6, text: '  ' },
    { start: 7, end: 9, text: 'kita mulai' },
  ];
  const done = await api('POST', `/node/jobs/${job.id}/complete`, { json: { result: { segments, language: 'id' }, meta: { tookSec: 5 } } });
  assert.equal(done.status, 200);
  // a retried complete (lost answer) is fine
  assert.equal((await api('POST', `/node/jobs/${job.id}/complete`, { json: { result: { segments, language: 'id' } } })).body.already, true);

  const r = await running;
  assert.equal(r.meta.node, 'pc');
  assert.equal(r.meta.tookSec, 5);
  assert.deepEqual(store.getSegments(item.id).map((s) => s.text), ['halo semuanya', 'kita mulai']);
  assert.equal(store.getTranscript(item.id).language, 'id');
  assert.equal(store.getNodeJob(job.id).result.segments, undefined, 'segments are not kept twice');

  // once taken, the same key (e.g. a manual redo) queues the work again
  const redo = queue(item, 'transcribe');
  assert.equal(redo.attached, false);
  assert.equal(redo.job.id, job.id);
  assert.equal(redo.job.status, 'queued');
  store.cancelNodeJob(job.id, 'test done');
});

test('cut: source with Range, an upload resumed after a broken chunk, complete puts the files in place', async () => {
  const item = addRecording();
  const running = remote.run(item, 'cut', { pollMs: 20 });
  const { body } = await claim('pc');
  const id = body.job.id;
  assert.equal(body.job.stage, 'cut');
  assert.equal(body.job.params.edit, require('../src/config').cutEdit);

  const src = await fetch(`${lan.base}/node/jobs/${id}/source`, { headers: { ...AUTH, 'x-node-id': 'pc', range: 'bytes=1000-' } });
  assert.equal(src.status, 206);
  assert.ok(Buffer.from(await src.arrayBuffer()).equals(ORIGINAL.subarray(1000)));

  const video = crypto.randomBytes(3 * 1024 * 1024);
  await brokenPut(id, 'video', video, 1024 * 1024);
  const after = (await api('GET', `/node/jobs/${id}/upload/video`)).body.size;
  assert.ok(after > 0 && after < video.length, `kept ${after} bytes of the broken chunk`);
  // a PUT at the wrong offset is refused with the size to resume from
  const wrong = await api('PUT', `/node/jobs/${id}/upload/video?offset=0`, { body: video });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.size, after);
  await uploadAll(id, 'video', video);
  await uploadAll(id, 'timeline', Buffer.from(TIMELINE));

  const files = { video: { size: video.length, sha256: sha(video) }, timeline: { size: TIMELINE.length, sha256: sha(Buffer.from(TIMELINE)) } };
  const done = await api('POST', `/node/jobs/${id}/complete`, { json: { files, meta: { keptSec: 44, keptPct: 73.3, duration: 44 } } });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const out = cut.cutPaths(item.file_path);
  assert.ok(fs.readFileSync(path.join(dir, out.video)).equals(video));
  assert.equal(fs.readFileSync(path.join(dir, out.timeline), 'utf8'), TIMELINE);
  assert.deepEqual(fs.readdirSync(path.dirname(path.join(dir, out.video))).filter((f) => f.startsWith('.partial')), []);

  const r = await running;
  assert.equal(r.outputPath, out.video);
  assert.equal(r.meta.timeline, out.timeline);
  assert.equal(r.meta.keptPct, 73.3);
  assert.equal(r.meta.node, 'pc');
});

test('a PUT left hanging by a dead connection is ended by the next one', async () => {
  const item = addRecording();
  const { job } = queue(item, 'cut');
  await claim('pc');
  const video = crypto.randomBytes(512 * 1024);
  // a PUT that sends some bytes and then goes silent (cable pulled: the hub doesn't notice)
  const stale = http.request(new URL(`${lan.base}/node/jobs/${job.id}/upload/video?offset=0`), {
    method: 'PUT',
    headers: { ...AUTH, 'x-node-id': 'pc', 'content-length': video.length },
  });
  stale.on('error', () => {});
  await new Promise((resolve) => stale.write(video.subarray(0, 100 * 1024), () => setTimeout(resolve, 100)));

  const have = (await api('GET', `/node/jobs/${job.id}/upload/video`)).body.size;
  const r = await api('PUT', `/node/jobs/${job.id}/upload/video?offset=${have}`, { body: video.subarray(have) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.size, video.length);
  await uploadAll(job.id, 'timeline', Buffer.from(TIMELINE));
  const files = { video: { size: video.length, sha256: sha(video) }, timeline: { size: TIMELINE.length, sha256: sha(Buffer.from(TIMELINE)) } };
  assert.equal((await api('POST', `/node/jobs/${job.id}/complete`, { json: { files } })).status, 200);
  assert.ok(fs.readFileSync(path.join(dir, cut.cutPaths(item.file_path).video)).equals(video));
  stale.destroy();
});

test('a hash mismatch is rejected and the upload starts over', async () => {
  const item = addRecording();
  const { job } = queue(item, 'cut');
  await claim('pc');
  const video = crypto.randomBytes(200 * 1024);
  await uploadAll(job.id, 'video', video);
  await uploadAll(job.id, 'timeline', Buffer.from(TIMELINE));
  const files = { video: { size: video.length, sha256: sha(Buffer.from('something else')) }, timeline: { size: TIMELINE.length, sha256: sha(Buffer.from(TIMELINE)) } };
  const r = await api('POST', `/node/jobs/${job.id}/complete`, { json: { files } });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /sha256/);
  assert.equal((await api('GET', `/node/jobs/${job.id}/upload/video`)).body.size, 0);
  assert.equal(store.getNodeJob(job.id).status, 'leased', 'still the node’s to retry');
  assert.ok(!fs.existsSync(path.join(dir, cut.cutPaths(item.file_path).video)));
  store.cancelNodeJob(job.id, 'test done');
});

test('fail: silent → the stage is skipped, otherwise failed; a cancelled job says so on heartbeat', async () => {
  const a = addRecording();
  const silent = remote.run(a, 'cut', { pollMs: 20 });
  const ja = (await claim('pc')).body.job;
  await api('POST', `/node/jobs/${ja.id}/fail`, { json: { error: 'nothing louder than -30dB', silent: true } });
  await assert.rejects(silent, (err) => err instanceof cut.SilentError && /louder/.test(err.message));

  const b = addRecording();
  const failing = remote.run(b, 'transcribe', { probeMeta: { duration: 60 }, pollMs: 20 });
  const jb = (await claim('pc')).body.job;
  await api('POST', `/node/jobs/${jb.id}/fail`, { json: { error: 'CUDA error' } });
  await assert.rejects(failing, /CUDA error/);

  const c = addRecording();
  const { job } = queue(c, 'cut');
  await claim('pc');
  store.cancelNodeJob(job.id, 'the settings changed');
  assert.deepEqual((await api('POST', `/node/jobs/${job.id}/heartbeat`, { json: {} })).body, { cancel: true });
  assert.equal((await api('GET', `/node/jobs/${job.id}/source`)).status, 409);
});

test('the sweeper cancels jobs for recordings that are gone', async () => {
  const item = addRecording();
  const { job } = queue(item, 'cut');
  fs.rmSync(path.join(dir, item.file_path));
  remote.sweep();
  assert.equal(store.getNodeJob(job.id).status, 'cancelled');
});
