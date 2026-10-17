# fetcher: split into a Mac hub and a PC compute node

Handoff for the agent on the Mac. The repo is `github.com/lionellembang/fetcher`
(`main` is current). Read `README.md` first for how the system works today.

> **Status (2026-10-17):** §1–§5 are built on the `two-server` branch, and §6
> steps 1–5 are done: the Mac is the hub (embed, worker and web as
> LaunchDaemons), `lectures.tukeel.online` is served by the Mac's own
> dashboard-managed tunnel, and the PC runs only `transcriber` and `node`. The
> first real lecture was cut on the PC (its first upload failed the hash check
> and was redone). The §6 verification list is still open. Where the build differs from this plan:
>
> - The node API is on the LAN listener only, not also on the web app behind
>   the tunnel (the two machines are wired together), so there is no fallback
>   URL: the PC's `.env` has one `HUB_URL`, not `HUB_URLS`.
> - Cut uploads are one streamed, resumable PUT, not 64 MiB chunks (those were
>   only for Cloudflare's request limit); claims carry no `chunkBytes`.
> - The Mac's tunnel is dashboard-managed, so §5's local ingress edit was a
>   Public Hostname in Zero Trust instead, and the old `lectures` CNAME had to
>   be pointed at the Mac's tunnel by hand (until then Cloudflare answered 1033).
> - Known issue: seeking in videos through the tunnel is slow (see the README's
>   troubleshooting).
>
> The code has since
> been split by machine: `server/shared/` (both), `server/hub/` (Mac) and
> `server/compute/` (PC), the Python too (`transcriber/` is now
> `server/compute/transcriber/`, `server/shared/embedding/` and
> `server/hub/embed-server/`; `cutting/` is `docs/cutting/`); see
> `server/README.md` → Layout. Paths below such as
> `src/pipeline.js` are from before that split (now `hub/pipeline.js`,
> `shared/cut.js`, `compute/agent.js`, …).

## Context

fetcher runs entirely on one Windows PC under WSL2 with an RTX 5070. It does the following:

- logs in to BINUSMAYA
- scans courses
- downloads lecture recordings from SharePoint
- probes them
- silence-cuts them with auto-editor
- transcribes them with faster-whisper on the GPU
- indexes them for search with e5 embeddings on the CPU
- serves a dashboard, video and MCP through a Cloudflare tunnel (`lectures.tukeel.online`)

The PC isn't on 24/7, but the Mac server is. The goal:

- **Mac (hub, 24/7):** everything except cutting and transcribing:
  - scan, download, probe, index and search embeddings
  - web, MCP and the tunnel
  - the database and all files, as the source of truth
- **PC (compute node, sometimes on):** only **cut** and **transcribe**. It pulls jobs from the Mac, downloads the original from the Mac, runs the work, and uploads the results.
- **When the PC is off:** new recordings wait as "waiting for PC". The Mac never cuts or transcribes.
- **Network:** the PC reaches the Mac over the LAN (the two are wired to each other). There is no fallback through the public tunnel: the node API is not exposed there at all.
- **Mac services:** run under launchd, so they start at boot and restart on crash.
- **Keep the single-box mode working:** `COMPUTE=local` (the default) behaves exactly like today.

## Facts about the current code that matter

- **Process split today:** `server/worker.js` runs scan, downloads and the pipeline, plus a control API on 127.0.0.1:3101. `server/web.js` runs the dashboard, files and MCP on 127.0.0.1:3100.
  - Both share SQLite (`data/downloads.db`, WAL, `busy_timeout`).
  - The web process reaches the worker through `src/control.js`.
  - Cross-process change signals go through the DB, e.g. meta `chunks_version`.
- **Pipeline:** `src/pipeline.js`
  - Stages run probe → {cut, transcribe} → index. Each stage stores a `params_key`, and a stage redoes when its key changes.
  - Each stage has one lane with concurrency 1. `RUN[stage]` returns `{status?, outputPath?, meta}`.
  - Error handling:
    - `cut.SilentError` → the stage is marked skipped
    - `whisper.UnavailableError` → the lane is paused and retried every 60 s
  - `resetRunningStages()` puts interrupted stages back on boot.
- **Cut:** `src/cut.js`
  - `cutRecording(rel)` reads `CUT_EDIT`, `CUT_MARGIN` and `CUT_EXTRA_ARGS` from config.
  - It writes `<dir>/cutted/<stem> cutted.mp4` and `.timeline.json` through `.partial_` temp names, which are then renamed into place.
  - Output paths come from `cutPaths(rel)`.
- **Transcribe:** `src/transcribe.js`
  - `transcribeRecording(item, probeMeta)` extracts a 16 kHz FLAC (`media.extractAudio`, loudnorm when quiet), POSTs `/jobs` to the transcriber, polls with `whisper.waitJob`, then calls `store.saveTranscript`.
  - `src/whisper.js` holds the HTTP client for the transcriber (`submitJob`, `waitJob`, `embed`, `health`).
- **Index:** `src/indexer.js` embeds chunks through `whisper.embed()`, which posts to the transcriber's `/embed`.
- **Relative paths:** every path in the DB (`items.file_path`, `stages.output_path`, `meta.timeline`) is relative to `DOWNLOAD_DIR`. Migrating is a plain copy.
- **Transcriber:** `transcriber/server.py` is Python with FastAPI.
  - Whisper is loaded only while transcribing.
  - `/embed` uses the `SentencePieceE5` class, multilingual-e5-base on the CPU. Its vectors are byte-identical to the stored index.
  - It imports torch, faster-whisper, openai-whisper and silero at the top of the file, all of which are GPU/Whisper-only.
- **Download resume logic:** `src/recordings.js` `httpDownload()` contains a Range/resume loop (stall detection, retries) that is coupled to a Playwright page for cookies and the user agent.
- **`scripts/fetcher` is Linux-only:**
  - It uses `setsid`, `env -C`, `mapfile`, `tac`, `realpath -m`, systemd scopes and `/proc`.
  - macOS ships bash 3.2, which can't run it. Don't use it on the Mac.
- **Cloudflare free-plan limits:**
  - request bodies are capped at 100 MB
  - responses must start within about 100 s
  - `/files` responses already send `Cache-Control: private, no-cache`, because Cloudflare caching broke range requests

## Target architecture

```
                 Mac (hub, launchd)                                   PC / WSL2 (compute node)
 ┌──────────────────────────────────────────────────┐        ┌──────────────────────────────────┐
 │ worker: scan, download, probe, index, job queue  │        │ node agent (server/node.js)      │
 │ web:    dashboard, /files, MCP, /node API (LAN)  │◀──LAN──│  claim → fetch source → cut or   │
 │ embed:  transcriber/embed_server.py (e5, CPU)    │        │  transcribe → upload → complete  │
 │ (existing Mac cloudflared + fetcher hostname)    │        │ transcriber (Whisper, GPU)       │
 │ data/ downloads/ (source of truth)               │        │ data/node-cache/ (originals)     │
 └──────────────────────────────────────────────────┘        └──────────────────────────────────┘
```

The PC always initiates (pull model), so the PC needs no inbound ports.

## 1. Hub: remote jobs (`COMPUTE=remote`)

**Config** (`src/config.js`, `.env.example`):

| Key | Purpose |
|---|---|
| `COMPUTE=local\|remote` | default `local` |
| `NODE_TOKEN` | ≥32 chars, separate from `ACCESS_TOKEN` |
| `NODE_HOST` / `NODE_PORT` | LAN listener, default `0.0.0.0:3102` |
| `EMBED_URL` | defaults to `WHISPER_URL`; `whisper.embed()` and the dashboard's search health use it |
| `NODE_LEASE_SEC=600` | — |

**New table** in `src/store.js`: `node_jobs`.
- Columns: `id`, `item_id`, `stage`, `params_key`, `key` UNIQUE (`item|stage|params_key`), `params` (JSON), `status` (`queued|leased|done|failed|skipped|cancelled`), `node_id`, `lease_until`, `progress`, `result` (JSON), `error`, `created_at`, `updated_at`.
- Store `node_last_seen` and `node_info` (id, version, GPU, free disk) in `meta`.

**New `src/remote.js`** (worker side):
- `run(item, stage, stages)`:
  1. Upsert the job by `key`.
     - If a queued, leased or done job with that key already exists, attach to it instead of creating a new one. This makes worker restarts safe: `resetRunningStages` re-runs the stage, which re-attaches.
     - `params` are built on the hub: the cut edit, margin and extra args, or the transcribe language, model, `gateDb` and loudnorm decision (`transcribe.useLoudnorm(probeMeta)`). The node never uses its own settings, so `params_key` stays meaningful.
  2. Poll the DB every 5 s until the job reaches a final status. There is no overall timeout while it's queued: the PC may be off for days.
  3. Map the outcome:

     | Job outcome | Effect on the stage |
     |---|---|
     | `done`, cut | `{outputPath, meta}` (files are already in place, see §2) |
     | `done`, transcribe | `store.saveTranscript(...)` with the returned segments (same filtering and meta as `transcribe.js`), then return `{meta}` |
     | `skipped` | throw `cut.SilentError` |
     | `failed` | throw `Error(error)` |
- **Lease sweeper** (every 60 s, in the worker): a `leased` job whose `lease_until` has passed goes back to `queued`. This is normal when the PC shuts down mid-job, so expiry never fails a job.
- **Cancellation:** a job is cancelled when its stage is retried with different params, or when the item is gone. The heartbeat response carries the cancel flag.

**Changes to `src/pipeline.js`:**
- `RUN.cut` and `RUN.transcribe` call `remote.run` when `config.compute === 'remote'`.
- In remote mode cut and transcribe are not "heavy" on the hub, so they don't count toward `HEAVY_CONCURRENCY`.
- `status()` reports per-stage remote state (queued / leased by node X, progress) and whether the node is online (`node_last_seen` within the last 90 s).

**Dashboard and MCP** (`src/page.js`, `src/mcp.js` `pipeline_status`):
- The System tile shows "Compute PC: online / offline, last seen …" and the queue length.
- Session tiles whose remote job is queued while the node is offline get a "waiting for PC" state.
- MCP's `find_in_lectures` "not yet searchable" count already covers these.

## 2. Hub: `/node` API (web process, new `src/nodeApi.js`)

Mount the router only on a second listener at `NODE_HOST:NODE_PORT` that serves **only** `/node`, for the LAN. It is not mounted on the web app, so the tunnel doesn't expose it.

**Auth:** `Authorization: Bearer <NODE_TOKEN>`, checked with `crypto.timingSafeEqual`. Anything else returns 404. Never derive a filesystem path from client input: every path comes from the job row and `cut.cutPaths(item.file_path)`. Every response sends `Cache-Control: no-store`.

| Endpoint | Behaviour |
|---|---|
| `POST /node/claim` `{nodeId, version, stages, info, waitSec≤25}` | Updates `node_last_seen`/`node_info`. Long-polls for up to 25 s. In one transaction, takes the oldest `queued` job of an accepted stage, prioritising cut and transcribe of the same item when the node already holds that original, and sets it `leased`. Returns `{job: {id, stage, params, item: {id, label, rel, size, probeMeta}, leaseSec}}` or 204. |
| `GET /node/jobs/:id/source` | `res.sendFile` of the original, with Range support. |
| `POST /node/jobs/:id/heartbeat` `{progress}` | Extends the lease. Returns `{cancel}`. A 409 means the job is no longer this node's. |
| `GET /node/jobs/:id/upload/:name` | `name` ∈ `video`, `timeline`. Returns `{size}` of the partial upload, so the node can resume. |
| `PUT /node/jobs/:id/upload/:name?offset=N` | The rest of the file, streamed. Appends to `<cutted dir>/.partial_node_<jobId>_<name>`; what arrived before a break is kept. A PUT still open for the same file (a dead connection) is ended first. If `offset` ≠ the current size, returns 409 `{size}`. |
| `POST /node/jobs/:id/complete` | **Cut:** `{files: {video: {size, sha256}, timeline: {size, sha256}}, meta}`. Verifies size and hash, fsyncs, renames over `cutPaths()`, validates the timeline with `timeline.loadTimeline`, stores `result = {outputPath, meta}` and sets the job `done`. **Transcribe:** `{result: {segments, language}, meta}` (body limit about 20 MB), stored as the job `result`. |
| `POST /node/jobs/:id/fail` `{error, silent}` | Sets the job `skipped` (silent) or `failed`, and removes partials. |

Tests (`server/test/nodeApi.test.js`, same style as `download.test.js`):
- claim, lease and lease expiry
- the attach-on-restart upsert
- an upload resumed after a broken chunk
- hash mismatch rejected
- wrong token returns 404
- the LAN listener does not serve `/d/...`

## 3. PC: node agent (`server/node.js`, `src/node/agent.js`)

**Config:**

| Key | Purpose |
|---|---|
| `HUB_URL` | the Mac's node API on the LAN, e.g. `http://192.168.1.20:3102` |
| `NODE_TOKEN` | — |
| `NODE_ID` | defaults to the hostname |
| `NODE_STAGES=cut,transcribe` | — |
| `NODE_CACHE_DIR=data/node-cache` | — |
| `NODE_CACHE_GB=20` | LRU cache of originals, so cut and transcribe of the same lecture download it once |

**Loop:**
1. Claim (long-poll). If the hub isn't reachable, back off from 5 s to 60 s and retry.
2. Fetch the source into the cache at `item.rel`, resuming and checking the size. First factor the Range/resume/stall loop out of `recordings.httpDownload` into `src/httpfetch.js`, taking plain headers, and use it from both places.
3. Run the stage. Refactor so the logic is shared, with no DB access on the node:
   - **Cut:** `cut.cutRecording(rel, {downloadDir, edit, margin, extraArgs})`. Its current signature keeps working with config defaults.
   - **Transcribe:** split `transcribe.js` into `transcribeFile(absPath, {language, model, gateDb, loudnorm, duration}) → {segments, language, meta}`, which needs no DB, and the existing `transcribeRecording`, which calls it and then saves. It talks to the PC's own transcriber at `WHISPER_URL` (127.0.0.1:8000).
4. Heartbeat every 30 s with progress. On `cancel`, stop: `media.killAll()` and drop the job.
5. Upload with resumable PUTs (on a break, ask the hub for the size and send the rest), then `complete`. On `SilentError` or a failure, call `fail`.
6. Run one job at a time, as with `HEAVY_CONCURRENCY=1` today.

**`scripts/fetcher`** (PC only):
- Add a `node` service: `node $NODE_FLAGS node.js`.
- Add `FETCHER_SERVICES` in `.env` to choose which services `start all` runs. On the PC that becomes `transcriber node`.

Tests: an agent test against a fake hub (claim → source → upload-resume → complete) with stubbed `cutRecording`/`transcribeFile`.

## 4. Hub: embedding service without Whisper

- Move `SentencePieceE5` into `transcriber/embedding.py`. `server.py` imports it from there, with behaviour unchanged.
- Add `transcriber/embed_server.py`: FastAPI with `/health` and `/embed`, the same request and response as today, using only torch, transformers, sentencepiece, huggingface_hub and numpy. It runs on the CPU. Keep `EMBED_MODEL`, the `query: `/`passage: ` prefixes and `batch_size=16`.
- Add `transcriber/requirements-embed.txt` (torch from PyPI works on macOS) and `transcriber/run-embed.sh`.
- Before trusting search on the Mac, check vector parity: embed 200 stored chunks on the Mac and compare them with the stored vectors. Expect cosine > 0.9999; then no re-index is needed.

## 5. Mac: setup and launchd

- **Install:**
  - Node 24, plus `npm ci` in `server/`
  - `ffmpeg` (brew)
  - `npx playwright install chromium`, for SharePoint sign-in
  - `cloudflared` (brew)
  - uv with Python 3.12 → `transcriber/.venv-embed`
  - auto-editor and CUDA are not needed
- **Keep the Mac awake:** `sudo pmset -a sleep 0 disksleep 0` (the agent should check the current `pmset -g` first). Give it a DHCP reservation on the router so its LAN IP stays fixed. When macOS prompts, allow incoming connections for `node`.
- **`scripts/macos/run-service <embed|worker|web>`:** sources `.env`, then `exec`s the same commands `scripts/fetcher` uses, with each service's own `TMPDIR` under `data/tmp/`, `NODE_FLAGS` and `MALLOC_ARENA_MAX=2`.
- **`scripts/macos/install-launchd`:**
  - Writes one plist per service with `RunAtLoad`, `KeepAlive`, `WorkingDirectory`, logs to `logs/<svc>.log` and a `ThrottleInterval`.
  - Prefer LaunchDaemons with `UserName` (needs sudo, and starts without anyone logged in). If there's no sudo, use LaunchAgents and tell the user to enable auto-login.
- **`scripts/macos/fetcherctl start|stop|restart|status|logs [svc]`:** wraps `launchctl bootstrap/bootout/kickstart -k/print`.
- **Mac `.env`:** copy it from the PC (see §6), then set:
  - `COMPUTE=remote`
  - a new `NODE_TOKEN` (`openssl rand -hex 24`)
  - `NODE_PORT=3102`
  - `EMBED_URL=http://127.0.0.1:8000`, with the embed server on 8000 (pick another port if 8000 is already taken on the Mac)
  - `CLOUDFLARE_TUNNEL=` (empty: the Mac's existing tunnel serves fetcher)
  - drop `TRANSCRIBER_VENV`
- **Tunnel:** the Mac **already runs a cloudflared tunnel** for other things. Don't add a second one; add fetcher to the existing tunnel instead.
  1. Find how it runs (`ps`, `launchctl list | grep -i cloudflared`, `~/.cloudflared/config.yml`, or `/etc/cloudflared/`). If it's a dashboard-managed (token) tunnel, the hostname is added in the Zero Trust dashboard instead; tell the user.
  2. Back up its config. Add an ingress rule `hostname: lectures.tukeel.online → service: http://127.0.0.1:3100` **above** the catch-all `http_status:404` rule, and leave every other rule untouched.
  3. Validate with `cloudflared tunnel ingress validate` and `cloudflared tunnel ingress rule https://lectures.tukeel.online/`.
  4. At cut-over time (§6 step 4), point the hostname at the Mac tunnel with `cloudflared tunnel route dns --overwrite-dns <mac-tunnel> lectures.tukeel.online`, then restart that cloudflared the way it's managed today.
  - fetcher therefore gets **no tunnel service** of its own on the Mac. `run-service`, launchd and `fetcherctl` manage only embed, worker and web.
  - The PC's `fetcher` tunnel (`1999aef9-…`) stops being used. Leave it stopped on the PC (`CLOUDFLARE_TUNNEL=` empty), and delete it in Cloudflare after a week.

## 6. Migration order (short downtime)

**Steps marked PC are for the user to run on the PC**, where they can ask Claude Code there. Never paste secrets into chat; copy `.env` and the tunnel credentials with `scp`.

1. **Mac agent:** implement §1–§4 on a branch `two-server`, with `npm test` green and `COMPUTE=local` behaving as before. Push it.
2. **Mac agent:** set up §5, apart from starting the services.
3. **PC:** `scripts/fetcher stop`. Checkpoint the DB:
   ```
   node -e "new (require('node:sqlite').DatabaseSync)('data/downloads.db').exec('PRAGMA wal_checkpoint(TRUNCATE)')"
   ```
   Then copy to the Mac with `rsync -a --info=progress2 data/downloads.db data/session.json downloads/ <mac>:~/fetcher/…`. That's about 15 GB over the LAN; skip `data/tmp`. Then `scp` `.env`. The tunnel credentials stay on the PC. Remote Login must be enabled on the Mac.
4. **Mac:** start embed, worker and web. Check the dashboard and search locally, and run the vector parity check from §4. Then route `lectures.tukeel.online` to the Mac's existing tunnel (§5) and check the public URL and MCP. Also check that the Mac's other tunnel hostnames still work.
5. **PC:**
   - `git pull` (merge `two-server` once it's verified)
   - set the PC `.env` to:
     - `CLOUDFLARE_TUNNEL=` (empty)
     - `FETCHER_SERVICES="transcriber node"`
     - `HUB_URL=http://<mac-lan-ip>:3102`
     - the same `NODE_TOKEN`
   - `scripts/fetcher start`
6. **Verify** (below). After about a week, the PC's `downloads/` and `data/downloads.db` can be deleted; keep `data/node-cache`.

## Verification

- `cd server && npm test` passes, including the new nodeApi and agent tests, and `COMPUTE=local` still runs a full pipeline on one box.
- **Search parity:** after migration, MCP `find_in_lectures` on the Mac returns the same top hits as before for 3–4 known queries, and the vector cosine is > 0.9999.
- **End to end:** with the PC node running, press retry for cut and for transcribe on one short lecture in the dashboard.
  - The node claims both, downloads the original once and uploads.
  - On the Mac, the cut file and timeline appear in `cutted/`, the session page plays the cut with the transcript in sync, and index re-runs on the Mac.
- **PC off:** stop the node and trigger a retry.
  - The dashboard shows "waiting for PC" and "Compute PC: offline".
  - Start the node again and the job runs.
- **Mid-job shutdown:** kill the node during a cut. After the lease expires (shorten `NODE_LEASE_SEC` for the test) the job is queued again, and a restarted node finishes it.
- **Broken link:** unplug the cable during a cut upload and plug it back in within a minute or two. The upload resumes from where it stopped.
- **Security:**
  - a wrong `NODE_TOKEN` gets 404 on the LAN listener
  - `https://lectures.tukeel.online/node/claim` gets 404 even with the right token: the node API isn't on the public side
  - `http://<mac-lan-ip>:3102/d/<ACCESS_TOKEN>/` gets 404, because the LAN listener serves only `/node`
- **Reboot the Mac:** embed, worker and web come back without anyone logging in (if LaunchDaemons were used), the existing tunnel serves `lectures.tukeel.online` again, and the PC node reconnects on its own.
