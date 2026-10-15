/**
 * App-wide events, so the downloader can tell the pipeline about new files
 * without the two modules requiring each other.
 *
 *   'downloaded' (itemId)  a recording finished downloading
 *   'indexed'    (itemId)  an item's search chunks changed
 */
const { EventEmitter } = require('events');

module.exports = new EventEmitter();
