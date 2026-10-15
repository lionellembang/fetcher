/**
 * Server-rendered dashboard: one table per class, one row per session, showing
 * its recording (downloaded file / SharePoint link / not yet).
 */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '');
const fmtSize = (n) => (n == null ? '' : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const filesHref = (base, rel) => `${base}/files/${String(rel).split(/[\\/]/).map(encodeURIComponent).join('/')}`;

function renderDashboard({ base, items, lastScan, scanning }) {
  // period → class → session → recording
  const classes = new Map();
  for (const it of items) {
    const key = `${it.period}|${it.class_id}`;
    if (!classes.has(key)) {
      classes.set(key, { period: it.period, title: `${it.course_code} — ${it.course_title}`, component: it.component, classCode: it.class_code, sessions: new Map() });
    }
    const sessions = classes.get(key).sessions;
    sessions.set(it.session_id, { n: it.session_number, date: it.session_date, id: it.session_id, recording: it });
  }

  const recCell = (s) => {
    const r = s.recording;
    if (r.status === 'not_yet') return '<span class="muted">not yet</span>';
    const open = `<a href="${base}/recording/${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Open on SharePoint</a>`;
    if (r.status === 'downloaded') {
      return `<a href="${filesHref(base, r.file_path)}">Recording</a> <span class="muted">${fmtSize(r.size)}</span><br>${open}`;
    }
    if (r.status === 'failed') return `${open}<br><span class="err" title="${esc(r.error || '')}">download failed</span>`;
    return `${open}<br><span class="muted">download pending</span>`;
  };

  const tables = [...classes.values()]
    .map(
      (c) => `
    <section>
      <h2>${esc(c.title)} <span class="tag">${esc(c.component)}</span> <span class="muted">${esc(c.classCode)} · ${esc(c.period)}</span></h2>
      <div class="scroll"><table>
        <thead><tr><th>Session</th><th>Date</th><th>Recording</th></tr></thead>
        <tbody>${[...c.sessions.values()]
          .sort((a, b) => a.n - b.n)
          .map((s) => `<tr><td>${esc(s.n)}</td><td>${esc(fmtDate(s.date))}</td><td>${recCell(s)}</td></tr>`)
          .join('')}</tbody>
      </table></div>
    </section>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Class Downloads</title>
<style>
  :root { --bg:#fff; --fg:#1c1c1e; --muted:#6b6b70; --line:#e3e3e6; --accent:#2457d6; --err:#c0392b; --tag:#eef1fb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141416; --fg:#ececef; --muted:#9a9aa1; --line:#2c2c31; --accent:#7ea2ff; --err:#ff7b6b; --tag:#23283a; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,sans-serif; }
  main { max-width:64rem; margin:0 auto; padding:24px 16px 64px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
  h1 { font-size:1.4rem; margin:0; } h2 { font-size:1.05rem; margin:28px 0 8px; }
  a { color:var(--accent); } .muted { color:var(--muted); } .err { color:var(--err); }
  .tag { font-size:.75rem; background:var(--tag); padding:2px 6px; border-radius:4px; vertical-align:middle; }
  .scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; font-size:.85rem; color:var(--muted); }
  button { font:inherit; padding:6px 14px; border-radius:6px; border:1px solid var(--line); background:var(--tag); color:var(--fg); cursor:pointer; }
</style></head>
<body><main>
  <header>
    <div><h1>Class Downloads</h1>
      <div class="muted">Last scan: ${esc(lastScan || 'never')}${scanning ? ' · <strong>scan running…</strong>' : ''}</div></div>
    <form method="post" action="${base}/scan"><button type="submit">Scan now</button></form>
  </header>
  ${tables || '<p class="muted">Nothing found yet — run a scan.</p>'}
  <p class="muted" style="margin-top:32px">Recordings are downloaded on each scan. <em>Open on SharePoint</em> opens one in your browser (sign in with your BINUS account); each link is fetched fresh when you click it.</p>
</main></body></html>`;
}

module.exports = { renderDashboard };
