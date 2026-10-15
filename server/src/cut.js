/**
 * Silence-cut a recording with auto-editor (port of the cutting repo's
 * gapless_batch.sh). For  <dir>/X recording.mp4  it writes:
 *
 *   <dir>/cutted/X recording cutted.mp4            the cut video
 *   <dir>/cutted/X recording cutted.timeline.json  kept spans (auto-editor --export v1)
 *
 * Both go through .partial_ names and are renamed into place only when
 * finished, so a half-written file never looks done and an older cut is only
 * replaced by a complete new one. "Timeline is empty" (nothing louder than the
 * threshold) is a skip, not a failure.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { run, tailLines, duration } = require('./media');
const { loadTimeline, cutLength } = require('./timeline');

const MIN_OUTPUT_BYTES = 100 * 1024;

class SilentError extends Error {}

const paramsKey = () => [config.cutEdit, config.cutMargin, ...config.cutExtraArgs].join('|');

/** Relative output paths for an original at `rel` (relative to DOWNLOAD_DIR). */
function cutPaths(rel) {
  const dir = path.join(path.dirname(rel), 'cutted');
  const stem = `${path.basename(rel, path.extname(rel))} cutted`;
  return { video: path.join(dir, `${stem}.mp4`), timeline: path.join(dir, `${stem}.timeline.json`) };
}

async function autoEditor(args) {
  const r = await run(config.autoEditorBin, [...args, '--progress', 'none', '--no-open'], {
    timeoutMs: config.cutTimeoutMin * 60000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  if (/Timeline is empty/i.test(out)) throw new SilentError(`nothing in the recording is louder than ${config.cutEdit}`);
  if (r.code !== 0) throw new Error(`auto-editor exited ${r.code}:\n${tailLines(out)}`);
  return out;
}

/**
 * Cut the recording at `rel`. Resolves { outputPath, meta } or throws
 * SilentError (→ skipped) / Error (→ failed).
 */
async function cutRecording(rel) {
  const src = path.join(config.downloadDir, rel);
  const out = cutPaths(rel);
  const absVideo = path.join(config.downloadDir, out.video);
  const absTimeline = path.join(config.downloadDir, out.timeline);
  fs.mkdirSync(path.dirname(absVideo), { recursive: true });

  const partial = (p) => path.join(path.dirname(p), `.partial_${path.basename(p)}`);
  const tmpVideo = partial(absVideo);
  const tmpTimeline = partial(absTimeline);
  const edit = ['--edit', config.cutEdit, '--margin', config.cutMargin];

  // Leftovers from an interrupted run
  fs.rmSync(tmpVideo, { force: true });
  fs.rmSync(tmpTimeline, { force: true });
  try {
    // 1) Timeline first: analysis only, fast, and fails early on silent files.
    await autoEditor([src, ...edit, '--export', 'v1', '-o', tmpTimeline]);
    const spans = loadTimeline(tmpTimeline);

    // 2) Render the cut video with the same settings.
    await autoEditor([src, ...edit, ...config.cutExtraArgs, '-o', tmpVideo]);
    const size = fs.existsSync(tmpVideo) ? fs.statSync(tmpVideo).size : 0;
    if (size <= MIN_OUTPUT_BYTES) throw new Error(`auto-editor wrote only ${size} bytes`);

    fs.renameSync(tmpVideo, absVideo);
    fs.renameSync(tmpTimeline, absTimeline);

    const origDuration = spans.length ? await duration(src) : null;
    const keptSec = cutLength(spans);
    return {
      outputPath: out.video,
      meta: {
        timeline: out.timeline,
        size,
        duration: await duration(absVideo),
        keptSec,
        keptPct: origDuration ? Math.round((1000 * keptSec) / origDuration) / 10 : null,
      },
    };
  } finally {
    fs.rmSync(tmpVideo, { force: true });
    fs.rmSync(tmpTimeline, { force: true });
  }
}

module.exports = { cutRecording, cutPaths, paramsKey, SilentError };
