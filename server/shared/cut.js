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
 *
 * The settings (edit, margin, extra args) come from the caller: the hub's,
 * whether the cut runs on the hub or on a compute node.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./env');
const { run, tailLines, duration } = require('./media');
const { loadTimeline, cutLength } = require('./timeline');

const MIN_OUTPUT_BYTES = 100 * 1024;
const MIN_KEPT_SEC = 10; // less than this above the threshold = nothing worth cutting

class SilentError extends Error {}

/** Relative output paths for an original at `rel` (relative to DOWNLOAD_DIR). */
function cutPaths(rel) {
  const dir = path.join(path.dirname(rel), 'cutted');
  const stem = `${path.basename(rel, path.extname(rel))} cutted`;
  return { video: path.join(dir, `${stem}.mp4`), timeline: path.join(dir, `${stem}.timeline.json`) };
}

async function autoEditor(args, edit) {
  const r = await run(config.autoEditorBin, [...args, '--progress', 'none', '--no-open'], {
    timeoutMs: config.cutTimeoutMin * 60000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  if (/Timeline is empty/i.test(out)) throw new SilentError(`nothing in the recording is louder than ${edit}`);
  if (r.code !== 0) throw new Error(`auto-editor exited ${r.code}:\n${tailLines(out)}`);
  return out;
}

/**
 * Cut the recording at `rel` (under `downloadDir`) with auto-editor's
 * `--edit editSpec --margin margin` plus `extraArgs`. Resolves
 * { outputPath, meta } (paths relative to `downloadDir`) or throws
 * SilentError (→ skipped) / Error (→ failed).
 */
async function cutRecording(rel, { downloadDir, edit: editSpec, margin, extraArgs = [] }) {
  if (!downloadDir || !editSpec || !margin) throw new Error('cutRecording needs downloadDir, edit and margin');
  const src = path.join(downloadDir, rel);
  const out = cutPaths(rel);
  const absVideo = path.join(downloadDir, out.video);
  const absTimeline = path.join(downloadDir, out.timeline);
  fs.mkdirSync(path.dirname(absVideo), { recursive: true });

  const partial = (p) => path.join(path.dirname(p), `.partial_${path.basename(p)}`);
  const tmpVideo = partial(absVideo);
  const tmpTimeline = partial(absTimeline);
  const edit = ['--edit', editSpec, '--margin', margin];

  // Leftovers from an interrupted run
  fs.rmSync(tmpVideo, { force: true });
  fs.rmSync(tmpTimeline, { force: true });
  try {
    // 1) Timeline first: analysis only, fast, and fails early on silent files.
    await autoEditor([src, ...edit, '--export', 'v1', '-o', tmpTimeline], editSpec);
    const spans = loadTimeline(tmpTimeline);
    const kept = cutLength(spans);
    if (kept < MIN_KEPT_SEC) {
      throw new SilentError(`only ${kept.toFixed(1)}s of the recording is louder than ${editSpec.replace(/^audio:/, '')}`);
    }

    // 2) Render the cut video with the same settings.
    await autoEditor([src, ...edit, ...extraArgs, '-o', tmpVideo], editSpec);
    const size = fs.existsSync(tmpVideo) ? fs.statSync(tmpVideo).size : 0;
    if (size <= MIN_OUTPUT_BYTES) throw new Error(`auto-editor wrote only ${size} bytes`);

    fs.renameSync(tmpVideo, absVideo);
    fs.renameSync(tmpTimeline, absTimeline);

    const origDuration = await duration(src);
    const keptSec = kept;
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

module.exports = { cutRecording, cutPaths, SilentError };
