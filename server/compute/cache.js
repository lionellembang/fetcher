/**
 * Originals on the compute node, kept between jobs so cut and transcribe of
 * one lecture download it once: { [itemId]: { rel, size, usedAt } } in
 * <dir>/index.json, least recently used evicted past the size limit.
 */
const fs = require('fs');
const path = require('path');

/** Originals on this node: { [itemId]: { rel, size, usedAt } } in index.json, LRU-evicted. */
function createCache(dir, maxGb) {
  const indexFile = path.join(dir, 'index.json');
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {}
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${indexFile}.tmp`, JSON.stringify(index));
    fs.renameSync(`${indexFile}.tmp`, indexFile);
  };
  /** Absolute path for a hub-relative path; never outside the cache. */
  const pathFor = (rel) => {
    const p = path.resolve(dir, String(rel || ''));
    if (path.isAbsolute(String(rel || '')) || !p.startsWith(dir + path.sep)) throw new Error(`refusing a path outside the cache: ${rel}`);
    return p;
  };
  const present = (e) => {
    try {
      return fs.statSync(pathFor(e.rel)).size === e.size;
    } catch {
      return false;
    }
  };
  return {
    pathFor,
    /** Item ids whose original is here (the hub prefers giving us their jobs). */
    held: () => Object.keys(index).filter((id) => present(index[id])),
    has(itemId, rel, size) {
      const e = index[itemId];
      return !!e && e.rel === rel && (!size || e.size === size) && present(e);
    },
    touch(itemId, rel, size) {
      index[itemId] = { rel, size, usedAt: Date.now() };
      save();
    },
    /** Drop the least recently used originals until the cache fits (never `keepId`). */
    evict(keepId) {
      const limit = maxGb * 1024 ** 3;
      for (const id of Object.keys(index)) if (!present(index[id])) delete index[id];
      let total = Object.values(index).reduce((a, e) => a + e.size, 0);
      for (const [id, e] of Object.entries(index).sort(([, a], [, b]) => a.usedAt - b.usedAt)) {
        if (total <= limit) break;
        if (id === keepId) continue;
        fs.rmSync(pathFor(e.rel), { force: true });
        delete index[id];
        total -= e.size;
      }
      save();
    },
    sizeGb: () => Math.round((Object.values(index).reduce((a, e) => a + e.size, 0) / 1024 ** 3) * 10) / 10,
  };
}

module.exports = { createCache };
