# Lecture transcription server

> Part of **fetcher**: `scripts/start.sh` starts this server for the pipeline,
> which sends 16 kHz FLAC of each recording and also uses `/embed` for search.

A local HTTP server that turns lecture recordings into subtitles with Whisper `large-v3` on an NVIDIA GPU, run with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2). It skips silence and quiet background chatter before transcribing, which stops Whisper from inventing text on non-speech.

Built for Indonesian university lectures (with English technical terms) on WSL2, but it accepts any audio or video file that ffmpeg can decode.

## Quick start

```bash
# 1. Create the environment (Python 3.12; PyTorch does not support 3.14)
uv venv --python 3.12 .venv
UV_HTTP_TIMEOUT=600 UV_HTTP_RETRIES=5 uv pip install --python .venv/bin/python -r requirements.txt

# 2. Give Whisper an ffmpeg without needing sudo
ln -s "$(.venv/bin/python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" .venv/bin/ffmpeg

# 3. Start the server (the first start downloads the 2.9 GB model)
mkdir -p logs
(WHISPER_MODEL=large-v3 nohup ./run.sh > logs/server.log 2>&1 &)
until curl -sf -m 2 localhost:8000/health; do sleep 3; done

# 4. Transcribe
./transcribe.sh -l id "lecture.mp4"     # writes output/subtitles/lecture.srt
```

The default model in `run.sh` is `large-v3`; set `WHISPER_MODEL=turbo` for speed. `VENV` picks the Python environment (default `./.venv`).

## Repository layout

| Path | What it is |
| --- | --- |
| `server.py` | FastAPI server: VAD, loudness gate, Whisper, segment filter |
| `run.sh` | Starts the server; puts `.venv/bin` (and its ffmpeg) on PATH; reads `WHISPER_MODEL`, `HOST`, `PORT` |
| `transcribe.sh` | Client: uploads each file and writes `<name>.srt` to `$OUT` (default `output/subtitles`) |
| `requirements.txt` | Pinned Python dependencies |
| `.venv/`, `logs/`, `output/` | Environment, logs and results; not tracked by git |

## Usage

### Batch over a folder

Resumable: files that already have a non-empty `.srt` are skipped, and a failed file leaves no output, so it is redone on the next run.

```bash
cd /path/to/videos && (nohup bash -c 'for f in *.mp4; do [ -s "$HOME/transcription/output/subtitles/${f%.mp4}.srt" ] || ~/transcription/transcribe.sh -l id "$f"; done' > ~/transcription/logs/transcribe-all.log 2>&1 &)
tail -f ~/transcription/logs/transcribe-all.log
```

To redo a file, delete its `.srt` and rerun the loop. An empty folder makes the loop exit silently, so check the path if nothing happens.

### Stop everything

Bracket the first letter of each pattern. Without that, `pkill -f` also matches the shell running it and kills that shell.

```bash
pkill -f "[t]ranscribe.sh"; pkill -f "[c]url -sf --max-time"; pkill -f "[u]vicorn server:app"
```

### Check the GPU is used

- `curl localhost:8000/health` reports `"device":"cuda"`.
- `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` lists the uvicorn PID (under WSL the memory column reads `[N/A]`).
- During inference, expect roughly 20–55% GPU utilization. The first seconds of each file run on the CPU (decode and VAD).

## API

No authentication, on `127.0.0.1:8000` by default (set `HOST=0.0.0.0` to expose it).

**`POST /jobs`** takes the same multipart fields as `/transcribe` (minus `format`) plus a `key`, queues the work and returns `{id, status}` at once. A job with the same `key` that is queued, running or done is returned instead of starting another, so a client can resubmit safely. **`GET /jobs/{id}`** returns `{status: queued|running|done|failed, ahead, error}` and, when done, `result` (the JSON below). Jobs live in memory for 2 h after finishing and are lost on restart (`404`). The pipeline uses this, because a lecture takes ~20 min and a single HTTP request that long hits client timeouts.

**`GET /health`** returns `{"status":"ok","device":"cuda","loaded_models":["large-v3"],"embed_model":"…","embed_loaded":false}` once the model has loaded.

**`POST /embed`** takes JSON `{"texts": [...], "kind": "query"|"passage"}` (1–256 texts) and returns `{"model", "dim", "vectors"}`, normalised. The model (`EMBED_MODEL`, default `intfloat/multilingual-e5-base`) runs on the CPU because large-v3 fills the GPU, loads on first use, and has its own lock, so it answers while a transcription runs. e5's `query: `/`passage: ` prefixes are added for you.

**`POST /transcribe`** (waits for the result in the same request; fine for short files and `transcribe.sh`) takes `multipart/form-data`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `file` | file | required | Any audio or video ffmpeg can decode |
| `language` | string | auto-detect | ISO code, e.g. `id` |
| `task` | string | `transcribe` | `transcribe` or `translate` (to English) |
| `model` | string | `$WHISPER_MODEL` | Any Whisper model name; loaded on first use and kept in VRAM |
| `format` | string | `json` | `json`, `text`, `srt` or `vtt` |
| `vad` | bool | `true` | `false` sends the whole file to Whisper, skipping VAD and the gate |
| `gate_db` | float | `12.0` | Drop speech this many dB quieter than the main speaker; `0` disables the gate |

`json` returns Whisper's result (`text`, `language`, and `segments[]` with `start`, `end`, `text`, `avg_logprob`, `no_speech_prob`); the other formats return plain text. Errors: `400` for a bad `format` or `task`, `422` when the file cannot be decoded.

