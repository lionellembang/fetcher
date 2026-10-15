/**
 * Express app. Everything except /healthz lives under the secret ACCESS_TOKEN
 * path segment; any other token 404s.
 *
 *   GET  /healthz                         → { ok, lastScan, scanning, counts }
 *   GET  /d/<token>                       → HTML dashboard
 *   GET  /d/<token>/api/items             → JSON list (?kind=&status=&period=)
 *   POST /d/<token>/scan                  → start a scan now (202)
 *   GET  /d/<token>/recording/<sessionId> → redirect to a fresh recording link
 *   GET  /d/<token>/files/<path>          → a downloaded recording
 */
const express = require('express');
const config = require('./config');
const store = require('./store');
const lms = require('./lms');
const { runScan, isScanning } = require('./scan');
const { renderDashboard } = require('./page');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, lastScan: store.getMeta('last_scan'), scanning: isScanning(), counts: store.counts() });
  });

  const d = express.Router({ mergeParams: true });
  d.use((req, res, next) => {
    if (!config.accessToken || req.params.token !== config.accessToken) return res.status(404).send('Not found');
    next();
  });

  d.get('/', (req, res) => {
    res.type('html').send(
      renderDashboard({
        base: req.baseUrl,
        items: store.listItems(),
        lastScan: store.getMeta('last_scan'),
        scanning: isScanning(),
      })
    );
  });

  d.get('/api/items', (req, res) => {
    const { kind, status, period } = req.query;
    res.json(store.listItems({ kind, status, period }));
  });

  d.post('/scan', (req, res) => {
    const already = isScanning();
    runScan().catch((err) => console.error('✗ scan failed:', err.message));
    if ((req.get('accept') || '').includes('text/html')) return res.redirect(303, req.baseUrl);
    res.status(202).json({ started: !already, scanning: true });
  });

  d.get('/recording/:sessionId', async (req, res) => {
    try {
      const rec = await lms.zoomRecording(req.params.sessionId);
      if (!rec || !rec.recordingUrl) return res.status(404).send('No recording for this session (yet).');
      res.redirect(302, rec.recordingUrl);
    } catch (err) {
      res.status(502).send(`Could not get the recording link: ${err.message}`);
    }
  });

  d.use('/files', express.static(config.downloadDir, { dotfiles: 'deny', index: false }));

  app.use('/d/:token', d);

  app.get('/', (req, res) =>
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>downloadrecord</title><p>downloadrecord is running.</p>')
  );

  return app;
}

function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`→ Server on http://localhost:${config.port}`);
    console.log(`  dashboard: http://localhost:${config.port}/d/${config.accessToken}`);
  });
}

module.exports = { createApp, startServer };
