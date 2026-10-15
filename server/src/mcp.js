/**
 * MCP server (Streamable HTTP, stateless: a fresh server + transport per
 * request) mounted at /d/<ACCESS_TOKEN>/mcp.
 *
 * Built for studying: "was <topic> covered in a lecture, and where?" The main
 * tool is find_in_lectures (hybrid search with timestamps and video links);
 * get_transcript_context lets the model check a hit before answering.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod');
const store = require('./store');
const pipeline = require('./pipeline');
const whisper = require('./whisper');
const transcripts = require('./transcripts');
const { cutToOrig } = require('./timeline');
const { runScan, isScanning } = require('./scan');

const MAX_TEXT = 60000; // characters per get_transcript reply

const INSTRUCTIONS = `Lecture recordings of the user's BINUS university classes, transcribed with Whisper.
Transcripts are mostly Indonesian with English technical terms, and contain speech-recognition errors.

Typical use: the user is studying and asks whether/where a topic came up in lectures.
1. Call find_in_lectures with the topic. Try a second phrasing too (the Indonesian term, the English term, or a key phrase) if the first results are weak.
2. Before answering, read the top hit(s) with get_transcript_context to check the lecturer actually explains the topic there (not just a passing mention).
3. Answer with the course, session number, the timestamp (m:ss) and the video link from the result, plus a short summary of what was said.
4. If no hit is really about the topic (only "weak" matches, or the context shows it's unrelated), say plainly that the recordings don't seem to cover it. Never present a weak match as the answer. Mention coverage.processing / no_recording_yet if some lectures aren't searchable yet.`;

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
const itemFor = (sessionId) => store.getItem(`recording:${sessionId}`);

function sessionRow(it, st = {}) {
  const pick = (s) => s && { status: s.status, ...(s.error ? { error: s.error.split('\n')[0] } : {}) };
  return {
    session_id: it.session_id,
    course: `${it.course_code} ${it.course_title} (${it.component})`,
    session_number: it.session_number,
    date: it.session_date ? String(it.session_date).slice(0, 10) : null,
    state: transcripts.sessionState(it, st),
    duration_min: st.probe && st.probe.meta.duration ? Math.round(st.probe.meta.duration / 60) : null,
    cut_kept_pct: st.cut && st.cut.status === 'done' ? st.cut.meta.keptPct : null,
    stages: { cut: pick(st.cut), transcribe: pick(st.transcribe), index: pick(st.index) },
    link: it.status === 'downloaded' ? transcripts.links(it, 0, null).original.replace(/\?t=0$/, '') : null,
  };
}

function buildServer() {
  const server = new McpServer({ name: 'fetcher-lectures', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'find_in_lectures',
    {
      title: 'Find a topic in lecture recordings',
      description:
        'Search every transcribed lecture for where a topic, concept or question was discussed. Matches meaning (works across English/Indonesian) and keywords. ' +
        'Returns ranked passages with course, session, timestamp (at.originalClock), a match label (strong/possible/weak), an excerpt, and links that open the video at that moment ' +
        '(links.original; links.cut for the silence-cut version). "weak" means probably not about the topic. ' +
        'coverage says how many lectures are searchable vs. still processing. Check promising hits with get_transcript_context before answering.',
      inputSchema: {
        query: z.string().min(2).describe('What to look for, in natural language or keywords, English or Indonesian'),
        course: z.string().optional().describe('Limit to a course: part of its code or title, e.g. "COMP6798" or "data mining"'),
        period: z.string().optional().describe('Academic period code, e.g. "2610"'),
        limit: z.number().int().min(1).max(25).optional().describe('Max passages (default 8)'),
      },
      annotations: ro,
    },
    async ({ query, course, period, limit }) => {
      const r = await transcripts.search(query, { course, period, limit: limit || 8 });
      return text({
        query,
        degraded: r.degraded || undefined,
        coverage: r.coverage,
        hits: r.hits.map((h) => ({
          session_id: h.sessionId,
          course: h.course,
          session_number: h.sessionNumber,
          date: h.date,
          match: h.match,
          at: h.at,
          passage: { start: h.start, end: h.end },
          cut_passage: h.cut || undefined,
          excerpt: h.excerpt,
          keywords: h.keywords.length ? h.keywords : undefined,
          z: h.z,
          links: h.links,
        })),
      });
    }
  );

  server.registerTool(
    'get_transcript_context',
    {
      title: 'Read the transcript around a moment',
      description:
        'The timestamped transcript around a point in a lecture (e.g. a find_in_lectures hit), to check what was actually said. ' +
        'Times are seconds on the original recording unless timeline is "cut".',
      inputSchema: {
        session_id: z.string().describe('session_id from find_in_lectures or list_sessions'),
        at_sec: z.number().min(0).describe('Moment of interest, in seconds'),
        radius_sec: z.number().min(10).max(900).optional().describe('Seconds before and after to include (default 90)'),
        timeline: z.enum(['original', 'cut']).optional().describe('Which video the times refer to (default original)'),
      },
      annotations: ro,
    },
    async ({ session_id, at_sec, radius_sec, timeline }) => {
      const it = itemFor(session_id);
      if (!it || !store.getTranscript(it.id)) return fail(`No transcript for session ${session_id}.`);
      const r = radius_sec || 90;
      let segs;
      try {
        segs = transcripts.segmentsOn(it.id, timeline || 'original', { from: at_sec - r, to: at_sec + r });
      } catch (err) {
        return fail(err.message);
      }
      const spans = transcripts.spansFor(it.id);
      const origAt = timeline === 'cut' && spans ? cutToOrig(spans, at_sec) : at_sec;
      return text(
        `${it.course_code} ${it.course_title} (${it.component}) — session ${it.session_number}, ${String(it.session_date || '').slice(0, 10)}\n` +
          `Window: ${transcripts.shortClock(Math.max(0, at_sec - r))}–${transcripts.shortClock(at_sec + r)} (${timeline || 'original'} timeline)\n` +
          `Video at ${transcripts.shortClock(origAt)}: ${transcripts.links(it, origAt, spans).original}\n\n` +
          (segs.length ? transcripts.render(segs, 'timestamped') : '(no speech in this window)')
      );
    }
  );

  server.registerTool(
    'get_transcript',
    {
      title: 'Get a lecture transcript',
      description:
        'Transcript of one lecture, whole or a time range. Long lectures are large: prefer a range (start_sec/end_sec) or get_transcript_context. ' +
        'format "timestamped" (default) prefixes each line with m:ss; "text" is plain; "srt" is subtitles; "segments" is JSON.',
      inputSchema: {
        session_id: z.string(),
        format: z.enum(['timestamped', 'text', 'srt', 'segments']).optional(),
        start_sec: z.number().min(0).optional(),
        end_sec: z.number().min(0).optional(),
        timeline: z.enum(['original', 'cut']).optional().describe('Timestamps for the original recording (default) or the silence-cut video'),
      },
      annotations: ro,
    },
    async ({ session_id, format, start_sec, end_sec, timeline }) => {
      const it = itemFor(session_id);
      if (!it || !store.getTranscript(it.id)) return fail(`No transcript for session ${session_id}.`);
      let segs;
      try {
        segs = transcripts.segmentsOn(it.id, timeline || 'original', { from: start_sec, to: end_sec });
      } catch (err) {
        return fail(err.message);
      }
      const fmt = format || 'timestamped';
      const renderAll = (list) =>
        fmt === 'segments'
          ? JSON.stringify(list.map(({ start, end, text: t }) => ({ start, end, text: t })))
          : transcripts.render(list, fmt === 'text' ? 'txt' : fmt);
      // Keep whole segments up to MAX_TEXT and say where to continue.
      let used = 0;
      let n = 0;
      while (n < segs.length && (used += segs[n].text.length + 40) <= MAX_TEXT) n++;
      let out = renderAll(segs.slice(0, n));
      if (n < segs.length) out += `\n…[truncated; continue with start_sec=${Math.floor(segs[n].start)}]`;
      return text(`${it.course_code} ${it.course_title} (${it.component}) — session ${it.session_number}\n\n${out}`);
    }
  );

  server.registerTool(
    'list_courses',
    {
      title: 'List courses',
      description: 'Courses (classes) with how many sessions have recordings and how many are transcribed/searchable.',
      inputSchema: { period: z.string().optional().describe('Academic period code, e.g. "2610"') },
      annotations: ro,
    },
    async ({ period }) => {
      const stages = store.stagesByItem();
      const byClass = new Map();
      for (const it of store.listItems({ kind: 'recording', period })) {
        const k = `${it.period}|${it.class_id}`;
        const c =
          byClass.get(k) ||
          byClass
            .set(k, { course_code: it.course_code, title: it.course_title, component: it.component, class_code: it.class_code, period: it.period, sessions: 0, searchable: 0, processing: 0, no_recording_yet: 0 })
            .get(k);
        c.sessions++;
        const s = transcripts.sessionState(it, stages[it.id]);
        if (s in c) c[s]++;
      }
      return text([...byClass.values()]);
    }
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List lecture sessions',
      description: 'Sessions with a (possible) recording, with date, processing state and a link to the player. state is one of searchable, processing, no_recording_yet, not_downloaded, no_audio, failed.',
      inputSchema: {
        course: z.string().optional().describe('Part of a course code or title'),
        period: z.string().optional(),
        state: z.enum(['searchable', 'processing', 'no_recording_yet', 'not_downloaded', 'no_audio', 'failed']).optional(),
      },
      annotations: ro,
    },
    async ({ course, period, state }) => {
      const stages = store.stagesByItem();
      const rows = store
        .listItems({ kind: 'recording', period })
        .filter((it) => transcripts.courseMatches(it, course))
        .map((it) => sessionRow(it, stages[it.id]))
        .filter((r) => !state || r.state === state);
      return text(rows);
    }
  );

  server.registerTool(
    'pipeline_status',
    {
      title: 'Pipeline status',
      description: 'Last LMS scan, what the download/cut/transcribe pipeline is doing, whether the transcriber is up, and recent failures.',
      inputSchema: {},
      annotations: ro,
    },
    async () => {
      const stages = store.stagesByItem();
      const failures = [];
      for (const it of store.listItems({ kind: 'recording' })) {
        if (it.status === 'failed') failures.push({ session_id: it.session_id, course: it.course_code, session: it.session_number, stage: 'download', error: it.error });
        for (const [name, s] of Object.entries(stages[it.id] || {})) {
          if (s.status === 'failed') failures.push({ session_id: it.session_id, course: it.course_code, session: it.session_number, stage: name, error: (s.error || '').split('\n')[0] });
        }
      }
      return text({
        last_scan: store.getMeta('last_scan'),
        scanning: isScanning(),
        transcriber: await whisper.health(),
        pipeline: pipeline.status(),
        coverage: transcripts.coverage(),
        failures: failures.slice(0, 30),
      });
    }
  );

  server.registerTool(
    'trigger_scan',
    {
      title: 'Scan the LMS now',
      description: 'Look for new recordings now (normally every few hours), download them and queue them for cutting and transcription. Returns immediately.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const already = isScanning();
      runScan().catch((err) => console.error('✗ scan failed:', err.message));
      return text({ started: !already, scanning: true });
    }
  );

  server.registerTool(
    'retry_stage',
    {
      title: 'Redo a processing step',
      description: 'Redo one processing step for a session (and the steps after it): probe (audio check), cut, transcribe, or index (search).',
      inputSchema: { session_id: z.string(), stage: z.enum(['probe', 'cut', 'transcribe', 'index']) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, stage }) => {
      try {
        return text({ result: pipeline.retry(`recording:${session_id}`, stage) });
      } catch (err) {
        return fail(err.message);
      }
    }
  );

  return server;
}

/** Express handler for POST /mcp. */
async function handleMcp(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

module.exports = { handleMcp, buildServer };
