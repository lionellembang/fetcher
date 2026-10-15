# fetcher

Finds the lecture recordings of your BINUS classes, downloads them, cuts out the
silences, transcribes them, and lets you search them, both in a web dashboard
and from Claude over MCP. Ask "where did the lecturer explain X?" and get the
lecture, the timestamp and a link that opens the video at that moment.

```
scripts/start.sh
 ├─ transcriber/   Python: Whisper large-v3 on the GPU + text embeddings on the CPU   :8000
 ├─ server/        Node: LMS scan → download → pipeline → dashboard + MCP            :3100
 │    scan (every 6 h) ─▶ download (Playwright, SharePoint)
 │                          └─▶ probe (loudness, duration)
 │                                ├─▶ cut (auto-editor)          → video for watching
 │                                └─▶ transcribe (original audio) ─▶ index (embeddings)
 └─ cloudflared    https://lectures.<your-domain> → 127.0.0.1:3100
```

The three original repos live here as git subtrees with their history:
`server/` (downloadrecord), `transcriber/` (transcription), `cutting/` (the
silence-cut notes and tools; the cut logic itself now lives in `server/src/cut.js`).

## Setup (once)

This runs on the WSL2 machine with the NVIDIA GPU.

**Tools** go into `~/.local/bin` (no sudo):

