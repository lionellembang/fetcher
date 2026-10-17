/**
 * Express app of the web process (web.js). Everything except /healthz lives
 * under the secret ACCESS_TOKEN path segment; any other token 404s. Scans,
 * retries and SharePoint links are forwarded to the worker (control.js).
 *
 * Every response is Cache-Control: private, so Cloudflare never caches it. On
 * a cache miss Cloudflare fetched a whole recording (100-700 MB) through the
 * tunnel before answering even a small range request, so playback waited
 * minutes for the 23 KB at the end of the file that Chrome reads first.
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
 *
 * With COMPUTE=remote a second listener on NODE_HOST:NODE_PORT (the LAN, not
 * the tunnel) serves the compute node's /node API (nodeApi.js) and nothing else.
 */
const express = require('express');
const config = require('./config');
const store = require('./store');
const control = require('./control');
const whisper = require('../shared/whisper');
const embed = require('./embed');
const transcripts = require('./transcripts');
const remote = require('./remote');
const nodeApi = require('./nodeApi');
const { renderDashboard, renderSession, renderSearch } = require('./page');
const { handleMcp } = require('./mcp');

const itemId = (sessionId) => `recording:${sessionId}`;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const wantsHtml = (req) => (req.get('accept') || '').includes('text/html');
// Browsers may keep a copy but must revalidate (ETag); shared caches (Cloudflare) must not store it.
const PRIVATE = 'private, no-cache';

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

  app.get(
    '/healthz',
    wrap(async (req, res) => {
      const w = await control.status();
      res.set('cache-control', 'no-store').json({
        ok: true,
        worker: w ? 'up' : 'down',
        lastScan: store.getMeta('last_scan'),
        scanning: w ? w.scanning : null,
        counts: store.counts(),
      });
    })
  );

  const d = express.Router({ mergeParams: true });
  d.use((req, res, next) => {
    res.set('cache-control', PRIVATE);
    if (!config.accessToken || req.params.token !== config.accessToken) return res.status(404).send('Not found');
    next();
  });

  d.get(
    '/',
    wrap(async (req, res) => {
      const isRemote = config.compute === 'remote';
      const [w, whisperUp, searchUp] = await Promise.all([
        control.status(),
        isRemote ? false : whisper.health().then(Boolean),
        isRemote ? embed.health().then(Boolean) : false,
      ]);
      const node = isRemote ? remote.nodeState() : null;
      const stages = store.stagesByItem();
      if (isRemote) remote.annotateStages(stages, node);
      res.type('html').send(
        renderDashboard({
          base: req.baseUrl,
          items: store.listItems({ kind: 'recording' }),
          stages,
          lastScan: store.getMeta('last_scan'),
          scanning: w ? w.scanning : false,
          pipe: w ? w.pipeline : null,
          whisperUp,
          node,
          searchUp,
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

  const workerError = (res, err) => res.status(err instanceof control.WorkerDownError ? 503 : err.status || 502).send(err.message);

  d.post('/scan', async (req, res) => {
    let r;
    try {
      r = await control.scan();
    } catch (err) {
      return workerError(res, err);
    }
    if (wantsHtml(req)) return res.redirect(303, req.baseUrl);
    res.status(202).json(r);
  });

  d.post('/retry/:sessionId/:stage', async (req, res) => {
    let r;
    try {
      r = await control.retry(itemId(req.params.sessionId), req.params.stage);
    } catch (err) {
      return workerError(res, err);
    }
    if (wantsHtml(req)) return res.redirect(303, `${req.baseUrl}/s/${encodeURIComponent(req.params.sessionId)}`);
    res.status(202).json(r);
  });

  d.get('/recording/:sessionId', async (req, res) => {
    try {
      res.redirect(302, (await control.recordingLink(req.params.sessionId)).url);
    } catch (err) {
      workerError(res, err);
    }
  });

  // Range requests (seeking) are handled by express.static; caching headers are ours.
  d.use(
    '/files',
    express.static(config.downloadDir, {
      dotfiles: 'deny',
      index: false,
      cacheControl: false,
      setHeaders: (res) => res.set('cache-control', PRIVATE),
    })
  );

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
      const isRemote = config.compute === 'remote';
      const [w, transcriber, embedder] = await Promise.all([control.status(), isRemote ? null : whisper.health(), embed.health()]);
      res.json({
        lastScan: store.getMeta('last_scan'),
        worker: w ? 'up' : 'down',
        scanning: w ? w.scanning : null,
        counts: store.counts(),
        pipeline: w ? w.pipeline : null,
        compute: config.compute,
        ...(isRemote ? { computeNode: remote.status() } : { transcriber }),
        embed: embedder,
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
  const server = app.listen(config.port, config.host, () => {
    console.log(`→ Server on http://${config.host}:${config.port}`);
    console.log(`  dashboard: ${config.publicUrl}/d/${config.accessToken}`);
    console.log(`  MCP:       ${config.publicUrl}/d/${config.accessToken}/mcp`);
  });
  if (config.compute === 'remote') {
    if (nodeApi.enabled()) {
      nodeApi.listen(config.nodePort, config.nodeHost, () =>
        console.log(`→ Compute node API on http://${config.nodeHost}:${config.nodePort}/node (LAN only)`)
      );
    } else {
      console.warn('⚠ COMPUTE=remote but NODE_TOKEN is unset or shorter than 32 characters: the compute node API is off.');
    }
  }
  return server;
}

module.exports = { createApp, startServer };
