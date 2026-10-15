const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkSegments } = require('../src/indexer');

const segs = (n, len = 5, gap = 0) =>
  Array.from({ length: n }, (_, i) => ({ idx: i, start: i * (len + gap), end: i * (len + gap) + len, text: `s${i}` }));

test('windows are about windowSec long and overlap by about overlapSec', () => {
  const chunks = chunkSegments(segs(40), 45, 15); // 200 s of 5 s segments
  assert.ok(chunks.length > 4);
  for (const c of chunks.slice(0, -1)) assert.ok(c.end - c.start >= 45 && c.end - c.start <= 50, `${c.start}-${c.end}`);
  for (let i = 1; i < chunks.length; i++) {
    const overlap = chunks[i - 1].end - chunks[i].start;
    assert.ok(overlap >= 10 && overlap <= 20, `overlap ${overlap}`);
    assert.ok(chunks[i].segFrom > chunks[i - 1].segFrom, 'always moves forward');
  }
  assert.equal(chunks[chunks.length - 1].segTo, 39, 'covers the last segment');
});

test('covers every segment', () => {
  const s = segs(37, 3, 1);
  const chunks = chunkSegments(s, 45, 15);
  const covered = new Set(chunks.flatMap((c) => Array.from({ length: c.segTo - c.segFrom + 1 }, (_, k) => c.segFrom + k)));
  assert.equal(covered.size, 37);
});

test('one long segment, and no segments', () => {
  assert.equal(chunkSegments([{ idx: 0, start: 0, end: 120, text: 'x' }], 45, 15).length, 1);
  assert.deepEqual(chunkSegments([], 45, 15), []);
});

test('text joins the segments', () => {
  assert.equal(chunkSegments(segs(3), 45, 15)[0].text, 's0 s1 s2');
});
