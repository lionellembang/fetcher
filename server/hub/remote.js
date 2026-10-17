/**
 * COMPUTE=remote: cut and transcribe run on a compute node (server/node.js on
 * the PC), not here. The worker's stage queues a node job and waits for it:
 *
 *   run()  ─▶ node_jobs row (queued) ─▶ node claims it over /node (leased,
 *              heartbeats) ─▶ uploads results, completes (done / skipped / failed)
 *          ◀─ polled every POLL_MS; the outcome becomes the stage's
 *
 * The job's settings are this hub's (params), so params_key stays meaningful
 * whatever the node's own .env says. A job waits as long as it takes: the
 * node may be off for days. A worker restart re-attaches to its job (same
 * key). A lease that runs out (node shut down mid-job) puts the job back in
 * the queue; it never fails it.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const settings = require('./settings');
const transcripts = require('./transcripts');
const cut = require('../shared/cut');

const POLL_MS = 5000;
const SWEEP_MS = 60000;
const ONLINE_MS = 90000; // a node that called in within this long counts as online
const FINAL = new Set(['done', 'failed', 'skipped', 'cancelled']);
const REMOTE_STAGES = ['cut', 'transcribe'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()); // the worker's server keeps the process up
const label = (item) => `${item.course_code} ${item.component} S${item.session_number}`;
const isRemote = (stage) => config.compute === 'remote' && REMOTE_STAGES.includes(stage);

/** The settings a job runs with (this hub's) and their key. */
const SETTINGS = {
  cut: () => ({ paramsKey: settings.cutKey(), params: settings.cut() }),
  transcribe: (probeMeta) => ({ paramsKey: settings.transcribeKey(), params: settings.transcribe(probeMeta) }),
};

/** Where an upload for `name` (video | timeline) collects on the hub, relative to DOWNLOAD_DIR. */
function partialPath(item, jobId, name) {
  return path.join(path.dirname(cut.cutPaths(item.file_path).video), `.partial_node_${jobId}_${name}`);
}

function removePartials(job, item = store.getItem(job.item_id)) {
  if (job.stage !== 'cut' || !item || !item.file_path) return;
  for (const name of ['video', 'timeline']) fs.rmSync(path.join(config.downloadDir, partialPath(item, job.id, name)), { force: true });
}

/**
 * Run `stage` of `item` on the compute node. Resolves like the local stage
 * ({ outputPath?, meta }); throws cut.SilentError when the node found no audio
 * and Error when it failed.
 */
async function run(item, stage, { probeMeta, pollMs = POLL_MS } = {}) {
  const { paramsKey, params } = SETTINGS[stage](probeMeta);
  const key = `${item.id}|${stage}|${paramsKey}`;
  const { job, attached } = store.upsertNodeJob({ itemId: item.id, stage, paramsKey, key, params });
  console.log(`  … ${stage} ${label(item)}: ${attached ? 're-attached to' : 'queued'} node job ${job.id}`);

  let last = null;
  for (;;) {
    const j = store.getNodeJob(job.id);
    if (!j) throw new Error(`node job ${job.id} disappeared`);
    if (FINAL.has(j.status)) return finish(item, j);
    const state = j.status === 'leased' ? `running on ${j.node_id}` : 'waiting for the compute node';
    if (state !== last) console.log(`  … ${stage} ${label(item)}: ${state}`);
    last = state;
    await sleep(pollMs);
  }
}

/** Turn a finished job into the stage's result, and mark it taken. */
function finish(item, j) {
  const taken = (fields = {}) => store.setNodeJob(j.id, { ...fields, consumed_at: new Date().toISOString() });
  if (j.status === 'done' && j.stage === 'cut') {
    const r = j.result || {};
    if (!r.outputPath || !fs.existsSync(path.join(config.downloadDir, r.outputPath))) {
      taken();
      throw new Error(`node job ${j.id} finished, but the cut file isn't on disk`);
    }
    taken();
    return { outputPath: r.outputPath, meta: { ...r.meta, node: j.node_id } };
  }
  if (j.status === 'done' && j.stage === 'transcribe') {
    const r = j.result || {};
    transcripts.save(item, { segments: r.segments, language: r.language, duration: j.params.duration });
    taken({ result: { meta: r.meta } }); // the segments are in the transcript now
    return { meta: { ...r.meta, node: j.node_id } };
  }
  taken();
  if (j.status === 'skipped') throw new cut.SilentError(j.error || 'no audio');
  if (j.status === 'cancelled') throw new Error(`node job ${j.id} was cancelled${j.error ? ` (${j.error})` : ''}`);
  throw new Error(j.error || `node job ${j.id} failed`);
}

