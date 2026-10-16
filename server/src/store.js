/**
 * SQLite (built-in node:sqlite) record of every recording we've seen, one row
 * per class session. Short-lived URLs are never stored — they're fetched fresh
 * right before each download.
 *
 * status:
 *   not_yet     recording endpoint said 404 — re-checked every scan
 *   available   found, not downloaded yet
 *   downloaded  file is on disk (file_path, size)
 *   failed      last download attempt failed (error) — retried next scan
 */
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db;

function getDb() {
  if (db) return db;
  config.ensureDirs();
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000'); // the worker and web processes share the file
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,          -- 'recording'
      period         TEXT,
      class_id       TEXT,
      course_code    TEXT,
      course_title   TEXT,
      component      TEXT,
      class_code     TEXT,
      session_id     TEXT,
      session_number INTEGER,
      session_date   TEXT,
      resource_id    TEXT,
      title          TEXT,
      status         TEXT NOT NULL,
      file_path      TEXT,                   -- relative to DOWNLOAD_DIR
      size           INTEGER,
      error          TEXT,
      first_seen     TEXT NOT NULL,
      available_at   TEXT,                   -- when it first became downloadable
      last_checked   TEXT,
      downloaded_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    DELETE FROM items WHERE kind = 'material'; -- course materials are no longer tracked

    -- Pipeline stages run on a downloaded recording: probe, cut, transcribe, index.
    -- params_key is the settings a stage ran with; when they change, the stage is redone.
    CREATE TABLE IF NOT EXISTS stages (
      item_id     TEXT NOT NULL,
      stage       TEXT NOT NULL,
      params_key  TEXT,
      status      TEXT NOT NULL,             -- pending | running | done | skipped | failed
      output_path TEXT,                      -- relative to DOWNLOAD_DIR
      meta        TEXT,                      -- JSON
      error       TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      started_at  TEXT,
      finished_at TEXT,
      PRIMARY KEY (item_id, stage)
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      item_id    TEXT PRIMARY KEY,
      model      TEXT,
      language   TEXT,
      params_key TEXT,
      duration   REAL,
      created_at TEXT NOT NULL
    );

    -- Whisper segments, on the ORIGINAL recording's timeline.
    CREATE TABLE IF NOT EXISTS segments (
      id             INTEGER PRIMARY KEY,
      item_id        TEXT NOT NULL,
      idx            INTEGER NOT NULL,
      start          REAL NOT NULL,
      end            REAL NOT NULL,
      text           TEXT NOT NULL,
      avg_logprob    REAL,
      no_speech_prob REAL
    );
    CREATE INDEX IF NOT EXISTS segments_item ON segments (item_id, idx);
    CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
      text, content='segments', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
      INSERT INTO segments_fts (rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
      INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    -- ~45 s windows of segments with their embedding (float32, normalised) for semantic search.
    CREATE TABLE IF NOT EXISTS chunks (
      item_id     TEXT NOT NULL,
      idx         INTEGER NOT NULL,
      start       REAL NOT NULL,
      end         REAL NOT NULL,
      seg_from    INTEGER NOT NULL,
      seg_to      INTEGER NOT NULL,
      text        TEXT NOT NULL,
      embedding   BLOB NOT NULL,
      embed_model TEXT NOT NULL,
      PRIMARY KEY (item_id, idx)
    );
  `);
  return db;
}

function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

const now = () => new Date().toISOString();

/**
 * Record that an item exists. New rows get `status`; existing rows keep a
 * 'downloaded' status and only refresh their metadata otherwise.
 */
function upsertItem(item, status) {
  const d = getDb();
  const t = now();
  const existing = d.prepare('SELECT status, available_at FROM items WHERE id = ?').get(item.id);
  if (!existing) {
    d.prepare(
      `INSERT INTO items (id, kind, period, class_id, course_code, course_title, component, class_code,
         session_id, session_number, session_date, resource_id, title, status, first_seen, available_at, last_checked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      item.id, item.kind, item.period, item.classId, item.courseCode, item.courseTitle, item.component,
      item.classCode, item.sessionId, item.sessionNumber, item.sessionDate, item.resourceId ?? null,
      item.title, status, t, status === 'not_yet' ? null : t, t
    );
    return status;
  }
  const next = existing.status === 'downloaded' ? 'downloaded' : existing.status === 'failed' && status !== 'not_yet' ? 'failed' : status;
  d.prepare(
    `UPDATE items SET title = ?, course_title = ?, session_date = ?, status = ?, last_checked = ?,
       available_at = COALESCE(available_at, ?) WHERE id = ?`
  ).run(item.title, item.courseTitle, item.sessionDate, next, t, next === 'not_yet' ? null : t, item.id);
  return next;
}