| Tool | How |
|---|---|
| Node 24 | `node-v24.x-linux-x64.tar.xz` from nodejs.org, unpacked to `~/.local/lib/node`, `node`/`npm`/`npx` symlinked into `~/.local/bin` |
| ffmpeg + ffprobe | johnvansickle.com static build |
| auto-editor | `auto-editor-linux-x86_64` from its GitHub releases. It needs `libgomp.so.1`; without sudo, `apt download libgomp1`, extract it next to the binary and call it through a small wrapper that sets `LD_LIBRARY_PATH` (that's how `~/.local/bin/auto-editor` is set up now) |
| cloudflared | `cloudflared-linux-amd64` from its GitHub releases |

**Chromium for the LMS login** needs system libraries, which takes sudo once:

```bash
cd server && npm install && sudo npx playwright install-deps chromium && npx playwright install chromium
```

**Transcriber.** Any Python 3.12 environment with `transcriber/requirements.txt`
works. The existing `~/transcription/.venv` is used (`TRANSCRIBER_VENV` in `.env`);
`sentence-transformers` was added to it, and its broken `torchaudio` (CUDA 12 build
next to a CUDA 13 torch) was removed because `transformers` crashes importing it.
Model files are cached in `~/.cache` (Whisper `large-v3`, `multilingual-e5-base`).

**Config:**

```bash
cp .env.example .env
# fill in BINUS_USERNAME, BINUS_PASSWORD, PUBLIC_URL, and a long ACCESS_TOKEN:
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

The login is headless with your password, so the account must not ask for MFA.

**Cloudflare tunnel** (your domain must be on Cloudflare):

```bash
cloudflared tunnel login                                  # opens a browser to pick the domain
cloudflared tunnel create fetcher
cloudflared tunnel route dns fetcher lectures.<your-domain>
cat > ~/.cloudflared/config.yml <<EOF
tunnel: fetcher
credentials-file: $HOME/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: lectures.<your-domain>
    service: http://127.0.0.1:3100
  - service: http_status:404
EOF
```

Set `PUBLIC_URL=https://lectures.<your-domain>` and `CLOUDFLARE_TUNNEL=fetcher` in `.env`.

## Run

```bash
scripts/start.sh
```

It starts the transcriber (or uses one that's already running), then the
server, then the tunnel, and follows the server log. Ctrl-C stops everything.
On start the server scans the LMS, then again every `SCAN_INTERVAL_MINUTES`.
Work interrupted by a stop picks up where it left off on the next start.

Logs are in `logs/` (`server.log`, `transcriber.log`, `cloudflared.log`).

## Use it

**Dashboard:** `https://lectures.<your-domain>/d/<ACCESS_TOKEN>`
- One table per class: recording, cut (with % kept) and transcript status per
  session. Hover "failed" or "waiting" to see why.
- Session page: the original or the cut video next to its transcript. Click a
  line to jump there; the current line follows playback in either video.
  SRT/VTT/TXT downloads, and **Redo** buttons for each step.
- Search box: searches every lecture by meaning and keywords, in English or
  Indonesian.

**MCP:** `https://lectures.<your-domain>/d/<ACCESS_TOKEN>/mcp` (Streamable HTTP)
- claude.ai: Settings → Connectors → Add custom connector → paste the URL.
- Claude Code: `claude mcp add --transport http lectures https://lectures.<your-domain>/d/<ACCESS_TOKEN>/mcp`

| Tool | What it's for |
|---|---|
| `find_in_lectures` | "Was X covered, and where?" Ranked passages with timestamp, `strong`/`possible`/`weak` label, excerpt, and video links (original and cut) |
| `get_transcript_context` | The transcript around a moment, so Claude can check a hit before answering |
| `get_transcript` | A whole lecture or a time range (timestamped, text, SRT, segments) |
| `list_courses`, `list_sessions` | What's there and how far along each session is |
| `pipeline_status`, `trigger_scan`, `retry_stage` | Status and control |

The server tells Claude how to use these: search, check the context, answer with
the timestamp link, and say plainly when the recordings don't cover a topic.

The secret path is the only protection: anyone with the URL can read the
transcripts and watch the recordings. Treat it like a password; changing
`ACCESS_TOKEN` revokes the old URL (re-add the connector afterwards).

## How it works

**Scan and download** (`server/src/scan.js`, `recordings.js`): see
[server/README.md](server/README.md) for the LMS API and SharePoint sign-in. After
the browser signs in, files are downloaded over plain HTTP with its cookies, and
a broken or stalled transfer resumes where it stopped (up to 6 attempts).

**Pipeline** (`server/src/pipeline.js`): each downloaded recording goes through
four steps, each with its own queue. Cut and transcribe can run at the same time
(CPU vs. GPU, limit `HEAVY_CONCURRENCY`).

| Step | What | Output |
|---|---|---|
| probe | ffmpeg `volumedetect` + duration. Peak below −60 dB or average below −55 dB = no audio: cut and transcribe are skipped. Peak below −20 dB or average below −40 dB = "quiet" | stage meta |
| cut | auto-editor `--edit audio:-30dB --margin 0.3s,0.5s` (the tuned settings from `cutting/`), plus `--export v1` for the kept-spans timeline. Under 10 s kept = skipped | `…/cutted/<name> cutted.mp4` + `.timeline.json` |
| transcribe | 16 kHz mono FLAC of the **original** (loudness-normalised if quiet) → a job on the transcriber (Whisper with VAD + loudness gate), polled until done | segments in SQLite (+ FTS5) |
| index | ~45 s overlapping windows of segments → `multilingual-e5-base` embeddings | chunks in SQLite |

Every step records the settings it ran with. Change a setting (say `CUT_MARGIN`)
and that step is redone for every recording on the next start. A redone
transcript also redoes its search index; the loudness thresholds are applied on
use, so changing them redoes nothing. Failed steps are retried on the next scan or restart, or with **Redo**.
If the transcriber is down, transcribe and index wait and retry every minute.

**Timestamps**: transcripts are stored once, on the original's timeline. The cut's
timeline file maps them onto the cut video (`server/src/timeline.js`). The same
functions run in the browser, so the transcript follows either video.

**Search** (`server/src/transcripts.js`): semantic (cosine vs. every chunk) and
keyword (FTS5 bm25) rankings fused with reciprocal rank fusion. Labels: a passage
is `strong`/`possible` when its cosine clears a floor and, once 200+ chunks are
indexed, it stands out from that query's average by a z-score. The thresholds
(`SEARCH_*` in `.env`) are first guesses: tune them with real study questions,
some covered in lectures and some not.

**Files:**

```
downloads/2610/COMP6798001 Program Design Methods (LEC)/
  COMP6798001 LEC S01 recording.mp4
  cutted/COMP6798001 LEC S01 recording cutted.mp4
  cutted/COMP6798001 LEC S01 recording cutted.timeline.json
data/downloads.db      items, stages, transcripts, segments (+ FTS), chunks
data/session.json      LMS token (24 h)
```

## Commands (in `server/`)

```bash
npm test                          # unit tests (timeline mapping, chunking)
npm run scan                      # one LMS scan, no server
npm run recordings [-- <sessionId>]   # only download
npm run pipeline [-- <sessionId>]     # process downloaded recordings (all, or some) and exit
npm run login                     # force a fresh login (HEADFUL=true to watch)
```

## Troubleshooting

- **Transcriber "down" on the dashboard.** Check `logs/transcriber.log`. A WSL
  restart stops everything: run `scripts/start.sh` again.
- **WSL runs out of memory.** Chromium, an auto-editor encode, Whisper and the
  embedding model together can be a lot for 7 GB. Set `HEAVY_CONCURRENCY=1`, or raise
  `memory=` under `[wsl2]` in `%UserProfile%\.wslconfig`.
- **Login fails.** `HEADFUL=true npm run login` (in `server/`) to watch it.
- **First run is long.** The whole active period is processed: roughly 20 min
  of GPU and 10+ min of encoding per lecture. Set `PERIODS` to limit it.
