/**
 * Server-rendered pages:
 *   renderDashboard  bento grid: search, progress and system tiles, then one
 *                    card per course with a tile per session (its state)
 *   renderSession    player (original / cut) with the synced transcript
 *   renderSearch     hybrid search across every lecture
 */
const { origToCut, cutToOrig } = require('./timeline');
const { audioClass } = require('./media');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '');
const fmtSize = (n) => (n == null ? '' : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
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

function layout(title, body, { base, search = true } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>
${base && search ? `<form class="row" method="get" action="${base}/search" style="margin-bottom:16px"><a href="${base}">Lectures</a><input type="search" name="q" placeholder="Search all lectures…" aria-label="Search all lectures"><button>Search</button></form>` : ''}
${body}
</main></body></html>`;
}

// ---- dashboard (bento) ----

const TZ = process.env.TZ || 'Asia/Jakarta';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "16 Sep" (en-GB's short month is "Sept", too wide for a session tile). */
function fmtDay(iso) {
  if (!iso) return '';
  const [d, m] = new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'numeric', timeZone: TZ }).split('/');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}
const fmtLongDay = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '';
const fmtHours = (sec) => {
  if (sec == null) return '';
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const VERB = { probe: 'checking audio', cut: 'cutting', transcribe: 'transcribing', index: 'indexing' };

/** "upload 42%" from a compute node's heartbeat progress. */
const fmtProgress = (p) => (p ? [p.phase, p.pct != null ? `${Math.round(p.pct)}%` : ''].filter(Boolean).join(' ') : '');

/**
 * Tile state for a stage waiting on the compute node (row.remote, see
 * remote.annotateStages), or null.
 */
function remoteTile(stage, s, href) {
  const r = s && s.remote;
  if (!r) return null;
  if (r.state === 'leased') return { kind: 'busy', label: `${VERB[stage]} on PC…`, detail: fmtProgress(r.progress), href };
  if (r.state === 'waiting') return { kind: 'queued', label: 'waiting for PC', detail: 'Cutting and transcribing run on the compute PC, which is offline.', href };
  return { kind: 'queued', label: 'queued for PC', detail: 'Queued for the compute PC.', href };
}

/**
 * What a session tile shows: { kind, label, detail, href }.
 * kind: ready | busy | queued | silent | soon | failed | fetching
 */
function tileState(base, it, st = {}) {
  const sp = `${base}/recording/${encodeURIComponent(it.session_id)}`;
  if (it.status === 'not_yet') return { kind: 'soon', label: 'not yet', detail: 'No recording yet (they appear a few days after class).' };
  if (it.status === 'failed') return { kind: 'failed', label: 'download failed', detail: it.error || '', href: sp };
  if (it.status !== 'downloaded') return { kind: 'fetching', label: 'downloading', detail: 'Found on SharePoint; downloading on the next scan.', href: sp };
  const href = sessionHref(base, it.session_id);
  const probe = st.probe && st.probe.status === 'done' ? st.probe.meta : null;
  if ((st.transcribe && st.transcribe.status === 'skipped') || (probe && audioClass(probe).silent)) {
    return { kind: 'silent', label: 'no audio', detail: 'The recording has no usable audio.', href };
  }
  for (const stage of ['probe', 'cut', 'transcribe', 'index']) {
    const s = st[stage];
    if (s && s.status === 'failed') return { kind: 'failed', label: `${stage} failed`, detail: (s.error || '').split('\n')[0], href };
  }
  for (const stage of ['probe', 'cut', 'transcribe', 'index']) {
    if (st[stage] && st[stage].status === 'running') return remoteTile(stage, st[stage], href) || { kind: 'busy', label: `${VERB[stage]}…`, detail: '', href };
  }
  if (st.transcribe && st.transcribe.status === 'done' && (!st.index || st.index.status === 'done')) {
    const bits = [`${st.transcribe.meta.segments ?? '?'} transcript lines`];
    if (st.cut && st.cut.status === 'done' && st.cut.meta.keptPct != null) bits.push(`cut keeps ${st.cut.meta.keptPct}%`);
    if (probe && audioClass(probe).quiet) bits.push('quiet recording');
    return { kind: 'ready', label: 'ready', detail: bits.join(' · '), href };
  }
  for (const stage of ['transcribe', 'cut']) {
    const t = remoteTile(stage, st[stage], href);
    if (t) return t;
  }
  const waiting = ['probe', 'cut', 'transcribe', 'index'].map((k) => st[k]).find((s) => s && s.status === 'pending' && s.error);
  return { kind: 'queued', label: waiting ? 'waiting' : 'queued', detail: waiting ? waiting.error : 'Queued for processing.', href };
}

const DASH_STYLE = `
  main { max-width:76rem; }
  :root { --card:#f6f6f8; --card-line:#e6e6ea; --ready:#e3f4ea; --ready-fg:#17663f; --busy:#fff1d6; --busy-fg:#8a5300;
          --failed:#fde7e4; --failed-fg:#a3281b; --silent:#eeeef1; --soon:transparent; --bar:#d9dce6; }
  @media (prefers-color-scheme: dark) { :root { --card:#1c1c20; --card-line:#2c2c32; --ready:#173226; --ready-fg:#7fdcaa;
          --busy:#3a2e14; --busy-fg:#f3c26b; --failed:#3d1d1a; --failed-fg:#ff9a8c; --silent:#25252a; --bar:#34343c; } }
  .bento { display:grid; grid-template-columns:repeat(6, minmax(0, 1fr)); gap:14px; }
  .tile { background:var(--card); border:1px solid var(--card-line); border-radius:16px; padding:18px; min-width:0; }
  .s2 { grid-column:span 2; } .s3 { grid-column:span 3; } .s4 { grid-column:span 4; } .s6 { grid-column:span 6; }
  @media (max-width: 960px) { .bento { grid-template-columns:repeat(2, minmax(0, 1fr)); } .s2, .s3 { grid-column:span 1; } .s4, .s6 { grid-column:span 2; } }
  @media (max-width: 620px) { .bento { grid-template-columns:minmax(0, 1fr); } .s2, .s3, .s4, .s6 { grid-column:span 1; } }
  .eyebrow { font-size:.75rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0 0 6px; }
  .big { font-size:2rem; font-weight:700; line-height:1.1; font-variant-numeric:tabular-nums; }
  .bar { height:8px; border-radius:99px; background:var(--bar); overflow:hidden; margin-top:12px; }
  .bar > span { display:block; height:100%; background:var(--ok); border-radius:99px; }
  .hero h1 { font-size:1.6rem; margin:0 0 4px; }
  .hero form { display:flex; gap:8px; margin-top:14px; }
  .hero input[type=search] { font-size:1.05rem; padding:10px 14px; border-radius:10px; }
  .hero button { padding:10px 18px; border-radius:10px; background:var(--accent); color:#fff; border-color:transparent; }
  .sys dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0 0 12px; font-size:.9rem; }
  .sys dt { color:var(--muted); } .sys dd { margin:0; min-width:0; overflow-wrap:anywhere; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .dot.on { background:var(--ok); } .dot.off { background:var(--err); }
  .latest a { text-decoration:none; color:inherit; } .latest a:hover .title { text-decoration:underline; }
  .latest .title { font-weight:600; margin:2px 0; }
  .course header { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:12px; }
  .course h2 { font-size:1.05rem; margin:2px 0 0; }
  .code { font:600 .75rem ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); }
  .count { font-size:.85rem; color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
  .comp { display:flex; align-items:center; gap:6px; margin:10px 0 6px; font-size:.8rem; color:var(--muted); }
  .sessions { display:grid; grid-template-columns:repeat(auto-fill, minmax(64px, 1fr)); gap:8px; }
  .s { display:flex; flex-direction:column; gap:1px; padding:8px 7px; border-radius:10px; text-decoration:none; color:inherit;
       border:1px solid transparent; min-height:64px; font-size:.72rem; line-height:1.3; min-width:0; }
  .s > * { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .s b { font-size:1rem; } .s .lbl { font-weight:600; margin-top:auto; }
  a.s:hover, a.s:focus-visible { border-color:var(--accent); outline:none; }
  .s.ready { background:var(--ready); } .s.ready .lbl { color:var(--ready-fg); }
  .s.busy, .s.queued, .s.fetching { background:var(--busy); } .s.busy .lbl, .s.queued .lbl, .s.fetching .lbl { color:var(--busy-fg); }
  .s.failed { background:var(--failed); } .s.failed .lbl { color:var(--failed-fg); }
  .s.silent { background:repeating-linear-gradient(135deg, var(--silent) 0 6px, transparent 6px 12px); border-color:var(--card-line); }
  .s.soon { border:1px dashed var(--card-line); color:var(--muted); }
  .legend { display:flex; flex-wrap:wrap; gap:14px; margin:20px 2px 0; font-size:.8rem; color:var(--muted); }
  .legend i { display:inline-block; width:12px; height:12px; border-radius:4px; margin-right:6px; vertical-align:-1px; }
`;

function sessionTile(base, it, st) {
  const t = tileState(base, it, st);
  const dur = st && st.probe && st.probe.meta && st.probe.meta.duration;
  const tip = [`Session ${it.session_number}`, fmtLongDay(it.session_date), dur ? fmtHours(dur) : '', t.detail].filter(Boolean).join(' · ');
  const body = `<b>S${esc(it.session_number)}</b><span>${esc(fmtDay(it.session_date))}</span>${dur ? `<span class="muted">${fmtHours(dur)}</span>` : ''}<span class="lbl">${esc(t.label)}</span>`;
  const ext = t.href && t.href.includes('/recording/') ? ' target="_blank" rel="noopener"' : '';
  return t.href
    ? `<a class="s ${t.kind}" href="${t.href}"${ext} title="${esc(tip)}" aria-label="${esc(tip)}">${body}</a>`
    : `<div class="s ${t.kind}" title="${esc(tip)}" aria-label="${esc(tip)}">${body}</div>`;
}

const isWide = (course) => course.components.size > 1 || [...course.components.values()].flat().length > 6;

/**
 * Give each course card a column span so rows fill the 6-column grid exactly:
 * two wide cards (3 + 3), then three narrow ones (2 + 2 + 2), alternating;
 * leftovers stretch to fill their row. Returns [[course, spanClass], …].
 */
function packCourses(courses) {
  const wide = courses.filter(isWide);
  const narrow = courses.filter((c) => !isWide(c));
  const out = [];
  while (wide.length || narrow.length) {
    if (wide.length >= 2) out.push([wide.shift(), 's3'], [wide.shift(), 's3']);
    else if (wide.length === 1) {
      if (narrow.length) out.push([wide.shift(), 's4'], [narrow.shift(), 's2']);
      else out.push([wide.shift(), 's6']);
    }
    if (narrow.length >= 3) out.push([narrow.shift(), 's2'], [narrow.shift(), 's2'], [narrow.shift(), 's2']);
    else if (!wide.length && narrow.length === 2) out.push([narrow.shift(), 's3'], [narrow.shift(), 's3']);
    else if (!wide.length && narrow.length === 1) out.push([narrow.shift(), 's6']);
  }
  return out;
}

function courseCard(base, course, stages, span) {
  const comps = [...course.components.entries()].sort(([a], [b]) => a.localeCompare(b));
  const all = comps.flatMap(([, list]) => list);
  const ready = all.filter((it) => tileState(base, it, stages[it.id]).kind === 'ready').length;
  const withRec = all.filter((it) => it.status !== 'not_yet').length;
  const hours = all.reduce((a, it) => a + ((stages[it.id] && stages[it.id].probe && stages[it.id].probe.meta.duration) || 0), 0);
  return `<section class="tile course ${span}">
    <header><div><div class="code">${esc(course.code)} · ${esc(course.period)}</div><h2>${esc(course.title)}</h2></div>
      <div class="count" title="${ready} of ${withRec} recordings ready to watch and search">${ready}/${withRec} ready${hours ? ` · ${fmtHours(hours)}` : ''}</div></header>
    ${comps
      .map(
        ([comp, list]) => `<div class="comp"><span class="tag">${esc(comp)}</span>${esc(list[0].class_code || '')}</div>
    <div class="sessions">${list
      .sort((a, b) => a.session_number - b.session_number)
      .map((it) => sessionTile(base, it, stages[it.id]))
      .join('')}</div>`
      )
      .join('')}
  </section>`;
}

/** System tile rows for COMPUTE=remote: the compute PC and the search (embedding) server. */
function remoteRows(node, stages, searchUp) {
  let waiting = 0;
  for (const st of Object.values(stages)) for (const k of ['cut', 'transcribe']) if (st[k] && st[k].remote && st[k].remote.state !== 'leased') waiting++;
  const seen = node.lastSeen ? `last seen ${ago(node.lastSeen)}` : 'never connected';
  const gpu = node.info && node.info.gpu ? ` · ${esc(node.info.gpu)}` : '';
  return `<dt>Compute PC</dt><dd><span class="dot ${node.online ? 'on' : 'off'}"></span>${node.online ? 'online' : 'offline'}<span class="muted"> · ${esc(seen)}${gpu}</span>${waiting ? ` <span class="muted">(${waiting} waiting)</span>` : ''}</dd>
        <dt>Search</dt><dd><span class="dot ${searchUp ? 'on' : 'off'}"></span>${searchUp ? 'up' : 'down'}</dd>`;
}

/** What a busy lane is doing, e.g. "cutting COMP6 LEC S3 on PC (upload 40%)". */
function laneText(stage, l) {
  const r = l.running.remote;
  if (!r) return `${esc(VERB[stage])} ${esc(l.running.label)}`;
  if (r.status === 'leased') return `${esc(VERB[stage])} ${esc(l.running.label)} on PC${r.progress ? ` <span class="muted">(${esc(fmtProgress(r.progress))})</span>` : ''}`;
  return `${esc(l.running.label)}: ${esc(stage)} <span class="muted">waiting for PC</span>`;
}

function renderDashboard({ base, items, stages, lastScan, scanning, pipe, whisperUp, node, searchUp }) {
  // course → component → sessions
  const courses = new Map();
  for (const it of items) {
    const key = `${it.period}|${it.course_code}`;
    if (!courses.has(key)) courses.set(key, { code: it.course_code, title: it.course_title, period: it.period, components: new Map() });
    const comps = courses.get(key).components;
    if (!comps.has(it.component)) comps.set(it.component, []);
    comps.get(it.component).push(it);
  }

  // headline numbers
  let ready = 0, withRec = 0, recSec = 0, keptSec = 0, latest = null;
  for (const it of items) {
    const st = stages[it.id] || {};
    if (it.status !== 'not_yet') withRec++;
    if (st.probe && st.probe.meta.duration) recSec += st.probe.meta.duration;
    if (st.cut && st.cut.status === 'done') keptSec += st.cut.meta.keptSec || 0;
    if (tileState(base, it, st).kind === 'ready') {
      ready++;
      if (!latest || String(it.session_date) > String(latest.session_date)) latest = it;
    }
  }
  const pct = withRec ? Math.round((100 * ready) / withRec) : 0;
  const saved = recSec && keptSec ? Math.round(100 - (100 * keptSec) / recSec) : null;

  const busy = pipe ? Object.entries(pipe.lanes).filter(([, l]) => l.running) : [];
  const queued = pipe ? Object.values(pipe.lanes).reduce((a, l) => a + l.queued, 0) : 0;
  const working = !pipe
    ? '<span class="err">worker not running</span>'
    : busy.length
      ? busy.map(([stage, l]) => laneText(stage, l)).join('<br>')
      : 'idle';

  const cards = packCourses([...courses.values()].sort((a, b) => a.code.localeCompare(b.code)))
    .map(([c, span]) => courseCard(base, c, stages, span))
    .join('');

  return layout(
    'Lectures',
    `<style>${DASH_STYLE}</style>
  <div class="bento">
    <section class="tile hero s4">
      <h1>Lectures</h1>
      <div class="muted">Search everything said in class, in English or Indonesian.</div>
      <form method="get" action="${base}/search" role="search">
        <input type="search" name="q" placeholder="e.g. how do you compute a confidence interval?" aria-label="Search all lectures">
        <button>Search</button>
      </form>
    </section>
    <section class="tile s2">
      <p class="eyebrow">Ready to watch &amp; search</p>
      <div class="big">${ready}<span class="muted" style="font-size:1rem;font-weight:500"> / ${withRec}</span></div>
      <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <div class="muted status" style="margin-top:8px">${items.length - withRec} session(s) without a recording yet</div>
    </section>
    <section class="tile s2">
      <p class="eyebrow">Recorded</p>
      <div class="big">${fmtHours(recSec) || '0m'}</div>
      <div class="muted status" style="margin-top:8px">${keptSec ? `${fmtHours(keptSec)} after cutting silences${saved != null ? ` (${saved}% shorter)` : ''}` : 'Nothing cut yet'}</div>
    </section>
    <section class="tile latest s2">
      <p class="eyebrow">Latest lecture</p>
      ${
        latest
          ? `<a href="${sessionHref(base, latest.session_id)}"><div class="code">${esc(latest.course_code)} · ${esc(latest.component)} · S${esc(latest.session_number)}</div>
             <div class="title">${esc(latest.course_title)}</div><div class="muted status">${esc(fmtLongDay(latest.session_date))}</div></a>`
          : '<div class="muted">Nothing transcribed yet.</div>'
      }
    </section>
    <section class="tile sys s2">
      <p class="eyebrow">System</p>
      <dl>
        <dt>Worker</dt><dd><span class="dot ${pipe ? 'on' : 'off'}"></span>${working}${queued ? ` <span class="muted">(+${queued} queued)</span>` : ''}</dd>
        ${node ? remoteRows(node, stages, searchUp) : `<dt>Transcriber</dt><dd><span class="dot ${whisperUp ? 'on' : 'off'}"></span>${whisperUp ? 'up' : 'down'}</dd>`}
        <dt>Last scan</dt><dd title="${esc(lastScan || '')}">${esc(ago(lastScan))}${scanning ? ' · <strong>scanning…</strong>' : ''}</dd>
      </dl>
      <form method="post" action="${base}/scan"><button type="submit"${pipe ? '' : ' disabled title="The worker is not running"'}>Scan now</button></form>
    </section>
    ${cards || '<section class="tile s6 muted">Nothing found yet — run a scan.</section>'}
  </div>
  <div class="legend">
    <span><i style="background:var(--ready)"></i>ready</span>
    <span><i style="background:var(--busy)"></i>in progress / queued</span>
    <span><i style="background:var(--failed)"></i>failed (hover for why)</span>
    <span><i style="background:repeating-linear-gradient(135deg, var(--silent) 0 3px, transparent 3px 6px);border:1px solid var(--card-line)"></i>no audio</span>
    <span><i style="border:1px dashed var(--card-line)"></i>no recording yet</span>
  </div>`,
    { base, search: false }
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
      <div class="muted small" style="padding:0;margin-top:4px">Files: <a href="${sources.orig.src}">original</a> (${esc(fmtSize(item.size))})${
        sources.cut ? ` · <a href="${sources.cut.src}">cut</a>` : ''
      } · <a href="${base}/recording/${encodeURIComponent(item.session_id)}" target="_blank" rel="noopener">open on SharePoint</a></div>
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
