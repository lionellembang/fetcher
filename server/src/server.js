/**
 * Express app. Everything except /healthz lives under the secret ACCESS_TOKEN
 * path segment; any other token 404s.
 *
 *   GET  /healthz                                → { ok, lastScan, scanning, counts }
 *   GET  /d/<token>                              → HTML dashboard
 *   GET  /d/<token>/s/<sessionId>[?v=cut&t=sec]  → player + synced transcript
 *   GET  /d/<token>/search?q=&course=            → search page
 *   GET  /d/<token>/transcript/<sessionId>.<srt|vtt|txt>[?timeline=original|cut]
 *   POST /d/<token>/scan                         → start a scan now (202)
 *   POST /d/<token>/retry/<sessionId>/<stage>    → redo a pipeline stage
 *   GET  /d/<token>/recording/<sessionId>        → redirect to a fresh SharePoint link
 *   GET  /d/<token>/files/<path>                 → downloaded / cut recordings
 *   GET  /d/<token>/api/{items,sessions,status,search,transcript/<sessionId>}
 *   POST /d/<token>/mcp                          → MCP (Streamable HTTP, stateless)
 */
const express = require('express');
const config = require('./config');
const store = require('./store');
const lms = require('./lms');
const pipeline = require('./pipeline');
const whisper = require('./whisper');
const transcripts = require('./transcripts');
const { runScan, isScanning } = require('./scan');
const { renderDashboard, renderSession, renderSearch } = require('./page');
const { handleMcp } = require('./mcp');

