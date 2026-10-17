const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.DATA_DIR = path.join(dir, 'data');
process.env.DOWNLOAD_DIR = path.join(dir, 'downloads');

const express = require('express');
const cut = require('../src/cut');
const { createAgent, HubUnreachable } = require('../src/node/agent');

const TOKEN = 't'.repeat(40);
const ORIGINAL = crypto.randomBytes(400 * 1024);
const CUT = crypto.randomBytes(300 * 1024);
const TIMELINE = JSON.stringify({ version: '1', timebase: '25/1', chunks: [[0, 1000, 1]] });
const REL = path.join('2610', 'COMP6 Algorithms (LEC)', 'COMP6 LEC S03 recording.mp4');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * A stand-in hub: hands out `jobs` in order, serves ORIGINAL (the first
 * transfer breaks off), takes uploads (the first PUT breaks off), records the rest.
 */
function fakeHub(jobs, { cancel = new Set() } = {}) {
  const seen = { claims: [], sourceGets: 0, puts: 0, brokenPuts: 0, beats: [], completes: [], fails: [], uploads: {} };
  const app = express();
  app.use((req, res, next) => (req.get('authorization') === `Bearer ${TOKEN}` ? next() : res.status(404).end()));
  app.post('/node/claim', express.json(), (req, res) => {
    seen.claims.push(req.body);
    const job = jobs.shift();
    job ? res.json({ job }) : res.status(204).end();
  });
  app.get('/node/jobs/:id/source', (req, res) => {
    seen.sourceGets++;
    const from = Number((/bytes=(\d+)-/.exec(req.get('range') || '') || [])[1] || 0);
    res.writeHead(from ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': ORIGINAL.length - from });
    if (seen.sourceGets === 1) return res.write(ORIGINAL.subarray(0, 100 * 1024), () => res.socket.destroy());
    res.end(ORIGINAL.subarray(from));
  });
  app.post('/node/jobs/:id/heartbeat', express.json(), (req, res) => {
    seen.beats.push(req.body.progress);
    res.json({ cancel: cancel.has(Number(req.params.id)) });
  });
  const key = (req) => `${req.params.id}/${req.params.name}`;
  app.get('/node/jobs/:id/upload/:name', (req, res) => res.json({ size: (seen.uploads[key(req)] || Buffer.alloc(0)).length }));
  app.put('/node/jobs/:id/upload/:name', (req, res) => {
    const have = seen.uploads[key(req)] || Buffer.alloc(0);
    if (Number(req.query.offset) !== have.length) return res.status(409).json({ size: have.length });
    const n = ++seen.puts;
    const parts = [];
    req.on('data', (c) => {
      if (n === 1) {
        // the connection breaks after half of what arrived; that much is kept
        seen.uploads[key(req)] = Buffer.concat([have, c.subarray(0, c.length >> 1)]);
        seen.brokenPuts++;
        return req.socket.destroy();
      }
      parts.push(c);
    });
    req.on('end', () => {
      if (n === 1) return;
      seen.uploads[key(req)] = Buffer.concat([have, ...parts]);
      res.json({ size: seen.uploads[key(req)].length });
    });
  });
  app.post('/node/jobs/:id/complete', express.json({ limit: '25mb' }), (req, res) => {
    seen.completes.push({ id: Number(req.params.id), ...req.body });
    if (req.body.files) {
      for (const name of ['video', 'timeline']) {
        if (sha(seen.uploads[`${req.params.id}/${name}`] || Buffer.alloc(0)) !== req.body.files[name].sha256) return res.status(422).json({ error: 'sha256' });
      }
    }
    res.json({ ok: true });
  });
  app.post('/node/jobs/:id/fail', express.json(), (req, res) => {
    seen.fails.push({ id: Number(req.params.id), ...req.body });
    res.json({ ok: true });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ seen, base: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) }));
  });
}

const item = { id: 'recording:3', label: 'COMP6 LEC S3', rel: REL, size: ORIGINAL.length, probeMeta: { duration: 60 } };
const cutJob = (id = 1) => ({ id, stage: 'cut', key: 'k', paramsKey: 'audio:-30dB|0.3s,0.5s', params: { edit: 'audio:-30dB', margin: '0.3s,0.5s', extraArgs: [] }, item, leaseSec: 600 });
const transcribeJob = (id = 2) => ({ id, stage: 'transcribe', key: 'k2', paramsKey: 'large-v3|id|gate12|loudnorm:quiet', params: { language: 'id', model: 'large-v3', gateDb: 12, loudnorm: false, duration: 60 }, item, leaseSec: 600 });

/** A stub cut: checks it got the original and the hub's settings, writes outputs like cut.js does. */
async function stubCut(rel, opts) {
  assert.equal(opts.edit, 'audio:-30dB');
  assert.ok(fs.readFileSync(path.join(opts.downloadDir, rel)).equals(ORIGINAL), 'cuts the downloaded original');
  const out = cut.cutPaths(rel);
  fs.mkdirSync(path.dirname(path.join(opts.downloadDir, out.video)), { recursive: true });
  fs.writeFileSync(path.join(opts.downloadDir, out.video), CUT);
  fs.writeFileSync(path.join(opts.downloadDir, out.timeline), TIMELINE);
  return { outputPath: out.video, meta: { timeline: out.timeline, size: CUT.length, duration: 40, keptSec: 40, keptPct: 66.7 } };
}

