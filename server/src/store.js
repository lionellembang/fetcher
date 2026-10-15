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
  `);
  return db;
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

module.exports = { upsertItem, markDownloaded, markFailed, getItem, listItems, counts, setMeta, getMeta };
