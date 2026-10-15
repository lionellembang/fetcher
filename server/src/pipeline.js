/**
 * Processing pipeline for downloaded recordings:
 *
 *   probe ──┬─▶ cut           (auto-editor; the cut video is for watching)
 *           └─▶ transcribe ──▶ index   (Whisper on the original; embeddings for search)
 *
 * Each stage has its own lane (one job at a time). Cut and transcribe are
 * "heavy" (CPU encode / GPU) and share a limit, HEAVY_CONCURRENCY. A stage
 * runs when its dependency is done and it has no result for the current
 * settings (params_key), or (index only) the transcript was redone after it.
 *
 * Failures stay failed until the next scan, a restart or a manual retry. If the
 * transcriber is down, transcribe/index go back to pending and are retried
 * every minute.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const events = require('./events');
const media = require('./media');
const cut = require('./cut');
const transcribe = require('./transcribe');
const indexer = require('./indexer');
const { UnavailableError } = require('./whisper');

const STAGES = ['probe', 'cut', 'transcribe', 'index'];
const DEPS = { probe: null, cut: 'probe', transcribe: 'probe', index: 'transcribe' };
const HEAVY = new Set(['cut', 'transcribe']);
// Stages whose input is their dependency's output: redone when the dependency is.
// (Cut and transcribe only use the probe's loudness to decide "silent", which is
// worked out on use; redoing them after every re-probe would waste hours.)
const REDO_AFTER_DEP = new Set(['index']);
const RETRY_UNAVAILABLE_MS = 60000;

const PARAMS = {
  probe: () => 'v2', // thresholds are applied on use (media.audioClass), not baked in
  cut: cut.paramsKey,
  transcribe: transcribe.paramsKey,
  index: indexer.paramsKey,
};
const ENABLED = {
  probe: () => config.cutEnabled || config.transcribeEnabled,
  cut: () => config.cutEnabled,
  transcribe: () => config.transcribeEnabled,
  index: () => config.transcribeEnabled && config.indexEnabled,
};

const RUN = {
  async probe(item) {
    const p = await media.probe(path.join(config.downloadDir, item.file_path));
    const fin = (v) => (Number.isFinite(v) ? v : null);
    return { meta: { duration: p.duration, maxVolume: fin(p.maxVolume), meanVolume: fin(p.meanVolume) } };
  },
  async cut(item, stages) {
    if (media.audioClass(stages.probe.meta).silent) return { status: 'skipped', meta: { reason: 'no audio' } };
    return cut.cutRecording(item.file_path);
  },
  async transcribe(item, stages) {
    const cls = media.audioClass(stages.probe.meta);
    if (cls.silent) return { status: 'skipped', meta: { reason: 'no audio' } };
    return transcribe.transcribeRecording(item, { ...stages.probe.meta, ...cls });
  },
  async index(item) {
    return indexer.indexRecording(item);
  },
};

// ---- lanes ----

const lanes = Object.fromEntries(STAGES.map((s) => [s, { stage: s, queue: [], running: null }]));
let heavyActive = 0;
let retryTimer = null;
const paused = new Set(); // stages waiting for the transcriber to come back
let idleWaiters = [];

const onDisk = (item) => !!item.file_path && fs.existsSync(path.join(config.downloadDir, item.file_path));
const ready = (item) => item && item.kind === 'recording' && item.status === 'downloaded' && onDisk(item);

/** Should `stage` run for this item, given its stage rows? */
function wants(stage, stages, { includeFailed }) {
  if (!ENABLED[stage]()) return false;
  const s = stages[stage];
  const dep = DEPS[stage] && stages[DEPS[stage]];
  if (DEPS[stage] && (!dep || dep.status !== 'done' || dep.params_key !== PARAMS[DEPS[stage]]())) return false;
  if (!s) return true;
  if (s.status === 'running') return false;
  if (s.params_key !== PARAMS[stage]()) return true; // settings changed
  if (REDO_AFTER_DEP.has(stage) && dep.finished_at && (!s.finished_at || dep.finished_at > s.finished_at)) return true; // input changed
  if (s.status === 'pending') return true;
  if (s.status === 'failed') return includeFailed;
  return false;
}

function enqueue(itemId, stage) {
  const lane = lanes[stage];
  if (lane.running === itemId || lane.queue.includes(itemId)) return;
  lane.queue.push(itemId);
  store.setStage(itemId, stage, { status: 'pending' });
}

let started = false; // only a process that called start() runs stages (not e.g. `npm run scan`)

/** Queue every stage this item still needs. */
function sweepItem(itemId, { includeFailed = false } = {}) {
  if (!started) return;
  const item = store.getItem(itemId);
  if (!ready(item)) return;
  const stages = store.getStages(itemId);
  for (const stage of STAGES) if (wants(stage, stages, { includeFailed })) enqueue(itemId, stage);
  pump();
}

/** Queue everything that needs work across all downloaded recordings. */
function sweep({ includeFailed = false } = {}) {
  if (!started) return;
  for (const item of store.listItems({ kind: 'recording', status: 'downloaded' })) sweepItem(item.id, { includeFailed });
  pump();
}

