/**
 * App-wide events, so the downloader can tell the pipeline about new files
 * without the two modules requiring each other.
 *
 *   'downloaded' (itemId)  a recording finished downloading
 *
 * In-process only (the worker). Changes the web process must notice go
 * through the database, e.g. meta 'chunks_version' for search.
 */
const { EventEmitter } = require('events');

module.exports = new EventEmitter();
