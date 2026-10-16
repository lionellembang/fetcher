/**
 * Server-rendered pages:
 *   renderDashboard  one table per class, one row per session, with each
 *                    stage's state (recording · cut · transcript)
 *   renderSession    player (original / cut) with the synced transcript
 *   renderSearch     hybrid search across every lecture
 */
const { origToCut, cutToOrig } = require('./timeline');
const { audioClass } = require('./media');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '');
const fmtSize = (n) => (n == null ? '' : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const fmtMin = (sec) => (sec == null ? '' : `${Math.round(sec / 60)} min`);
const filesHref = (base, rel) => `${base}/files/${String(rel).split(/[\\/]/).map(encodeURIComponent).join('/')}`;
const sessionHref = (base, sessionId) => `${base}/s/${encodeURIComponent(sessionId)}`;
/** JSON safe to drop inside <script>. */
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function clock(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const STYLE = `
  :root { --bg:#fff; --fg:#1c1c1e; --muted:#6b6b70; --line:#e3e3e6; --accent:#2457d6; --err:#c0392b; --ok:#1e7d4f; --warn:#a15c00; --tag:#eef1fb; --hl:#fff4c2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141416; --fg:#ececef; --muted:#9a9aa1; --line:#2c2c31; --accent:#7ea2ff; --err:#ff7b6b; --ok:#5fd39a; --warn:#f0b35a; --tag:#23283a; --hl:#3a3420; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,sans-serif; }
  main { max-width:64rem; margin:0 auto; padding:24px 16px 64px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
  h1 { font-size:1.4rem; margin:0; } h2 { font-size:1.05rem; margin:28px 0 8px; }
  a { color:var(--accent); } .muted { color:var(--muted); } .err { color:var(--err); } .ok { color:var(--ok); } .warn { color:var(--warn); }
  .tag { font-size:.75rem; background:var(--tag); padding:2px 6px; border-radius:4px; vertical-align:middle; }
  .scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; font-size:.85rem; color:var(--muted); }
  button, input[type=search] { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--tag); color:var(--fg); }
  button { cursor:pointer; } button[disabled] { opacity:.5; cursor:default; }
  input[type=search] { background:var(--bg); min-width:0; flex:1; }
  form.inline { display:inline; } .small { font-size:.8rem; padding:2px 8px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .status { font-size:.85rem; }
`;

function layout(title, body, { base } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>
${base ? `<form class="row" method="get" action="${base}/search" style="margin-bottom:16px"><a href="${base}">Lectures</a><input type="search" name="q" placeholder="Search all lectures…" aria-label="Search all lectures"><button>Search</button></form>` : ''}
${body}
</main></body></html>`;
}

// ---- stage cells ----

function stageCell(st, kind) {
  if (!st) return '<span class="muted">—</span>';
  const title = esc(st.error || '');
  switch (st.status) {
    case 'running':
      return `<span class="warn">${kind === 'cut' ? 'cutting…' : kind === 'transcribe' ? 'transcribing…' : `${kind}…`}</span>`;
    case 'pending':
      return `<span class="muted" title="${title}">${st.error ? 'waiting' : 'queued'}</span>`;
    case 'skipped':
      return `<span class="muted" title="${esc(st.meta.reason || '')}">skipped (${esc(st.meta.reason === 'no audio' ? 'no audio' : 'silent')})</span>`;
    case 'failed':
      return `<span class="err" title="${title}">failed</span>`;
    default:
      return null; // done: caller renders it
  }
}

function cutCell(base, st) {
  const c = stageCell(st, 'cut');
  if (c !== null) return c;
  return `<a href="${filesHref(base, st.output_path)}">Cut</a> <span class="muted">${st.meta.keptPct != null ? `${st.meta.keptPct}% kept` : ''}</span>`;
}

function transcriptCell(base, item, st) {
  const t = st.transcribe;
  const c = stageCell(t, 'transcribe');
  if (c !== null) return c;
  const idx = st.index;
  const idxNote = !idx ? '' : idx.status === 'failed' ? ` <span class="err" title="${esc(idx.error)}">search index failed</span>` : idx.status !== 'done' ? ' <span class="muted">indexing…</span>' : '';
  return `<a href="${sessionHref(base, item.session_id)}">Transcript</a> <span class="muted">${t.meta.segments ?? ''} lines</span>${idxNote}`;
}

function recCell(base, it, probe) {
  if (it.status === 'not_yet') return '<span class="muted">not yet</span>';
  const open = `<a href="${base}/recording/${encodeURIComponent(it.session_id)}" target="_blank" rel="noopener">SharePoint</a>`;
  if (it.status === 'downloaded') {
    const flag = probe && probe.status === 'done' && audioClass(probe.meta).quiet ? ' <span class="warn" title="very quiet recording">quiet</span>' : '';
    return `<a href="${filesHref(base, it.file_path)}">Recording</a> <span class="muted">${fmtSize(it.size)}${probe && probe.meta && probe.meta.duration ? ` · ${fmtMin(probe.meta.duration)}` : ''}</span>${flag} · ${open}`;
  }
  if (it.status === 'failed') return `${open} · <span class="err" title="${esc(it.error || '')}">download failed</span>`;
  return `${open} · <span class="muted">download pending</span>`;
}

function pipelineLine(pipe, whisperUp) {
  const tr = `Transcriber: ${whisperUp ? '<span class="ok">up</span>' : '<span class="err">down</span>'}`;
  if (!pipe) return `Pipeline: <span class="err">worker not running</span> (no scans or processing) · ${tr}`;
  const parts = Object.entries(pipe.lanes)
    .filter(([, l]) => l.running || l.queued)
    .map(([stage, l]) => `${stage}: ${l.running ? esc(l.running.label) : 'idle'}${l.queued ? ` (+${l.queued} queued)` : ''}${l.paused ? ' (paused)' : ''}`);
  return `Pipeline: ${parts.length ? parts.join(' · ') : 'idle'} · ${tr}`;
}

// ---- dashboard ----

function renderDashboard({ base, items, stages, lastScan, scanning, pipe, whisperUp }) {
  // period → class → session
  const classes = new Map();
  for (const it of items) {
    const key = `${it.period}|${it.class_id}`;
    if (!classes.has(key)) {
      classes.set(key, { period: it.period, title: `${it.course_code} — ${it.course_title}`, component: it.component, classCode: it.class_code, sessions: [] });
    }
    classes.get(key).sessions.push(it);
  }

  const tables = [...classes.values()]
    .map(
      (c) => `
    <section>
      <h2>${esc(c.title)} <span class="tag">${esc(c.component)}</span> <span class="muted">${esc(c.classCode)} · ${esc(c.period)}</span></h2>
      <div class="scroll"><table>
        <thead><tr><th>Session</th><th>Date</th><th>Recording</th><th>Cut</th><th>Transcript</th></tr></thead>
        <tbody>${c.sessions
          .sort((a, b) => a.session_number - b.session_number)
          .map((it) => {
            const st = stages[it.id] || {};
            const ready = it.status === 'downloaded';
            const n = ready ? `<a href="${sessionHref(base, it.session_id)}">${esc(it.session_number)}</a>` : esc(it.session_number);
            return `<tr><td>${n}</td><td>${esc(fmtDate(it.session_date))}</td><td>${recCell(base, it, st.probe)}</td>
              <td>${ready ? cutCell(base, st.cut) : ''}</td><td>${ready ? transcriptCell(base, it, st) : ''}</td></tr>`;
          })
          .join('')}</tbody>
      </table></div>
    </section>`
    )
    .join('');

  return layout(
    'Lectures',
    `<header>
    <div><h1>Lectures</h1>
      <div class="muted status">Last scan: ${esc(lastScan || 'never')}${scanning ? ' · <strong>scan running…</strong>' : ''}</div>
      <div class="muted status">${pipelineLine(pipe, whisperUp)}</div></div>
    <form method="post" action="${base}/scan"><button type="submit">Scan now</button></form>
  </header>
  ${tables || '<p class="muted">Nothing found yet — run a scan.</p>'}
  <p class="muted" style="margin-top:32px">New recordings are downloaded on each scan, then cut and transcribed. Hover a failed or waiting step to see why.</p>`,
    { base }
  );
}

// ---- session page ----

function renderSession({ base, item, stages, segments, spans }) {
  const st = stages;
  const cutRel = st.cut && st.cut.status === 'done' ? st.cut.output_path : null;
  const sources = {
    orig: { src: filesHref(base, item.file_path), vtt: `${base}/transcript/${encodeURIComponent(item.session_id)}.vtt?timeline=original` },
    cut: cutRel ? { src: filesHref(base, cutRel), vtt: `${base}/transcript/${encodeURIComponent(item.session_id)}.vtt?timeline=cut` } : null,
  };
  const dl = (fmt, tl) => `${base}/transcript/${encodeURIComponent(item.session_id)}.${fmt}?timeline=${tl}`;

  const stageRow = (name, label) => {
    const s = st[name];
    if (!s) return `<li>${label}: <span class="muted">not started</span></li>`;
    const why = s.error ? ` — <span class="${s.status === 'failed' ? 'err' : 'muted'}">${esc(s.error.split('\n')[0])}</span>` : s.meta.reason ? ` — ${esc(s.meta.reason)}` : '';
    const redo = ['done', 'failed', 'skipped'].includes(s.status)
      ? ` <form class="inline" method="post" action="${base}/retry/${encodeURIComponent(item.session_id)}/${name}"><button class="small">Redo</button></form>`
      : '';
    return `<li>${label}: ${esc(s.status)}${why}${redo}</li>`;
  };

  const lines = segments.length
    ? segments
        .map((s, i) => `<li data-i="${i}"><button class="ts small" data-s="${s.start}">${clock(s.start)}</button> ${esc(s.text)}</li>`)
        .join('')
    : `<li class="muted">${st.transcribe && st.transcribe.status === 'done' ? 'No speech found.' : 'No transcript yet.'}</li>`;

  return layout(
    `${item.course_code} S${item.session_number}`,
    `<header><div>
      <h1>${esc(item.course_code)} — ${esc(item.course_title)} <span class="tag">${esc(item.component)}</span></h1>
      <div class="muted">Session ${esc(item.session_number)} · ${esc(fmtDate(item.session_date))} · ${esc(item.period)}</div>
    </div></header>
  <style>
    main { max-width:80rem; }
    .watch { display:grid; gap:16px; margin-top:16px; }
    @media (min-width: 900px) { .watch { grid-template-columns:minmax(0,3fr) minmax(0,2fr); align-items:start; } #trbox { max-height:78vh; } }
    video { width:100%; max-height:70vh; background:#000; border-radius:6px; display:block; }
    #trbox { position:relative; max-height:50vh; overflow-y:auto; border:1px solid var(--line); border-radius:6px; }
    #tr { list-style:none; padding:4px; margin:0; }
    #tr li { padding:4px 6px; border-radius:4px; }
    #tr li.on { background:var(--hl); }
    .ts { margin-right:6px; font-variant-numeric:tabular-nums; }
    button.sel { outline:2px solid var(--accent); }
  </style>
  <div class="watch">
    <div>
      <video id="v" controls preload="metadata" playsinline></video>
      <div class="row" style="margin-top:8px">
        <button id="b-orig">Original</button>
        <button id="b-cut"${sources.cut ? '' : ' disabled title="No cut version yet"'}>Cut${st.cut && st.cut.meta.keptPct != null ? ` (${st.cut.meta.keptPct}%)` : ''}</button>
        <label class="muted"><input type="checkbox" id="follow" checked> follow transcript</label>
      </div>
      <p class="muted small">Transcript: <a href="${dl('srt', 'original')}">SRT</a> · <a href="${dl('vtt', 'original')}">VTT</a> · <a href="${dl('txt', 'original')}">TXT</a>
        ${sources.cut ? ` · for the cut: <a href="${dl('srt', 'cut')}">SRT</a> · <a href="${dl('vtt', 'cut')}">VTT</a>` : ''}</p>
    </div>
    <div id="trbox"><ol id="tr">${lines}</ol></div>
  </div>
  <h2>Processing</h2>
  <ul class="status">${stageRow('probe', 'Audio check')}${stageRow('cut', 'Cut')}${stageRow('transcribe', 'Transcript')}${stageRow('index', 'Search index')}</ul>
  <script>
  ${origToCut.toString()}
  ${cutToOrig.toString()}
  const SOURCES = ${scriptJson(sources)};
  const SPANS = ${scriptJson(spans || [])};
  const STARTS = ${scriptJson(segments.map((s) => s.start))};
  const v = document.getElementById('v');
  const box = document.getElementById('trbox');
  const items = document.querySelectorAll('#tr li[data-i]');
  // Scroll only the transcript box, never the page (the video stays in view).
  const reveal = (li, smooth) => box.scrollTo({ top: li.offsetTop - box.clientHeight / 2 + li.offsetHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  let mode = 'orig';
  const toOrig = (t) => (mode === 'cut' ? cutToOrig(SPANS, t) : t);
  const fromOrig = (t) => (mode === 'cut' ? origToCut(SPANS, t) : t);

  function load(m, at, play) {
    mode = m;
    const s = SOURCES[m];
    v.querySelectorAll('track').forEach((t) => t.remove());
    v.src = s.src;
    const tr = document.createElement('track');
    Object.assign(tr, { kind: 'subtitles', srclang: 'id', label: 'Transcript', src: s.vtt });
    v.appendChild(tr);
    v.addEventListener('loadedmetadata', () => { v.currentTime = at || 0; if (play) v.play().catch(() => {}); }, { once: true });
    document.getElementById('b-orig').classList.toggle('sel', m === 'orig');
    document.getElementById('b-cut').classList.toggle('sel', m === 'cut');
  }
  document.getElementById('b-orig').onclick = () => { if (mode !== 'orig') load('orig', toOrig(v.currentTime), !v.paused); };
  document.getElementById('b-cut').onclick = () => { if (mode !== 'cut' && SOURCES.cut) load('cut', origToCut(SPANS, toOrig(v.currentTime)), !v.paused); };

  document.getElementById('tr').addEventListener('click', (e) => {
    const b = e.target.closest('.ts');
    if (!b) return;
    v.currentTime = fromOrig(Number(b.dataset.s));
    v.play().catch(() => {});
  });

  let on = -1;
  let seeked = false; // follow a seek even while paused
  v.addEventListener('seeking', () => (seeked = true));
  v.addEventListener('timeupdate', () => {
    const t = toOrig(v.currentTime);
    let lo = 0, hi = STARTS.length - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (STARTS[mid] <= t + 0.05) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i === on && !seeked) return;
    if (on >= 0) items[on].classList.remove('on');
    on = i;
    if (i >= 0) {
      items[i].classList.add('on');
      if (document.getElementById('follow').checked && (!v.paused || seeked)) reveal(items[i], !seeked);
    }
    seeked = false;
  });

  // Deep link: ?v=orig|cut&t=<seconds on that video's timeline>
  const q = new URLSearchParams(location.search);
  const want = q.get('v') === 'cut' && SOURCES.cut ? 'cut' : 'orig';
  const t = Number(q.get('t')) || 0;
  load(want, t, q.has('t'));
  if (q.has('t')) {
    const ot = want === 'cut' ? cutToOrig(SPANS, t) : t;
    let i = STARTS.findIndex((s, k) => s <= ot + 0.05 && (k + 1 === STARTS.length || STARTS[k + 1] > ot + 0.05));
    if (i >= 0) reveal(items[i], false);
  }
  </script>`,
    { base }
  );
}

// ---- search page ----

function highlight(text, words) {
  let out = esc(text);
  for (const w of words) {
    if (w.length < 2) continue;
    out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  }
  return out;
}

function renderSearch({ base, q, course, result }) {
  const body = !q
    ? '<p class="muted">Type what you want to find. English or Indonesian both work; it matches meaning, not just exact words.</p>'
    : !result.hits.length
      ? '<p>No matches.</p>'
      : `<ol style="padding-left:20px">${result.hits
          .map((h) => {
            const cls = h.match === 'strong' ? 'ok' : h.match === 'possible' ? 'warn' : 'muted';
            const href = `${sessionHref(base, h.sessionId)}?t=${Math.floor(h.at.original)}`;
            const cutHref = h.at.cut != null ? `${sessionHref(base, h.sessionId)}?v=cut&t=${Math.floor(h.at.cut)}` : null;
            return `<li style="margin-bottom:14px">
              <div><a href="${href}"><strong>${esc(h.course)}</strong> · Session ${esc(h.sessionNumber)} · ${clock(h.at.original)}</a>
                ${cutHref ? ` <a class="muted" href="${cutHref}">(in cut: ${clock(h.at.cut)})</a>` : ''}
                <span class="tag ${cls}">${esc(h.match)}</span> <span class="muted small">${esc(h.date || '')}</span></div>
              <div class="muted">${highlight(h.excerpt, h.keywords)}</div></li>`;
          })
          .join('')}</ol>`;
  const cov = result && result.coverage;
  const covLine = cov
    ? `<p class="muted small">${cov.searchable} lecture(s) searchable${cov.processing ? `, ${cov.processing} still processing` : ''}${cov.no_recording_yet ? `, ${cov.no_recording_yet} without a recording yet` : ''}${cov.no_audio ? `, ${cov.no_audio} with no audio` : ''}.</p>`
    : '';
  return layout(
    q ? `Search: ${q}` : 'Search',
    `<h1>Search lectures</h1>
  <form class="row" method="get" action="${base}/search" style="margin:12px 0">
    <input type="search" name="q" value="${esc(q || '')}" placeholder="e.g. difference between precision and recall" autofocus>
    <input type="search" name="course" value="${esc(course || '')}" placeholder="course (optional)" style="flex:0 1 12rem">
    <button>Search</button>
  </form>
  ${result && result.degraded ? `<p class="warn small">${esc(result.degraded)}</p>` : ''}
  ${covLine}
  ${body}`,
    { base }
  );
}

module.exports = { renderDashboard, renderSession, renderSearch };