function agentFor(hubUrl, cacheDir, extra = {}) {
  return createAgent({
    hubUrl,
    token: TOKEN,
    nodeId: 'pc',
    stages: ['cut', 'transcribe'],
    cacheDir,
    cacheGb: 1,
    waitSec: 0,
    heartbeatMs: 30,
    retryMs: 10,
    transcriberHealth: async () => ({ status: 'ok', device: 'cuda' }),
    gpuName: async () => 'Test GPU',
    killAll: () => {},
    cutRecording: stubCut,
    transcribeFile: async (file, opts) => {
      assert.ok(fs.existsSync(file));
      assert.equal(opts.model, 'large-v3');
      return { segments: [{ start: 1, end: 2, text: 'halo' }], language: 'id', meta: { segments: 1 } };
    },
    log: () => {},
    ...extra,
  });
}

test('claim → source (resumed) → cut → upload (resumed) → complete, then transcribe from the cached original', async (t) => {
  const hub = await fakeHub([cutJob(1), transcribeJob(2)]);
  t.after(hub.close);
  const cacheDir = path.join(dir, 'cache1');
  const agent = agentFor(hub.base, cacheDir);

  assert.equal(await agent.step(), true);
  assert.equal(hub.seen.sourceGets, 2, 'the broken transfer was resumed');
  assert.ok(fs.readFileSync(path.join(cacheDir, REL)).equals(ORIGINAL));
  assert.ok(hub.seen.uploads['1/video'].equals(CUT), 'the hub got the whole cut despite the broken PUT');
  assert.equal(hub.seen.brokenPuts, 1, 'a PUT broke off on the way');
  assert.equal(hub.seen.uploads['1/timeline'].toString(), TIMELINE);
  const done = hub.seen.completes[0];
  assert.deepEqual(done.files.video, { size: CUT.length, sha256: sha(CUT) });
  assert.equal(done.meta.keptPct, 66.7);
  assert.equal(done.meta.timeline, undefined, 'paths are the hub’s business');
  assert.ok(!fs.existsSync(path.join(cacheDir, cut.cutPaths(REL).video)), 'the cut is not kept on the node');
  assert.equal(hub.seen.claims[0].info.gpu, 'Test GPU');
  assert.deepEqual(hub.seen.claims[0].stages, ['cut', 'transcribe']);

  assert.equal(await agent.step(), true);
  assert.deepEqual(hub.seen.claims[1].held, ['recording:3']);
  assert.equal(hub.seen.sourceGets, 2, 'transcribe used the cached original');
  assert.deepEqual(hub.seen.completes[1], { id: 2, result: { segments: [{ start: 1, end: 2, text: 'halo' }], language: 'id' }, meta: { segments: 1 } });

  assert.equal(await agent.step(), false);
  assert.deepEqual(hub.seen.fails, []);
});

test('a job the hub cancels is stopped and dropped, not completed or failed', async (t) => {
  const hub = await fakeHub([cutJob(7)], { cancel: new Set([7]) });
  t.after(hub.close);
  let killed;
  const stopped = new Promise((resolve) => (killed = resolve));
  const agent = agentFor(hub.base, path.join(dir, 'cache2'), {
    killAll: () => killed(),
    cutRecording: async () => {
      await stopped; // "auto-editor" runs until it's killed
      throw new Error('auto-editor exited null');
    },
  });
  assert.equal(await agent.step(), true);
  assert.deepEqual(hub.seen.completes, []);
  assert.deepEqual(hub.seen.fails, []);
  assert.ok(hub.seen.beats.length >= 1);
});

test('silent → reported as skipped; other errors as failed', async (t) => {
  const hub = await fakeHub([cutJob(8), transcribeJob(9)]);
  t.after(hub.close);
  const agent = agentFor(hub.base, path.join(dir, 'cache3'), {
    cutRecording: async () => {
      throw new cut.SilentError('nothing louder than -30dB');
    },
    transcribeFile: async () => {
      throw new Error('CUDA out of memory');
    },
  });
  await agent.step();
  await agent.step();
  assert.deepEqual(hub.seen.fails, [
    { id: 8, error: 'nothing louder than -30dB', silent: true },
    { id: 9, error: 'CUDA out of memory', silent: false },
  ]);
});

test('only cut jobs are claimed while the transcriber is down', async (t) => {
  const hub = await fakeHub([]);
  t.after(hub.close);
  const agent = agentFor(hub.base, path.join(dir, 'cache4'), { transcriberHealth: async () => null });
  assert.equal(await agent.step(), false);
  assert.deepEqual(hub.seen.claims[0].stages, ['cut']);
  assert.equal(hub.seen.claims[0].info.transcriber, 'down');
});

test('no reachable hub → HubUnreachable', async () => {
  const agent = agentFor('http://127.0.0.1:9', path.join(dir, 'cache5'));
  await assert.rejects(agent.step(), HubUnreachable);
});

test('the cache never writes outside its folder, and evicts least recently used originals', () => {
  const { createCache } = require('../src/node/agent');
  const cdir = path.join(dir, 'cache6');
  const cache = createCache(cdir, 1 / 1024 ** 2); // 1 KiB
  assert.throws(() => cache.pathFor('../../etc/passwd'), /outside the cache/);
  assert.throws(() => cache.pathFor('/etc/passwd'), /outside the cache/);
  for (const [id, name] of [['a', 'a.mp4'], ['b', 'b.mp4']]) {
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, name), Buffer.alloc(800));
    cache.touch(id, name, 800);
  }
  cache.evict('b');
  assert.ok(!fs.existsSync(path.join(cdir, 'a.mp4')));
  assert.ok(fs.existsSync(path.join(cdir, 'b.mp4')));
  assert.deepEqual(cache.held(), ['b']);
});