const itemId = (sessionId) => `recording:${sessionId}`;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const wantsHtml = (req) => (req.get('accept') || '').includes('text/html');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Log MCP traffic (and OAuth discovery probes clients make first) so connection
  // problems are visible: method, JSON-RPC method, status, time, client. A wrong
  // token shows as <wrong-token>; the real one is never logged.
  app.use((req, res, next) => {
    if (!/\/mcp\/?$|^\/\.well-known\//.test(req.path)) return next();
    const t0 = Date.now();
    // read the path now: routers rewrite req.path while handling the request
    const where = req.path.replace(/^\/d\/([^/]+)/, (_, t) => (t === config.accessToken ? '/d/<token>' : '/d/<wrong-token>'));
    res.on('finish', () => {
      const rpc = req.body && req.body.method ? ` ${req.body.method}` : '';
      const ua = (req.get('user-agent') || '-').slice(0, 80);
      console.log(`MCP ${req.method} ${where}${rpc} → ${res.statusCode} (${Date.now() - t0} ms) ua="${ua}"`);
    });
    next();
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, lastScan: store.getMeta('last_scan'), scanning: isScanning(), counts: store.counts() });
  });

  const d = express.Router({ mergeParams: true });
  d.use((req, res, next) => {
    if (!config.accessToken || req.params.token !== config.accessToken) return res.status(404).send('Not found');
    next();
  });

  d.get(
    '/',
    wrap(async (req, res) => {
      res.type('html').send(
        renderDashboard({
          base: req.baseUrl,
          items: store.listItems({ kind: 'recording' }),
          stages: store.stagesByItem(),
          lastScan: store.getMeta('last_scan'),
          scanning: isScanning(),
          pipe: pipeline.status(),
          whisperUp: !!(await whisper.health()),
        })
      );
    })
  );

  d.get('/s/:sessionId', (req, res) => {
    const item = store.getItem(itemId(req.params.sessionId));
    if (!item || item.status !== 'downloaded') return res.status(404).send('No downloaded recording for this session.');
    res.type('html').send(
      renderSession({
        base: req.baseUrl,
        item,
        stages: store.getStages(item.id),
        segments: store.getSegments(item.id),
        spans: transcripts.spansFor(item.id),
      })
    );
  });

  d.get(
    '/search',
    wrap(async (req, res) => {
      const q = String(req.query.q || '').trim();
      const course = String(req.query.course || '').trim();
      const result = q ? await transcripts.search(q, { course, limit: 20 }) : null;
      res.type('html').send(renderSearch({ base: req.baseUrl, q, course, result }));
    })
  );

  d.get('/transcript/:sessionId.:fmt', (req, res) => {
    const { sessionId, fmt } = req.params;
    if (!['srt', 'vtt', 'txt'].includes(fmt)) return res.status(400).send('format must be srt, vtt or txt');
    const item = store.getItem(itemId(sessionId));
    if (!item || !store.getTranscript(item.id)) return res.status(404).send('No transcript for this session (yet).');
    const timeline = req.query.timeline === 'cut' ? 'cut' : 'original';
    let segs;
    try {
      segs = transcripts.segmentsOn(item.id, timeline);
    } catch (err) {
      return res.status(404).send(err.message);
    }
    const name = `${item.course_code} ${item.component} S${String(item.session_number).padStart(2, '0')}${timeline === 'cut' ? ' cutted' : ''}.${fmt}`;
    const type = { srt: 'application/x-subrip', vtt: 'text/vtt', txt: 'text/plain' }[fmt];
    if (fmt !== 'vtt') res.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.type(type).send(transcripts.render(segs, fmt));
  });

  d.post('/scan', (req, res) => {
    const already = isScanning();
    runScan().catch((err) => console.error('✗ scan failed:', err.message));
    if (wantsHtml(req)) return res.redirect(303, req.baseUrl);
    res.status(202).json({ started: !already, scanning: true });
  });

  d.post('/retry/:sessionId/:stage', (req, res) => {
    let result;
    try {
      result = pipeline.retry(itemId(req.params.sessionId), req.params.stage);
    } catch (err) {
      return res.status(400).send(err.message);
    }
    if (wantsHtml(req)) return res.redirect(303, `${req.baseUrl}/s/${encodeURIComponent(req.params.sessionId)}`);
    res.status(202).json({ result });
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

  // ---- JSON API ----

  d.get('/api/items', (req, res) => {
    const { kind, status, period } = req.query;
    res.json(store.listItems({ kind, status, period }));
  });

  d.get('/api/sessions', (req, res) => {
    const stages = store.stagesByItem();
    res.json(
      store
        .listItems({ kind: 'recording', period: req.query.period })
        .filter((it) => transcripts.courseMatches(it, req.query.course))
        .map((it) => ({ ...it, state: transcripts.sessionState(it, stages[it.id]), stages: stages[it.id] || {} }))
    );
  });

  d.get(
    '/api/status',
    wrap(async (req, res) => {
      res.json({
        lastScan: store.getMeta('last_scan'),
        scanning: isScanning(),
        counts: store.counts(),
        pipeline: pipeline.status(),
        transcriber: await whisper.health(),
        coverage: transcripts.coverage(),
      });
    })
  );

  d.get(
    '/api/search',
    wrap(async (req, res) => {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'q is required' });
      res.json(await transcripts.search(q, { course: req.query.course, period: req.query.period, limit: Number(req.query.limit) || 8 }));
    })
  );

  d.get('/api/transcript/:sessionId', (req, res) => {
    const item = store.getItem(itemId(req.params.sessionId));
    if (!item || !store.getTranscript(item.id)) return res.status(404).json({ error: 'no transcript' });
    try {
      res.json({ item, segments: transcripts.segmentsOn(item.id, req.query.timeline === 'cut' ? 'cut' : 'original') });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ---- MCP ----

  d.post('/mcp', express.json({ limit: '1mb' }), wrap(handleMcp));
  d.all('/mcp', (req, res) => res.status(405).set('allow', 'POST').json({ error: 'stateless MCP endpoint: POST only' }));

  app.use('/d/:token', d);

  app.get('/', (req, res) =>
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>fetcher</title><p>fetcher is running.</p>')
  );

  app.use((err, req, res, next) => {
    console.error(`✗ ${req.method} ${req.path.replace(config.accessToken, '<token>')}: ${err.stack || err}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

function startServer() {
  const app = createApp();
  return app.listen(config.port, config.host, () => {
    console.log(`→ Server on http://${config.host}:${config.port}`);
    console.log(`  dashboard: ${config.publicUrl}/d/${config.accessToken}`);
    console.log(`  MCP:       ${config.publicUrl}/d/${config.accessToken}/mcp`);
  });
}

module.exports = { createApp, startServer };