function pump() {
  for (const lane of Object.values(lanes)) {
    if (lane.running || !lane.queue.length || paused.has(lane.stage)) continue;
    const heavy = HEAVY.has(lane.stage);
    if (heavy && heavyActive >= config.heavyConcurrency) continue;
    const itemId = lane.queue.shift();
    lane.running = itemId;
    if (heavy) heavyActive++;
    runStage(itemId, lane.stage)
      .catch((err) => console.error(`✗ pipeline ${lane.stage} ${itemId}: ${err.stack || err}`))
      .finally(() => {
        lane.running = null;
        if (heavy) heavyActive--;
        sweepItem(itemId); // queue whatever this unblocked
        pump();
        checkIdle();
      });
  }
  checkIdle();
}

const label = (item) => `${item.course_code} ${item.component} S${item.session_number}`;

async function runStage(itemId, stage) {
  const item = store.getItem(itemId);
  if (!ready(item)) return;
  const stages = store.getStages(itemId);
  if (!wants(stage, stages, { includeFailed: true })) return; // nothing to do any more

  const attempts = ((stages[stage] && stages[stage].attempts) || 0) + 1;
  store.setStage(itemId, stage, { status: 'running', params_key: PARAMS[stage](), attempts, started_at: new Date().toISOString() });
  console.log(`→ ${stage}: ${label(item)} …`);
  const t0 = Date.now();
  try {
    const r = (await RUN[stage](item, stages)) || {};
    store.setStage(itemId, stage, {
      status: r.status || 'done',
      output_path: r.outputPath ?? null,
      meta: r.meta || {},
      error: null,
      finished_at: new Date().toISOString(),
    });
    console.log(`✓ ${stage}: ${label(item)} ${r.status || 'done'} in ${Math.round((Date.now() - t0) / 1000)}s`);
    if (stage === 'index') events.emit('indexed', itemId);
  } catch (err) {
    if (err instanceof UnavailableError) {
      store.setStage(itemId, stage, { status: 'pending', error: err.message, attempts: attempts - 1 });
      console.log(`… ${stage}: ${label(item)} waiting — ${err.message}; retrying in ${RETRY_UNAVAILABLE_MS / 1000}s`);
      lanes[stage].queue.unshift(itemId); // keep its place; the lane is paused until the retry
      paused.add(stage);
      scheduleRetry();
    } else if (err instanceof cut.SilentError) {
      store.setStage(itemId, stage, { status: 'skipped', meta: { reason: err.message }, error: null, finished_at: new Date().toISOString() });
      console.log(`– ${stage}: ${label(item)} skipped (${err.message})`);
    } else {
      store.setStage(itemId, stage, { status: 'failed', error: err.message, finished_at: new Date().toISOString() });
      console.error(`✗ ${stage}: ${label(item)}: ${err.message}`);
    }
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    paused.clear();
    sweep();
  }, RETRY_UNAVAILABLE_MS);
  retryTimer.unref();
}

const isIdle = () => Object.values(lanes).every((l) => !l.running && (!l.queue.length || paused.has(l.stage)));

function checkIdle() {
  if (!isIdle() || !idleWaiters.length) return;
  const w = idleWaiters;
  idleWaiters = [];
  w.forEach((resolve) => resolve());
}

/** Resolves once nothing is queued or running (pending "transcriber down" retries don't count). */
function waitIdle() {
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
    checkIdle();
  });
}

/** Retry one stage now (and, through it, its dependents). */
function retry(itemId, stage) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage "${stage}" (one of ${STAGES.join(', ')})`);
  const item = store.getItem(itemId);
  if (!ready(item)) throw new Error('that recording is not downloaded yet');
  const stages = store.getStages(itemId);
  const dep = DEPS[stage];
  if (dep && (!stages[dep] || stages[dep].status !== 'done')) throw new Error(`${stage} needs ${dep} to be done first`);
  if (lanes[stage].running === itemId) return 'running';
  store.setStage(itemId, stage, { status: 'pending', params_key: null }); // force a re-run
  enqueue(itemId, stage);
  pump();
  return 'queued';
}

function status() {
  const out = { heavyActive, heavyLimit: config.heavyConcurrency, lanes: {} };
  for (const lane of Object.values(lanes)) {
    const running = lane.running && store.getItem(lane.running);
    out.lanes[lane.stage] = {
      queued: lane.queue.length,
      paused: paused.has(lane.stage),
      running: running ? { id: running.id, label: label(running) } : null,
    };
  }
  return out;
}

/**
 * Boot: anything left "running" by a previous process is redone, and (unless
 * sweepAll is false) all pending and failed work is queued.
 */
function start({ sweepAll = true } = {}) {
  if (started) return;
  started = true;
  const reset = store.resetRunningStages();
  if (reset) console.log(`→ Pipeline: ${reset} interrupted stage(s) put back in the queue.`);
  events.on('downloaded', (itemId) => sweepItem(itemId, { includeFailed: true }));
  if (sweepAll) sweep({ includeFailed: true });
}

/** Queue whatever one item still needs, failed stages included. */
function runItem(itemId) {
  const item = store.getItem(itemId);
  if (!item) throw new Error(`unknown item ${itemId}`);
  if (!ready(item)) throw new Error(`${itemId} is not downloaded (status ${item.status})`);
  sweepItem(itemId, { includeFailed: true });
}

module.exports = { STAGES, start, sweep, sweepItem, runItem, retry, status, waitIdle, isIdle };