// ---- sweeper (worker) ----

/** Why an open job is no longer wanted, or null. */
function staleReason(job) {
  const item = store.getItem(job.item_id);
  if (!item || item.status !== 'downloaded' || !item.file_path || !fs.existsSync(path.join(config.downloadDir, item.file_path))) {
    return 'the recording is no longer on disk';
  }
  const enabled = job.stage === 'cut' ? config.cutEnabled : config.transcribeEnabled;
  if (!enabled) return `${job.stage} is turned off`;
  if (job.params_key !== SETTINGS[job.stage]().paramsKey) return 'the settings changed';
  return null;
}

/** Expired leases back to the queue; jobs nobody wants any more cancelled. */
function sweep(nowMs = Date.now()) {
  for (const j of store.expireNodeLeases(nowMs)) {
    console.log(`… node job ${j.id} (${j.stage} ${j.item_id}): the node stopped calling in; back in the queue`);
  }
  for (const j of store.listNodeJobs({ status: ['queued', 'leased'] })) {
    const why = staleReason(j);
    if (why && store.cancelNodeJob(j.id, why)) {
      removePartials(j);
      console.log(`– node job ${j.id} (${j.stage} ${j.item_id}) cancelled: ${why}`);
    }
  }
}

let sweeper = null;
function startSweeper() {
  if (sweeper) return;
  sweep();
  sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.error(`✗ node job sweep: ${err.message}`);
    }
  }, SWEEP_MS);
  sweeper.unref();
}

// ---- status (worker + web) ----

/** { online, lastSeen, info } of the compute node, from what it last reported. */
function nodeState() {
  const lastSeen = store.getMeta('node_last_seen');
  let info = null;
  try {
    info = JSON.parse(store.getMeta('node_info') || 'null');
  } catch {}
  return { online: !!lastSeen && Date.now() - Date.parse(lastSeen) < ONLINE_MS, lastSeen, info };
}

function jobView(j) {
  const item = store.getItem(j.item_id);
  return { id: j.id, stage: j.stage, itemId: j.item_id, label: item ? label(item) : j.item_id, status: j.status, nodeId: j.node_id, progress: j.progress };
}

/** { node, queued, leased: [job] } for the dashboard and MCP. */
function status() {
  const open = store.listNodeJobs({ status: ['queued', 'leased'] });
  return {
    node: nodeState(),
    queued: open.filter((j) => j.status === 'queued').length,
    leased: open.filter((j) => j.status === 'leased').map(jobView),
  };
}

/** The open job for one item's stage, or null. */
function openJob(itemId, stage) {
  const j = store.listNodeJobs({ status: ['queued', 'leased'], itemId, stage })[0];
  return j ? jobView(j) : null;
}

/**
 * Mark the cut / transcribe rows of { [itemId]: { [stage]: row } } that are
 * waiting on the compute node: row.remote = { state: leased | queued | waiting, … }
 * (waiting = the node is offline).
 */
function annotateStages(stagesByItem, node = nodeState()) {
  const open = new Map(store.listNodeJobs({ status: ['queued', 'leased'] }).map((j) => [`${j.item_id}|${j.stage}`, j]));
  for (const [itemId, stages] of Object.entries(stagesByItem)) {
    for (const stage of REMOTE_STAGES) {
      const s = stages[stage];
      if (!s || (s.status !== 'pending' && s.status !== 'running')) continue;
      const j = open.get(`${itemId}|${stage}`);
      if (j && j.status === 'leased') s.remote = { state: 'leased', nodeId: j.node_id, progress: j.progress };
      else s.remote = { state: node.online ? 'queued' : 'waiting' };
    }
  }
  return stagesByItem;
}

module.exports = { run, sweep, startSweeper, status, nodeState, openJob, annotateStages, partialPath, removePartials, isRemote, REMOTE_STAGES };