```bash
curl -F file=@lecture.mp4 -F language=id -F format=srt localhost:8000/transcribe -o lecture.srt
```

When calling it from other code, send one request at a time (the server serialises them on a lock), size the client timeout to the audio length (7200 s covers an 81-minute lecture), and request `json` if you want per-segment confidence for quality checks.

## How it works

Each request goes through these steps in `server.py`; timestamps always refer to the uploaded file's own timeline.

1. **Decode.** ffmpeg converts the upload to 16 kHz mono PCM, held in RAM (about 230 MB per hour).
2. **Find speech.** Silero VAD (`min_silence_duration_ms=500`, `speech_pad_ms=300`).
3. **Loudness gate.** Each speech span gets an RMS level. The main speaker's level is the duration-weighted 90th percentile; spans more than `gate_db` below it are dropped. This removes background chatter, which VAD rightly counts as speech.
4. **Merge.** Spans less than 2.0 s apart are joined; clips under 0.3 s are dropped. If nothing is left, Whisper is not called.
5. **Transcribe.** Whisper decodes only those regions via `clip_timestamps`, with `condition_on_previous_text=False` and fp16 on CUDA.
6. **Filter.** Blank segments are dropped, and so are segments with both `no_speech_prob > 0.6` and `avg_logprob < -1.0`.
7. **Format.** JSON as is; `srt`, `vtt` and `text` via Whisper's writers.

### Why these choices

| Choice | Reason |
| --- | --- |
| `large-v3`, not `turbo` | Highest accuracy; `turbo` is a distilled `large-v3` |
| `condition_on_previous_text=False` | Otherwise one hallucinated segment feeds the next; a lecture's silent opening came out as "Terima kasih." repeated in 30 s blocks |
| VAD + `clip_timestamps` | Whisper invents text on non-speech; skipping it also made transcription faster |
| 12 dB loudness gate | VAD alone passed pre-lecture chatter at −36 to −45 dBFS; the lecturer sat at −20 to −25 dBFS |
| Language forced to `id` | Lectures are Indonesian; English terms still come out correctly |

Checked over four full lectures, the 12 dB gate removed 2–10% of detected speech: the pre-lecture chatter, plus short quiet fragments. Its cost is that quiet real speech, such as a question from the back of the room, can be cut. Lower `gate_db` (e.g. 10) if chatter still leaks through; raise it (e.g. 15) if questions go missing.

## Performance

On an RTX 5070, `large-v3` with VAD now runs at about 15× real time on faster-whisper (float16, greedy), so one hour of lecture takes roughly 4–5 minutes and uses ~6.4 GB of VRAM. Measured on the same 20-minute excerpt (14.5 min of speech):

| Engine | Time | Speed | Peak VRAM | Words differing from openai-whisper |
| --- | --- | --- | --- | --- |
| openai-whisper | 215 s | 5.6× | 11.4 GB | — |
| faster-whisper, sequential (used) | 82 s | 14.7× | 6.4 GB | 1.4% |
| faster-whisper, batched ×16 | 17 s | 70× | 9.1 GB | 13% (drops real phrases; not used) |

openai-whisper was slow because its decoding loop is single-threaded Python: one CPU core sat at 100% while the GPU idled at 20–30%. The older numbers below are openai-whisper's.

| Lecture | Length | No VAD | VAD + gate |
| --- | --- | --- | --- |
| BDA 1 | 61:01 | 1143 s (3.2×) | 759 s (4.8×) |
| BDA 2 | 58:42 | 950 s (3.7×) | 735 s (4.8×) |
| BDA 3 | 49:07 | 558 s (5.3×) | 523 s (5.6×) |

Times are wall clock per file, including upload over localhost, decode and VAD.

## Tested environment

| Item | Value |
| --- | --- |
| OS | Ubuntu 26.04.1 LTS on WSL2 |
| GPU | NVIDIA GeForce RTX 5070, 12 GB, compute capability 12.0; Windows driver 617.14 (CUDA comes from the driver via `/usr/lib/wsl/lib`) |
| Python | 3.12, managed with uv |
| PyTorch | 2.14.1 (PyPI CUDA 13 build; works on sm_120) |
| openai-whisper / silero-vad | 20250625 / 6.2.3 |
| FastAPI / uvicorn | 0.143.0 / 0.54.0 |
| ffmpeg | 7.0.2 static, from `imageio-ffmpeg` |

`large-v3` uses about 11.6 of the 12 GB VRAM, so do not load a second model or run other GPU-heavy apps alongside it.

## Known issues

- **Does not survive a WSL restart.** The server and batch jobs stop silently. Check `/health` before assuming it is up; a systemd user service would fix this.
- **Very quiet recordings transcribe badly.** A file averaging about −36 dB came out as gibberish. Normalising loudness first (ffmpeg `loudnorm`) is the likely fix.
- **Short stray words remain**, such as a lone "Halo" from a burst of chatter that passes the gate.
- **Outputs are keyed by file name.** If an input is replaced under the same name, the old `.srt` is kept; delete it to redo the file.
- **Whole videos are uploaded.** Sending 16 kHz mono audio instead would cut the transfer size a lot; the server accepts it unchanged.
- **No authentication.** Bind to `127.0.0.1` unless you need remote access. WSL2 only exposes ports to Windows localhost by default.
- **Deprecated startup hook.** `@app.on_event("startup")` should move to a FastAPI `lifespan` handler.

## To do

- [ ] Run the server as a supervised service bound to `127.0.0.1`
- [ ] Write `.json` next to every `.srt`
- [ ] Fail loudly when the batch input list is empty
- [ ] Decide whether all courses are Indonesian or some need auto-detect