function markDownloaded(id, filePath, size) {
  getDb()
    .prepare(`UPDATE items SET status = 'downloaded', file_path = ?, size = ?, error = NULL, downloaded_at = ? WHERE id = ?`)
    .run(filePath, size, now(), id);
}

function markFailed(id, error) {
  getDb().prepare(`UPDATE items SET status = 'failed', error = ? WHERE id = ?`).run(String(error).slice(0, 500), id);
}

function getItem(id) {
  return getDb().prepare('SELECT * FROM items WHERE id = ?').get(id);
}

function listItems({ kind, status, period } = {}) {
  const filters = { kind, status, period };
  const where = [];
  const args = [];
  for (const [col, val] of Object.entries(filters)) {
    if (!val) continue;
    where.push(`${col} = ?`);
    args.push(val);
  }
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY period DESC, course_code, component, session_number, kind DESC, title`;
  return getDb().prepare(sql).all(...args);
}

function counts() {
  const rows = getDb().prepare('SELECT kind, status, COUNT(*) AS n FROM items GROUP BY kind, status').all();
  const out = {};
  for (const r of rows) (out[r.kind] ??= {})[r.status] = r.n;
  return out;
}

function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

// ---- pipeline stages ----

const parseStage = (row) => row && { ...row, meta: row.meta ? JSON.parse(row.meta) : {} };

function getStage(itemId, stage) {
  return parseStage(getDb().prepare('SELECT * FROM stages WHERE item_id = ? AND stage = ?').get(itemId, stage));
}

/** { [stage]: row } for one item. */
function getStages(itemId) {
  const out = {};
  for (const row of getDb().prepare('SELECT * FROM stages WHERE item_id = ?').all(itemId)) out[row.stage] = parseStage(row);
  return out;
}

/** { [itemId]: { [stage]: row } } for every stage row. */
function stagesByItem() {
  const out = {};
  for (const row of getDb().prepare('SELECT * FROM stages').all()) (out[row.item_id] ??= {})[row.stage] = parseStage(row);
  return out;
}

/** Insert or update a stage row; only the given fields change. */
function setStage(itemId, stage, fields) {
  const d = getDb();
  const cur = d.prepare('SELECT 1 FROM stages WHERE item_id = ? AND stage = ?').get(itemId, stage);
  const f = { ...fields };
  if ('meta' in f) f.meta = f.meta == null ? null : JSON.stringify(f.meta);
  if ('error' in f && f.error != null) f.error = String(f.error).slice(0, 2000);
  if (!cur) {
    d.prepare('INSERT INTO stages (item_id, stage, status) VALUES (?, ?, ?)').run(itemId, stage, f.status || 'pending');
  }
  const cols = Object.keys(f);
  if (cols.length) {
    d.prepare(`UPDATE stages SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE item_id = ? AND stage = ?`).run(
      ...cols.map((c) => f[c] ?? null),
      itemId,
      stage
    );
  }
}

/** After a crash or restart nothing is running: put those stages back in the queue. */
function resetRunningStages() {
  return getDb().prepare(`UPDATE stages SET status = 'pending' WHERE status = 'running'`).run().changes;
}

// ---- transcripts ----

/** Replace an item's transcript and segments (the FTS index follows via triggers). */
function saveTranscript(itemId, info, segments) {
  transaction((d) => {
    d.prepare('DELETE FROM segments WHERE item_id = ?').run(itemId);
    d.prepare('DELETE FROM chunks WHERE item_id = ?').run(itemId);
    bumpChunksVersion(d);
    d.prepare(
      `INSERT INTO transcripts (item_id, model, language, params_key, duration, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET model = excluded.model, language = excluded.language,
         params_key = excluded.params_key, duration = excluded.duration, created_at = excluded.created_at`
    ).run(itemId, info.model, info.language, info.paramsKey, info.duration ?? null, now());
    const ins = d.prepare(
      'INSERT INTO segments (item_id, idx, start, end, text, avg_logprob, no_speech_prob) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    segments.forEach((s, i) => ins.run(itemId, i, s.start, s.end, s.text, s.avg_logprob ?? null, s.no_speech_prob ?? null));
  });
}

function getTranscript(itemId) {
  return getDb().prepare('SELECT * FROM transcripts WHERE item_id = ?').get(itemId);
}

/** Segments of one item, optionally only those overlapping [from, to] seconds. */
function getSegments(itemId, { from, to } = {}) {
  const lo = from ?? -Infinity;
  const hi = to ?? Infinity;
  return getDb()
    .prepare('SELECT idx, start, end, text FROM segments WHERE item_id = ? ORDER BY idx')
    .all(itemId)
    .filter((s) => s.end > lo && s.start < hi);
}

/**
 * Keyword search over segments. `match` is an FTS5 query; `course` matches
 * part of a course code or title. Returns segments with their bm25 rank
 * (lower is better).
 */
function searchSegments(match, { course, period, limit = 200 } = {}) {
  const where = ['segments_fts MATCH ?'];
  const args = [match];
  if (course) where.push('(i.course_code LIKE ? OR i.course_title LIKE ?)'), args.push(`%${course}%`, `%${course}%`);
  if (period) where.push('i.period = ?'), args.push(period);
  return getDb()
    .prepare(
      `SELECT s.item_id, s.idx, s.start, s.end, s.text, bm25(segments_fts) AS rank
       FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid JOIN items i ON i.id = s.item_id
       WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`
    )
    .all(...args, limit);
}

// ---- chunks (embeddings) ----

/** Mark the chunks as changed, so every process (web, worker) drops its cached vectors. */
function bumpChunksVersion(d) {
  d.prepare(`INSERT INTO meta (key, value) VALUES ('chunks_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    `${Date.now()}-${Math.random()}`
  );
}

/** Replace an item's chunks. */
function saveChunks(itemId, model, chunks) {
  transaction((d) => {
    bumpChunksVersion(d);
    d.prepare('DELETE FROM chunks WHERE item_id = ?').run(itemId);
    const ins = d.prepare(
      'INSERT INTO chunks (item_id, idx, start, end, seg_from, seg_to, text, embedding, embed_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    chunks.forEach((c, i) => {
      const vec = Float32Array.from(c.embedding);
      ins.run(itemId, i, c.start, c.end, c.segFrom, c.segTo, c.text, new Uint8Array(vec.buffer), model);
    });
  });
}

/** Every chunk with its embedding as a Float32Array. */
function allChunks() {
  return getDb()
    .prepare('SELECT item_id, idx, start, end, seg_from, seg_to, text, embedding, embed_model FROM chunks ORDER BY item_id, idx')
    .all()
    .map((r) => {
      const b = r.embedding;
      return { ...r, embedding: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) };
    });
}

module.exports = {
  upsertItem, markDownloaded, markFailed, getItem, listItems, counts, setMeta, getMeta,
  getStage, getStages, stagesByItem, setStage, resetRunningStages,
  saveTranscript, getTranscript, getSegments, searchSegments,
  saveChunks, allChunks,
};
