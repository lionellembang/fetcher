/**
 * Map times between an original recording and its silence-cut version, using
 * the timeline auto-editor exports (`--export v1`):
 *
 *   { "version": "1", "timebase": "25/1", "chunks": [[startFrame, endFrame, speed], ...] }
 *
 * speed 99999 (or 0) means the chunk was cut. Kept chunks become spans
 * { o0, o1, c0, speed }: original start/end and where the span starts in the cut.
 *
 * origToCut / cutToOrig / mapSegments are self-contained (no outside
 * references) so the dashboard can ship them to the browser via toString().
 */
const fs = require('fs');

const CUT_SPEED = 99999;

/** Parse an auto-editor v1 timeline into kept spans. */
function parseTimeline(json) {
  const tl = typeof json === 'string' ? JSON.parse(json) : json;
  if (!tl || !Array.isArray(tl.chunks)) throw new Error('not an auto-editor v1 timeline (no chunks)');
  const [num, den = 1] = String(tl.timebase || '').split('/').map(Number);
  const fps = num / den;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`bad timebase "${tl.timebase}"`);

  const spans = [];
  let c = 0;
  for (const [s, e, speed] of tl.chunks) {
    if (!(speed > 0) || speed >= CUT_SPEED || e <= s) continue;
    const o0 = s / fps;
    const o1 = e / fps;
    const last = spans[spans.length - 1];
    if (last && last.speed === speed && Math.abs(last.o1 - o0) < 1e-9) last.o1 = o1; // join touching spans
    else spans.push({ o0, o1, c0: c, speed });
    c += (o1 - o0) / speed;
  }
  return spans;
}

function loadTimeline(file) {
  return parseTimeline(fs.readFileSync(file, 'utf8'));
}

/** Total length of the cut, in seconds. */
function cutLength(spans) {
  const l = spans[spans.length - 1];
  return l ? l.c0 + (l.o1 - l.o0) / l.speed : 0;
}

/**
 * Original time → cut time. A time inside a removed gap snaps to the next kept
 * span ('next', default) or to the end of the previous one ('prev').
 */
function origToCut(spans, t, snap) {
  if (!spans.length) return 0;
  let lo = 0;
  let hi = spans.length - 1;
  let i = -1; // last span with o0 <= t
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].o0 <= t) (i = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  const end = (s) => s.c0 + (s.o1 - s.o0) / s.speed;
  if (i >= 0 && t < spans[i].o1) return spans[i].c0 + (t - spans[i].o0) / spans[i].speed;
  if (snap === 'prev') return i >= 0 ? end(spans[i]) : 0;
  return i + 1 < spans.length ? spans[i + 1].c0 : end(spans[spans.length - 1]);
}

/** Cut time → original time. */
function cutToOrig(spans, t) {
  if (!spans.length) return t;
  let lo = 0;
  let hi = spans.length - 1;
  let i = 0; // last span with c0 <= t
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].c0 <= t) (i = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  const s = spans[i];
  return Math.min(s.o1, Math.max(s.o0, s.o0 + (t - s.c0) * s.speed));
}

/**
 * Segments ({start, end, ...}) on the original timeline → the cut timeline.
 * A segment entirely inside removed audio is dropped; one straddling a cut is
 * clamped to the kept parts.
 */
function mapSegments(spans, segments) {
  const out = [];
  for (const seg of segments) {
    const start = origToCut(spans, seg.start, 'next');
    const end = origToCut(spans, seg.end, 'prev');
    if (end - start > 0.05) out.push({ ...seg, start, end });
  }
  return out;
}

module.exports = { parseTimeline, loadTimeline, cutLength, origToCut, cutToOrig, mapSegments };
