/**
 * One scan: walk period → components → classes → sessions over the LMS API,
 * record every recording, then download the ones that aren't on disk yet.
 *
 * Only sessions that had a Zoom meeting can have a recording. A 404 from the
 * recording endpoint means "not ready yet" (they appear some days after class),
 * so those are re-checked every scan. Recording links are never stored; the
 * downloader (recordings.js) and the web UI each fetch a fresh one (~12h) right
 * before use.
 */
const config = require('./config');
const lms = require('./lms');
const store = require('./store');
const { downloadRecordings } = require('./recordings');

let running = null;

/** Run a scan; if one is already running, return that one. */
function runScan() {
  if (running) return running;
  running = scan().finally(() => {
    running = null;
  });
  return running;
}

const isScanning = () => !!running;

async function scan() {
  const startedAt = Date.now();
  console.log('=== scan start', new Date().toISOString(), '===');
  config.ensureDirs();
  const summary = { periods: [], classes: 0, sessions: 0, recordings: { new: 0, notYet: 0 } };

  for (const period of await resolvePeriods()) {
    summary.periods.push(period);
    for (const component of (await lms.classComponents(period)) || []) {
      for (const cls of (await lms.classes(period, component)) || []) {
        summary.classes++;
        await scanClass(period, component, cls, summary);
      }
    }
  }

  if (config.downloadRecordings) {
    try {
      Object.assign(summary.recordings, await downloadRecordings());
    } catch (err) {
      summary.recordings.error = err.message;
      console.error(`✗ Recording downloads stopped: ${err.message}`);
    }
  }

  store.setMeta('last_scan', new Date().toISOString());
  summary.ms = Date.now() - startedAt;
  console.log(`✓ scan done in ${summary.ms}ms: ${JSON.stringify(summary)}`);
  return summary;
}

/** PERIODS from .env, or the currently active period. */
async function resolvePeriods() {
  if (config.periods.length) return config.periods;
  const all = (await lms.academicPeriods()) || [];
  const active = all.find((p) => p.isActiveRunningPeriod) || all.find((p) => p.isRunningPeriod);
  if (!active) throw new Error('No active academic period found — set PERIODS in .env.');
  return [active.academicPeriod];
}

async function scanClass(period, component, cls, summary) {
  const detail = await lms.classDetail(cls.classId);
  const base = {
    period,
    classId: cls.classId,
    courseCode: detail.courseCode || cls.courseCode,
    courseTitle: detail.courseTitleEn || cls.courseName,
    component,
    classCode: detail.classCode || cls.classCode,
  };

  for (const s of detail.sessions || []) {
    if (new Date(s.dateEnd) > new Date()) continue; // hasn't happened yet
    summary.sessions++;
    const id = `recording:${s.id}`;
    const known = store.getItem(id);
    if (known && known.status !== 'not_yet') continue; // already found

    const sd = await lms.sessionDetail(s.id);
    if (!sd.joinUrl || sd.deliveryMode === 'GSLC') continue; // no meeting → no recording
    const ctx = {
      ...base,
      id,
      sessionId: s.id,
      sessionNumber: Number(s.classSessionNumber),
      sessionDate: sd.dateStart || s.dateEnd,
    };
    await trackRecording(ctx, summary);
  }
}

async function trackRecording(ctx, summary) {
  const rec = await lms.zoomRecording(ctx.sessionId);
  const status = store.upsertItem(
    { ...ctx, kind: 'recording', title: `Session ${ctx.sessionNumber} recording` },
    rec && rec.recordingUrl ? 'available' : 'not_yet'
  );
  if (status === 'available') {
    summary.recordings.new++;
    console.log(`  + recording: ${ctx.courseCode} ${ctx.component} session ${ctx.sessionNumber}`);
  } else summary.recordings.notYet++;
}

module.exports = { runScan, isScanning };
