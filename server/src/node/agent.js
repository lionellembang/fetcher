/**
 * Compute node agent (server/node.js, on the PC): pulls cut and transcribe
 * jobs from the hub's /node API (nodeApi.js) and runs them, one at a time.
 *
 *   claim (long poll) → fetch the original into the cache (resumable) →
 *   cut (auto-editor) or transcribe (the local transcriber) with the hub's
 *   settings → upload the results (cut: 64 MiB resumable chunks) → complete
 *
 * A heartbeat every 30 s keeps the lease and reports progress; when the hub
 * says the job was cancelled or given away, the work is stopped and dropped.
 * The node calls the hub, never the other way round, so it needs no open
 * ports. HUB_URLS are tried in order (LAN first); within a job the node
 * sticks to the one that answered and switches when it stops answering.
 *
 * Originals stay in NODE_CACHE_DIR (least recently used evicted past
 * NODE_CACHE_GB), so cut and transcribe of one lecture download it once.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const media = require('../media');
const cut = require('../cut');
const transcribe = require('../transcribe');
const whisper = require('../whisper');
const { download, NotServedError } = require('../httpfetch');
const { version } = require('../../package.json');

class HubUnreachable extends Error {}
class LostJob extends Error {} // cancelled by the hub, or no longer leased to this node

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const t = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(t);
      reject(signal.reason);
    }
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
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

async function readRange(file, from, to) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, from + n);
      if (!bytesRead) throw new Error(`${path.basename(file)} is shorter than expected`);
      n += bytesRead;
    }
    return buf;
  } finally {
    await fh.close();
  }
}

/** The hub's API over HUB_URLS: the preferred URL first, then the others. */
function createHub({ urls, token, nodeId }) {
  let current = 0;
  const auth = { authorization: `Bearer ${token}`, 'x-node-id': nodeId };
  const order = () => urls.map((_, k) => urls[(current + k) % urls.length]);
  return {
    auth,
    /** Start again from the first URL (the LAN), e.g. before each claim. */
    reset: () => (current = 0),
    /** Every URL for `pathname`, the one in use first. */
    urlsFor: (pathname) => order().map((u) => u + pathname),
    async request(method, pathname, { json, body, headers = {}, timeoutMs = 60000 } = {}) {
      const errors = [];
      for (const base of order()) {
        try {
          const res = await fetch(base + pathname, {
            method,
            headers: { ...auth, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
            body: json ? JSON.stringify(json) : body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          current = urls.indexOf(base);
          return res;
        } catch (err) {
          errors.push(`${base}: ${err.cause ? err.cause.code || err.cause.message : err.message}`);
        }
      }
      throw new HubUnreachable(`no hub reachable (${errors.join('; ')})`);
    },
  };
}

/** Originals on this node: { [itemId]: { rel, size, usedAt } } in index.json, LRU-evicted. */
function createCache(dir, maxGb) {
  const indexFile = path.join(dir, 'index.json');
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {}
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${indexFile}.tmp`, JSON.stringify(index));
    fs.renameSync(`${indexFile}.tmp`, indexFile);
  };
  /** Absolute path for a hub-relative path; never outside the cache. */
  const pathFor = (rel) => {
    const p = path.resolve(dir, String(rel || ''));
    if (path.isAbsolute(String(rel || '')) || !p.startsWith(dir + path.sep)) throw new Error(`refusing a path outside the cache: ${rel}`);
    return p;
  };
  const present = (e) => {
    try {
      return fs.statSync(pathFor(e.rel)).size === e.size;
    } catch {
      return false;
    }
  };
  return {
    pathFor,
    /** Item ids whose original is here (the hub prefers giving us their jobs). */
    held: () => Object.keys(index).filter((id) => present(index[id])),
    has(itemId, rel, size) {
      const e = index[itemId];
      return !!e && e.rel === rel && (!size || e.size === size) && present(e);
    },
    touch(itemId, rel, size) {
      index[itemId] = { rel, size, usedAt: Date.now() };
      save();
    },
    /** Drop the least recently used originals until the cache fits (never `keepId`). */
    evict(keepId) {
      const limit = maxGb * 1024 ** 3;
      for (const id of Object.keys(index)) if (!present(index[id])) delete index[id];
      let total = Object.values(index).reduce((a, e) => a + e.size, 0);
      for (const [id, e] of Object.entries(index).sort(([, a], [, b]) => a.usedAt - b.usedAt)) {
        if (total <= limit) break;
        if (id === keepId) continue;
        fs.rmSync(pathFor(e.rel), { force: true });
        delete index[id];
        total -= e.size;
      }
      save();
    },
    sizeGb: () => Math.round((Object.values(index).reduce((a, e) => a + e.size, 0) / 1024 ** 3) * 10) / 10,
  };
}

/** GPU name from nvidia-smi, or null. */
async function gpuName() {
  try {
    const r = await media.run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeoutMs: 10000 });
    return r.code === 0 ? r.stdout.split('\n')[0].trim() || null : null;
  } catch {
    return null;
  }
}

function createAgent(options = {}) {
  const o = {
    hubUrls: config.hubUrls,
    token: config.nodeToken,
    nodeId: config.nodeId,
    stages: config.nodeStages,
    cacheDir: config.nodeCacheDir,
    cacheGb: config.nodeCacheGb,
    waitSec: 25,
    heartbeatMs: 30000,
    backoffMs: [5000, 60000],
    retryMs: 5000,
    transcriberRetryMs: 60000,
    cutRecording: cut.cutRecording,
    transcribeFile: transcribe.transcribeFile,
    transcriberHealth: whisper.health,
    killAll: media.killAll,
    gpuName,
    log: console.log,
    ...options,
  };
  const log = o.log;
  const hub = createHub({ urls: o.hubUrls, token: o.token, nodeId: o.nodeId });
  const cache = createCache(o.cacheDir, o.cacheGb);
  let gpu;
  let stopped = false;
  let transcriberWasUp = true;

  async function info(health) {
    if (gpu === undefined) gpu = await o.gpuName();
    let freeDiskGb = null;
    try {
      const s = fs.statfsSync(fs.existsSync(o.cacheDir) ? o.cacheDir : os.homedir());
      freeDiskGb = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
    } catch {}
    const transcriber = o.stages.includes('transcribe') ? (health ? 'up' : 'down') : null;
    return { host: os.hostname(), gpu, freeDiskGb, cacheGb: cache.sizeGb(), stages: o.stages, transcriber };
  }

  /** One claim (long poll). Resolves the job, or null when there was none. */
  async function claim() {
    const health = o.stages.includes('transcribe') ? await o.transcriberHealth() : null;
    // Don't take transcriptions while the transcriber is down; cuts still run.
    const stages = o.stages.filter((s) => s !== 'transcribe' || health);
    if (!health && o.stages.includes('transcribe') && transcriberWasUp) log('… transcriber is down: taking only cut jobs until it is back');
    if (health && !transcriberWasUp) log('… transcriber is back');
    transcriberWasUp = !!health;

    hub.reset(); // the LAN when it works
    const res = await hub.request('POST', '/node/claim', {
      json: { nodeId: o.nodeId, version, stages, info: await info(health), held: cache.held(), waitSec: o.waitSec },
      timeoutMs: (o.waitSec + 20) * 1000,
    });
    if (res.status === 204) return null;
    if (res.status === 404) throw new Error('the hub answered 404: NODE_TOKEN does not match, or the hub is not in COMPUTE=remote mode');
    if (!res.ok) throw new Error(`claim → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).job;
  }

  /** POST with a few retries while the hub is unreachable or failing. */
  async function post(pathname, json, { timeoutMs = 120000, signal } = {}) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await hub.request('POST', pathname, { json, timeoutMs });
        if (res.status < 500) return res;
      } catch (err) {
        if (!(err instanceof HubUnreachable) || attempt >= 6) throw err;
      }
      if (attempt >= 6) return res;
      await sleep(o.retryMs * attempt, signal);
    }
  }

  async function fetchSource(job, signal, setMeasure) {
    const { id: itemId, rel, size } = job.item;
    const dest = cache.pathFor(rel);
    if (cache.has(itemId, rel, size)) {
      log(`  … original already here`);
      cache.touch(itemId, rel, size);
      return dest;
    }
    setMeasure(() => {
      try {
        return { pct: size ? (100 * fs.statSync(`${dest}.part`).size) / size : null };
      } catch {
        return {};
      }
    });
    try {
      const got = await download(hub.urlsFor(`/node/jobs/${job.id}/source`), dest, {
        expectedSize: size,
        headers: hub.auth,
        resume: true, // a .part left by a restart is continued
        rotateOnError: true, // LAN dropped mid-way: continue through the tunnel
        notServed: [401, 403, 404, 409],
        attempts: 10,
        retryBaseMs: o.retryMs,
        timeoutMs: 6 * 3600 * 1000,
        signal,
        log,
      });
      cache.touch(itemId, rel, got);
      cache.evict(itemId);
      return dest;
    } catch (err) {
      if (err instanceof NotServedError) throw new LostJob(`the hub won't serve the original (${err.message})`);
      if (signal.aborted) throw err;
      // The original is the hub's own file: a download that keeps breaking means the
      // hub is (nearly) unreachable, not that the job is bad. Leave it to be re-queued.
      throw new HubUnreachable(`couldn't fetch the original: ${err.message}`);
    }
  }

  /** Upload `file` as `name` in chunks, resuming from what the hub already has. */
  async function upload(job, name, file, signal, setMeasure) {
    const size = fs.statSync(file).size;
    const chunk = job.chunkBytes || 64 * 1024 * 1024;
    let have = 0;
    setMeasure(() => ({ pct: size ? (100 * have) / size : 100 }));
    let failures = 0;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      try {
        const r = await hub.request('GET', `/node/jobs/${job.id}/upload/${name}`, { timeoutMs: 30000 });
        if (r.status === 409) throw new LostJob(`upload refused: ${(await r.json().catch(() => ({}))).error || 'job is no longer ours'}`);
        if (!r.ok) throw new Error(`upload size → HTTP ${r.status}`);
        have = (await r.json()).size;
        if (have > size) throw new Error(`the hub has ${have} bytes of ${name}, more than its ${size}`);
        if (have === size) return;
        const buf = await readRange(file, have, Math.min(have + chunk, size));
        const put = await hub.request('PUT', `/node/jobs/${job.id}/upload/${name}?offset=${have}`, {
          body: buf,
          headers: { 'content-type': 'application/octet-stream' },
          timeoutMs: 15 * 60000,
        });
        const body = await put.json().catch(() => ({}));
        if (put.ok) {
          have = body.size;
          failures = 0;
          continue;
        }
        if (put.status === 409 && body.size !== undefined) continue; // offset moved or upload in progress: ask again
        if (put.status === 409) throw new LostJob(`upload refused: ${body.error || 'job is no longer ours'}`);
        throw new Error(`upload → HTTP ${put.status}: ${body.error || ''}`);
      } catch (err) {
        if (err instanceof LostJob || signal.aborted) throw err;
        if (++failures > 8) throw err;
        log(`  … upload of ${name} at ${have} B broke off (${err.message}); retrying`);
        await sleep(o.retryMs * failures, signal);
      }
    }
  }

  async function runCut(job, signal, setPhase) {
    const p = job.params || {};
    setPhase('cut');
    const started = Date.now();
    const r = await o.cutRecording(job.item.rel, { downloadDir: o.cacheDir, edit: p.edit, margin: p.margin, extraArgs: p.extraArgs || [] });
    const files = { video: path.join(o.cacheDir, r.outputPath), timeline: path.join(o.cacheDir, r.meta.timeline) };
    const { timeline, size, ...meta } = r.meta;
    meta.tookSec = Math.round((Date.now() - started) / 1000);
    try {
      for (let attempt = 1; ; attempt++) {
        for (const name of ['video', 'timeline']) await upload(job, name, files[name], signal, (m) => setPhase(`upload ${name}`, m));
        setPhase('complete');
        const sums = {};
        for (const name of ['video', 'timeline']) sums[name] = { size: fs.statSync(files[name]).size, sha256: await fileSha256(files[name]) };
        const res = await post(`/node/jobs/${job.id}/complete`, { files: sums, meta }, { signal, timeoutMs: 10 * 60000 });
        if (res.ok) return;
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) throw new LostJob(body.error || 'job is no longer ours');
        if (res.status === 422 && attempt < 2) {
          log(`  … the hub rejected the upload (${body.error}); uploading again`);
          continue;
        }
        throw new Error(`complete → HTTP ${res.status}: ${body.error || ''}`);
      }
    } finally {
      fs.rmSync(files.video, { force: true });
      fs.rmSync(files.timeline, { force: true });
    }
  }

  async function runTranscribe(job, src, signal, setPhase) {
    const p = job.params || {};
    let r;
    for (;;) {
      setPhase('transcribe');
      try {
        r = await o.transcribeFile(src, {
          key: `${job.item.id}|${job.paramsKey}|${p.loudnorm}`,
          language: p.language,
          model: p.model,
          gateDb: p.gateDb,
          loudnorm: p.loudnorm,
          duration: p.duration,
          label: job.item.label,
          signal,
        });
        break;
      } catch (err) {
        if (!(err instanceof whisper.UnavailableError) || signal.aborted) throw err;
        log(`  … ${err.message}; trying again in ${Math.round(o.transcriberRetryMs / 1000)}s`);
        setPhase('waiting for the transcriber');
        await sleep(o.transcriberRetryMs, signal);
      }
    }
    setPhase('complete');
    const res = await post(`/node/jobs/${job.id}/complete`, { result: { segments: r.segments, language: r.language }, meta: r.meta }, { signal });
    if (res.ok) return;
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) throw new LostJob(body.error || 'job is no longer ours');
    throw new Error(`complete → HTTP ${res.status}: ${body.error || ''}`);
  }

  /** Run one claimed job to the end (completed, failed, or dropped). */
  async function runJob(job) {
    const t0 = Date.now();
    log(`→ job ${job.id}: ${job.stage} ${job.item.label}`);
    const ac = new AbortController();
    const progress = { phase: 'download' };
    let measure = null;
    const setPhase = (phase, m = null) => {
      progress.phase = phase;
      delete progress.pct;
      measure = m;
    };
    const beat = async () => {
      if (measure) Object.assign(progress, measure());
      try {
        const r = await hub.request('POST', `/node/jobs/${job.id}/heartbeat`, { json: { progress }, timeoutMs: 20000 });
        const body = await r.json().catch(() => ({}));
        const lost = r.status === 409 ? body.error || 'the job is no longer ours' : body.cancel ? 'the hub cancelled it' : null;
        if (lost && !ac.signal.aborted) {
          ac.abort(new LostJob(lost));
          o.killAll(); // auto-editor / ffmpeg
        }
      } catch {} // unreachable for a moment: the lease has minutes of slack
    };
    const timer = setInterval(beat, o.heartbeatMs);
    try {
      const src = await fetchSource(job, ac.signal, (m) => (measure = m));
      if (job.stage === 'cut') await runCut(job, ac.signal, setPhase);
      else if (job.stage === 'transcribe') await runTranscribe(job, src, ac.signal, setPhase);
      else throw new Error(`this node doesn't run "${job.stage}"`);
      log(`✓ job ${job.id}: ${job.stage} ${job.item.label} done in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) {
      const lost = ac.signal.aborted ? ac.signal.reason : err instanceof LostJob ? err : null;
      if (lost) return log(`– job ${job.id} dropped: ${lost.message}`);
      if (err instanceof HubUnreachable) throw err; // the lease runs out and the job is queued again
      const silent = err instanceof cut.SilentError;
      log(`${silent ? '–' : '✗'} job ${job.id}: ${job.stage} ${job.item.label} ${silent ? 'skipped' : 'failed'}: ${err.message}`);
      await post(`/node/jobs/${job.id}/fail`, { error: err.message, silent }).catch((e) => log(`  ✗ couldn't report it: ${e.message}`));
    } finally {
      clearInterval(timer);
    }
  }

  /** Claim and run one job; resolves whether there was one. */
  async function step() {
    const job = await claim();
    if (!job) return false;
    await runJob(job);
    return true;
  }

  async function loop() {
    log(`→ Compute node ${o.nodeId}: ${o.stages.join(' + ')} for ${o.hubUrls.join(', ')}`);
    let backoff = o.backoffMs[0];
    let down = false;
    while (!stopped) {
      try {
        await step();
        if (down) log('✓ hub reachable again');
        down = false;
        backoff = o.backoffMs[0];
      } catch (err) {
        if (stopped) break;
        if (!down || !(err instanceof HubUnreachable)) log(`✗ ${err.message}; retrying in ${Math.round(backoff / 1000)}s`);
        down = err instanceof HubUnreachable;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, o.backoffMs[1]);
      }
    }
  }

  return { step, loop, runJob, claim, stop: () => (stopped = true), cache, hub };
}

module.exports = { createAgent, createHub, createCache, HubUnreachable, LostJob };
