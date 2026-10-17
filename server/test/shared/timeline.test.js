const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTimeline, cutLength, origToCut, cutToOrig, mapSegments } = require('../../shared/timeline');

// 25 fps: keep 0–5.52 s, cut 5.52–11.64 s, keep 11.64–20.52 s, cut the rest
// (the real export for a tone/silence/tone/silence test clip).
const TL = { version: '1', timebase: '25/1', chunks: [[0, 138, 1], [138, 291, 99999], [291, 513, 1], [513, 750, 99999]] };
const spans = parseTimeline(TL);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('parses kept spans and total cut length', () => {
  assert.equal(spans.length, 2);
  near(spans[0].o0, 0);
  near(spans[0].o1, 5.52);
  near(spans[1].o0, 11.64);
  near(spans[1].c0, 5.52);
  near(cutLength(spans), 14.4); // matches ffprobe of the rendered cut
});

test('origToCut inside kept spans', () => {
  near(origToCut(spans, 0), 0);
  near(origToCut(spans, 3), 3);
  near(origToCut(spans, 11.64), 5.52);
  near(origToCut(spans, 15), 5.52 + (15 - 11.64));
});

test('origToCut in a removed gap snaps forward, or back with "prev"', () => {
  near(origToCut(spans, 8), 5.52);
  near(origToCut(spans, 8, 'prev'), 5.52);
  near(origToCut(spans, 25), 14.4); // after the last span
  near(origToCut(spans, 25, 'prev'), 14.4);
});

test('cutToOrig is the inverse on kept time', () => {
  for (const t of [0, 1.5, 5.5, 5.52, 7, 10, 14.39]) near(origToCut(spans, cutToOrig(spans, t)), t);
  near(cutToOrig(spans, 6), 11.64 + 0.48);
  near(cutToOrig(spans, 100), 20.52); // clamped to the end
});

test('mapSegments drops removed segments and clamps straddling ones', () => {
  const segs = [
    { start: 1, end: 2, text: 'kept' },
    { start: 6, end: 9, text: 'removed' },
    { start: 5, end: 13, text: 'straddles' },
  ];
  const out = mapSegments(spans, segs);
  assert.deepEqual(out.map((s) => s.text), ['kept', 'straddles']);
  near(out[1].start, 5);
  near(out[1].end, 5.52 + 1.36);
});

test('speed and touching chunks', () => {
  const s = parseTimeline({ timebase: '10/1', chunks: [[0, 10, 1], [10, 30, 2], [30, 40, 1]] });
  assert.equal(s.length, 3);
  near(cutLength(s), 1 + 1 + 1);
  near(origToCut(s, 2), 1.5);
  near(cutToOrig(s, 1.5), 2);
});

test('empty timeline', () => {
  const s = parseTimeline({ timebase: '25/1', chunks: [[0, 100, 99999]] });
  assert.equal(s.length, 0);
  assert.equal(origToCut(s, 10), 0);
  assert.deepEqual(mapSegments(s, [{ start: 1, end: 2 }]), []);
});
