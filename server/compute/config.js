/**
 * The compute node's config: the settings both machines share
 * (shared/env.js) plus the link to the hub and the cache of originals.
 * Cut and transcribe settings are not here: every job brings the hub's.
 */
const fs = require('fs');
const os = require('os');
const { config: shared, num, list, repoPath } = require('../shared/env');

const config = {
  ...shared,

  // The hub's node API on the LAN, e.g. http://192.168.1.20:3102
  hubUrl: String(process.env.HUB_URL || '').trim().replace(/\/+$/, ''),
  // Shared secret with the hub (its NODE_TOKEN).
  nodeToken: process.env.NODE_TOKEN || '',
  nodeId: process.env.NODE_ID || os.hostname(),
  nodeStages: list(process.env.NODE_STAGES || 'cut,transcribe'),
  // Originals kept here (least recently used go first), so cut and
  // transcribe of the same lecture download it once.
  nodeCacheDir: repoPath(process.env.NODE_CACHE_DIR, './data/node-cache'),
  nodeCacheGb: num(process.env.NODE_CACHE_GB, 20),
};

config.ensureDirs = function ensureDirs() {
  shared.ensureDirs();
  fs.mkdirSync(config.nodeCacheDir, { recursive: true });
};

module.exports = config;
