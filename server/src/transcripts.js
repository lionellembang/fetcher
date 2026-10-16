/**
 * Reading transcripts: render SRT / VTT / text on either timeline, and hybrid
 * search (meaning + keywords) across every lecture.
 *
 * Search ranks ~45 s chunks two ways and fuses them (reciprocal rank fusion):
 *   - semantic: cosine of the query embedding vs. each chunk's embedding
 *   - keyword:  FTS5 bm25 over segments, each hit attributed to its chunk
 * The match label needs a cosine floor and, once enough chunks are indexed for
 * it to mean something, a z-score: how far the chunk stands out from the
 * query's average over all chunks. (e5 models score everything 0.7–0.85, so a
 * raw cosine alone is fragile; with few chunks the z-score is noise, and it
 * can't exceed √(n−1).)
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const whisper = require('./whisper');
const { loadTimeline, origToCut, mapSegments } = require('./timeline');

// ---- timelines ----

const timelineCache = new Map(); // abs path → { mtimeMs, spans }

/** Kept spans for an item's cut, or null if it has no cut. */
function spansFor(itemId) {
  const st = store.getStage(itemId, 'cut');
  if (!st || st.status !== 'done' || !st.meta.timeline) return null;
  const abs = path.join(config.downloadDir, st.meta.timeline);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  const hit = timelineCache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.spans;
  const spans = loadTimeline(abs);
  timelineCache.set(abs, { mtimeMs: stat.mtimeMs, spans });
  return spans;
}

/** Segments on the requested timeline ('original' | 'cut'), optionally within [from, to] of THAT timeline. */
function segmentsOn(itemId, timeline = 'original', { from, to } = {}) {
  if (timeline !== 'cut') return store.getSegments(itemId, { from, to });
  const spans = spansFor(itemId);
  if (!spans) throw new Error('this recording has no cut version (yet)');
  const lo = from ?? -Infinity;
  const hi = to ?? Infinity;
  return mapSegments(spans, store.getSegments(itemId)).filter((s) => s.end > lo && s.start < hi);
}

// ---- rendering ----

