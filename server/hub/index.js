/**
 * Everything in one process (worker + web), for running without
 * scripts/fetcher. Normally the two run separately so either can be restarted
 * on its own: `scripts/fetcher start` (see the README).
 */
require('./worker');
require('./web');