function clock(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

/** m:ss or h:mm:ss, for people. */
function shortClock(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function render(segments, format) {
  if (format === 'srt') {
    return segments.map((s, i) => `${i + 1}\n${clock(s.start, ',')} --> ${clock(s.end, ',')}\n${s.text}\n`).join('\n');
  }
  if (format === 'vtt') {
    return `WEBVTT\n\n${segments.map((s) => `${clock(s.start, '.')} --> ${clock(s.end, '.')}\n${s.text}\n`).join('\n')}`;
  }
  if (format === 'txt') return segments.map((s) => s.text).join('\n') + '\n';
  if (format === 'timestamped') return segments.map((s) => `[${shortClock(s.start)}] ${s.text}`).join('\n') + '\n';
  throw new Error(`unknown format "${format}"`);
}

// ---- links ----

const sessionBase = (sessionId) => `${config.publicUrl}/d/${config.accessToken}/s/${encodeURIComponent(sessionId)}`;

function links(item, origSec, spans) {
  const out = { original: `${sessionBase(item.session_id)}?t=${Math.floor(origSec)}` };
  if (spans) out.cut = `${sessionBase(item.session_id)}?v=cut&t=${Math.floor(origToCut(spans, origSec))}`;
  return out;
}

// ---- search ----

let vectorCache = null; // { rows, mat, dim, version }

function vectors() {
  // The worker indexes; this may be the web process. A changed version = new chunks.
  const version = store.getMeta('chunks_version');
  if (vectorCache && vectorCache.version === version) return vectorCache;
  const rows = store.allChunks().filter((r) => r.embed_model === config.embedModel);
  const dim = rows.length ? rows[0].embedding.length : 0;
  const mat = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => mat.set(r.embedding, i * dim));
  for (const r of rows) delete r.embedding;
  vectorCache = { rows, mat, dim, version };
  return vectorCache;
}

/** Words of a query as an FTS5 OR-query: "a" OR "b" … (punctuation can't break the syntax). */
function ftsQuery(q) {
  const words = [...new Set((String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1))];
  return { words, match: words.map((w) => `"${w}"`).join(' OR ') };
}

const RRF_K = 60;

/**
 * Hybrid search. Returns { hits, degraded, coverage }.
 * Each hit: { itemId, sessionId, course, sessionNumber, date, start, end, cut: {start,end}|null,
 *             at: {original, cut}, excerpt, cosine, z, match, keywords, links }
 */
async function search(query, { course, period, limit = 8, mode = 'hybrid' } = {}) {
  const items = new Map(store.listItems({ kind: 'recording' }).map((i) => [i.id, i]));
  const inScope = (it) => it && courseMatches(it, course) && (!period || it.period === period);
  const cand = new Map(); // key → candidate
  const key = (itemId, idx) => `${itemId}#${idx}`;
  let degraded = false;
  let useZ = false;

  // Semantic
  const { rows, mat, dim } = vectors();
  if (mode !== 'keyword' && rows.length) {
    try {
      const { vectors: [qv] } = await whisper.embed([query], 'query');
      const scores = [];
      for (let i = 0; i < rows.length; i++) {
        if (!inScope(items.get(rows[i].item_id))) continue;
        let dot = 0;
        const off = i * dim;
        for (let k = 0; k < dim; k++) dot += mat[off + k] * qv[k];
        scores.push([i, dot]);
      }
      if (scores.length) {
        useZ = scores.length >= config.searchMinChunksForZ;
        const mean = scores.reduce((a, [, s]) => a + s, 0) / scores.length;
        const sd = Math.sqrt(scores.reduce((a, [, s]) => a + (s - mean) ** 2, 0) / scores.length) || 1;
        scores.sort((a, b) => b[1] - a[1]);
        scores.slice(0, 100).forEach(([i, s], rank) => {
          const r = rows[i];
          cand.set(key(r.item_id, r.idx), { chunk: r, cosine: s, z: (s - mean) / sd, rrf: 1 / (RRF_K + rank + 1), kw: [] });
        });
      }
    } catch (err) {
      degraded = `semantic search unavailable (${err.message}); keyword results only`;
    }
  } else if (mode !== 'keyword') {
    degraded = 'no lectures are indexed for semantic search yet; keyword results only';
  }

  // Keyword
  const { words, match } = ftsQuery(query);
  if (match) {
    const segHits = store.searchSegments(match, { course, period, limit: 300 });
    const chunksByItem = new Map();
    for (const r of rows) (chunksByItem.get(r.item_id) || chunksByItem.set(r.item_id, []).get(r.item_id)).push(r);
    let rank = 0;
    const seen = new Set();
    for (const h of segHits) {
      const chunk = (chunksByItem.get(h.item_id) || []).find((c) => c.seg_from <= h.idx && h.idx <= c.seg_to);
      // Not indexed yet → a one-segment pseudo-chunk, so keyword search still works.
      const c = chunk || { item_id: h.item_id, idx: `s${h.idx}`, start: h.start, end: h.end, seg_from: h.idx, seg_to: h.idx, text: h.text };
      const k = key(c.item_id, c.idx);
      const cur = cand.get(k) || cand.set(k, { chunk: c, cosine: null, z: null, rrf: 0, kw: [] }).get(k);
      cur.kw.push(h);
      if (!seen.has(k)) {
        seen.add(k);
        cur.rrf += 1 / (RRF_K + ++rank);
      }
    }
  }

  // Rank, then drop hits that overlap a better one in the same lecture.
  const ranked = [...cand.values()].sort((a, b) => b.rrf - a.rrf);
  const picked = [];
  for (const c of ranked) {
    if (picked.length >= limit) break;
    if (picked.some((p) => p.chunk.item_id === c.chunk.item_id && p.chunk.start < c.chunk.end && c.chunk.start < p.chunk.end)) continue;
    picked.push(c);
  }

  const hits = picked.map((c) => {
    const item = items.get(c.chunk.item_id);
    const segs = store.getSegments(item.id).filter((s) => s.idx >= c.chunk.seg_from && s.idx <= c.chunk.seg_to);
    // The moment to jump to: best keyword segment, else the chunk's middle segment.
    const bestKw = c.kw.slice().sort((a, b) => a.rank - b.rank)[0];
    const mid = (c.chunk.start + c.chunk.end) / 2;
    const at = bestKw
      ? bestKw.start
      : (segs.slice().sort((a, b) => Math.abs((a.start + a.end) / 2 - mid) - Math.abs((b.start + b.end) / 2 - mid))[0] || c.chunk)
          .start;
    const spans = spansFor(item.id);
    const kwWords = new Set(c.kw.flatMap((h) => words.filter((w) => h.text.toLowerCase().includes(w))));
    return {
      itemId: item.id,
      sessionId: item.session_id,
      course: `${item.course_code} ${item.course_title} (${item.component})`,
      courseCode: item.course_code,
      period: item.period,
      sessionNumber: item.session_number,
      date: item.session_date ? String(item.session_date).slice(0, 10) : null,
      start: round(c.chunk.start),
      end: round(c.chunk.end),
      cut: spans ? { start: round(origToCut(spans, c.chunk.start)), end: round(origToCut(spans, c.chunk.end, 'prev')) } : null,
      at: { original: round(at), originalClock: shortClock(at), cut: spans ? round(origToCut(spans, at)) : null },
      excerpt: segs.map((s) => s.text).join(' ') || c.chunk.text,
      cosine: c.cosine == null ? null : round(c.cosine, 3),
      z: c.z == null ? null : round(c.z, 2),
      keywords: [...kwWords],
      match: label(c, words, kwWords, useZ),
      links: links(item, at, spans),
    };
  });

  return { hits, degraded, coverage: coverage({ course, period }) };
}

/** strong / possible / weak. */
function label(c, words, kwWords, useZ) {
  const kwShare = words.length ? kwWords.size / words.length : 0;
  if (c.cosine != null) {
    const ok = (cos, z) => c.cosine >= cos && (!useZ || c.z >= z);
    if (ok(config.searchStrongCos, config.searchStrongZ)) return 'strong';
    if (ok(config.searchPossibleCos, config.searchPossibleZ)) return 'possible';
    // semantically unremarkable, but has most of a multi-word query's words
    return words.length >= 2 && kwShare >= 0.75 ? 'possible' : 'weak';
  }
  return words.length && kwShare === 1 ? 'possible' : 'weak'; // keyword-only (degraded)
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** `course` (optional) is part of a course code or title, any case: "COMP6798", "big data". */
function courseMatches(item, course) {
  if (!course) return true;
  const q = String(course).toLowerCase().trim();
  return String(item.course_code).toLowerCase().includes(q) || String(item.course_title).toLowerCase().includes(q);
}

/**
 * Where a session is, for people and for search coverage:
 * searchable | processing | no_recording_yet | not_downloaded | no_audio | failed
 */
function sessionState(item, st = {}) {
  if (item.status === 'not_yet') return 'no_recording_yet';
  if (item.status !== 'downloaded') return item.status === 'failed' ? 'failed' : 'not_downloaded';
  if (st.transcribe && st.transcribe.status === 'skipped') return 'no_audio';
  if ([st.probe, st.transcribe, st.index].some((s) => s && s.status === 'failed')) return 'failed';
  if (st.transcribe && st.transcribe.status === 'done') return 'searchable';
  return 'processing';
}

/** How much of the scope is searchable, so "not found" can be qualified. */
function coverage({ course, period } = {}) {
  const stages = store.stagesByItem();
  const out = { searchable: 0, processing: 0, no_recording_yet: 0, not_downloaded: 0, no_audio: 0, failed: 0 };
  for (const it of store.listItems({ kind: 'recording', period })) {
    if (courseMatches(it, course)) out[sessionState(it, stages[it.id])]++;
  }
  return out;
}

module.exports = { segmentsOn, render, search, spansFor, shortClock, links, coverage, courseMatches, sessionState };
