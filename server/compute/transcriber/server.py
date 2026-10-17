"""Minimal HTTP server around Whisper (faster-whisper / CTranslate2), plus text
embeddings for search.

POST /jobs         multipart: file=<audio/video>, key, optional language, task, model,
                   vad, gate_db -> {id, status}. Queues a transcription and returns at
                   once; a job with the same key that is queued, running or done is
                   returned instead of starting another.
GET  /jobs/{id}    -> {id, status: queued|running|done|failed, result (when done), error}
POST /transcribe   multipart, same fields plus format (json|text|srt|vtt); waits for the
                   result in the same request (fine for short files and transcribe.sh)
POST /embed        JSON {texts: [...], kind: "query"|"passage"} -> normalised vectors
GET  /health

Whisper is loaded when a transcription starts and unloaded again once none has
run for WHISPER_KEEP_S seconds (default 120), so it only holds VRAM (~3.8 GB for
large-v3) while there is work. The CUDA context (~200 MB) stays once created.
"""
import gc
import os
import queue
import shutil
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
import whisper  # openai-whisper: audio loading and the SRT/VTT writers only
from faster_whisper import WhisperModel, available_models
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from silero_vad import get_speech_timestamps, load_silero_vad
from whisper.utils import get_writer

import embedding  # search embeddings (CPU): server/shared/embedding, on PYTHONPATH via run.sh

DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "turbo")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "float16" if DEVICE == "cuda" else "int8")
# Greedy decoding with temperature fallback, as openai-whisper did by default.
TEMPERATURES = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]

_models: dict[str, WhisperModel] = {}
_lock = threading.Lock()  # one GPU job at a time; also guards loading/unloading _models
WHISPER_KEEP_S = float(os.environ.get("WHISPER_KEEP_S", "120"))
_last_used = 0.0  # when a transcription last finished
_vad = load_silero_vad()

JOB_KEEP_S = 2 * 3600  # finished jobs (and their results) are forgotten after this
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_job_queue: queue.Queue = queue.Queue()

SAMPLE_RATE = 16000
MERGE_GAP_S = 2.0  # merge speech regions separated by less than this
MIN_CLIP_S = 0.3


def _db(x) -> float:
    return 20 * float(np.log10(np.sqrt(np.mean(x**2)) + 1e-9))


def speech_clips(audio, gate_db: float) -> list[float]:
    """Return [start, end, start, end, ...] in seconds covering only the main speaker.

    Silero VAD finds speech; spans more than `gate_db` quieter than the file's main
    speaking level (duration-weighted 90th percentile) are dropped, which removes
    quiet background chatter that VAD counts as speech. gate_db <= 0 disables this.
    """
    spans = get_speech_timestamps(
        torch.from_numpy(audio), _vad, sampling_rate=SAMPLE_RATE,
        min_silence_duration_ms=500, speech_pad_ms=300, return_seconds=True,
    )
    if gate_db > 0 and spans:
        levels = np.array([_db(audio[int(sp["start"] * SAMPLE_RATE): int(sp["end"] * SAMPLE_RATE)]) for sp in spans])
        durs = np.array([sp["end"] - sp["start"] for sp in spans])
        order = np.argsort(levels)
        ref = levels[order][np.searchsorted(np.cumsum(durs[order]) / durs.sum(), 0.9)]
        spans = [sp for sp, lv in zip(spans, levels) if lv >= ref - gate_db]
    merged: list[list[float]] = []
    for sp in spans:
        if merged and sp["start"] - merged[-1][1] < MERGE_GAP_S:
            merged[-1][1] = sp["end"]
        else:
            merged.append([sp["start"], sp["end"]])
    # Keep every clip inside the last 10 ms mel frame. If speech runs to the very
    # end and the file isn't a whole number of frames, the last clip ends past it
    # (e.g. 6036.096 s → frame 603610 of 603609); openai-whisper then looped forever
    # on an empty window at the end of the audio. faster-whisper clamps this itself;
    # the clamp stays as a belt-and-braces.
    last = (len(audio) // whisper.audio.HOP_LENGTH) / whisper.audio.FRAMES_PER_SECOND
    merged = [[a, min(b, last)] for a, b in merged]
    return [t for a, b in merged if b - a >= MIN_CLIP_S for t in (a, b)]


MAX_SAME_WINDOW = 12  # a window is encoded once per step, so this is already generous


def _guard_against_loops(model: WhisperModel) -> None:
    """Fail a transcription that keeps encoding the identical window instead of moving on.

    openai-whisper once decoded the same empty window at the end of a lecture for 4+
    hours, holding the GPU. A thread can't be killed, so raise from inside encode
    once the same input repeats more than MAX_SAME_WINDOW times in a row; the job
    then fails with a clear error instead of hanging. (With vad=False, 6+ minutes
    of exact digital silence would also trip it; with VAD, as the pipeline uses it,
    silence is never sent to Whisper.)
    """
    encode = model.encode
    state = {"prev": None, "repeats": 0}

    def guarded(features):
        prev = state["prev"]
        if prev is not None and prev.shape == features.shape and np.array_equal(prev, features):
            state["repeats"] += 1
            if state["repeats"] > MAX_SAME_WINDOW:
                state["prev"], state["repeats"] = None, 0
                raise RuntimeError(f"Whisper stopped advancing (the same window {MAX_SAME_WINDOW}+ times in a row)")
        else:
            state["prev"], state["repeats"] = np.array(features, copy=True), 0
        return encode(features)

    model.encode = guarded


def get_model(name: str) -> WhisperModel:
    """The model, loaded if it isn't. Call with _lock held."""
    if name not in _models:
        t = time.time()
        model = WhisperModel(name, device=DEVICE, compute_type=COMPUTE_TYPE)
        _guard_against_loops(model)
        _models[name] = model
        print(f"Loaded Whisper {name} in {time.time() - t:.1f}s", flush=True)
    return _models[name]


def unload_idle_models() -> None:
    """Free the VRAM of models no transcription has used for WHISPER_KEEP_S."""
    if not _models or time.time() - _last_used < WHISPER_KEEP_S or not _lock.acquire(blocking=False):
        return
    try:
        for name, model in list(_models.items()):
            model.model.unload_model()  # frees the weights now, not whenever gc gets to them
            del _models[name]
            print(f"Unloaded Whisper {name} (idle {WHISPER_KEEP_S:.0f}s)", flush=True)
        gc.collect()
    finally:
        _lock.release()


def _whisper(src: Path, language, task, model, vad, gate_db) -> dict:
    audio = whisper.load_audio(str(src))
    opts = dict(
        language=language, task=task, beam_size=1, temperature=TEMPERATURES,
        condition_on_previous_text=False,  # stops one bad segment poisoning the rest
        vad_filter=False,  # we choose the speech ourselves (speech_clips)
    )
    clips = speech_clips(audio, gate_db) if vad else "0"
    if not clips:
        return {"text": "", "segments": [], "language": language}
    segments, info = get_model(model).transcribe(audio, clip_timestamps=clips, **opts)
    segs = [
        {"id": s.id, "start": s.start, "end": s.end, "text": s.text, "avg_logprob": s.avg_logprob,
         "no_speech_prob": s.no_speech_prob, "compression_ratio": s.compression_ratio, "temperature": s.temperature}
        for s in segments  # a generator: the work happens here
    ]
    return {"text": "".join(s["text"] for s in segs), "segments": segs, "language": info.language}


def run_transcription(src: Path, language, task, model, vad, gate_db) -> dict:
    """Whisper result ({text, language, segments[]}, openai-whisper's shape) for an
    audio/video file. Raises RuntimeError if it can't be decoded."""
    global _last_used
    with _lock:
        try:
            result = _whisper(src, language, task, model, vad, gate_db)
        finally:
            _last_used = time.time()

    # drop blank segments and likely no-speech hallucinations
    result["segments"] = [
        sg for sg in result["segments"]
        if sg["text"].strip() and not (sg["no_speech_prob"] > 0.6 and sg["avg_logprob"] < -1.0)
    ]
    return result


def _job_worker() -> None:
    while True:
        try:
            job = _job_queue.get(timeout=10)
        except queue.Empty:
            unload_idle_models()
            continue
        job["status"], job["started"] = "running", time.time()
        try:
            job["result"] = run_transcription(job["path"], **job["opts"])
            job["status"] = "done"
        except Exception as e:  # decode failure, CUDA error, ...
            job["status"], job["error"] = "failed", f"{type(e).__name__}: {e}"
        finally:
            job["finished"] = time.time()
            shutil.rmtree(job["dir"], ignore_errors=True)


def _job_view(job: dict, with_result: bool = False) -> dict:
    out = {k: job.get(k) for k in ("id", "key", "status", "error", "queued", "started", "finished")}
    if job["status"] == "queued":
        out["ahead"] = sum(1 for j in _jobs.values() if j["status"] in ("queued", "running") and j["queued"] < job["queued"])
    if with_result and job["status"] == "done":
        out["result"] = job["result"]
    return out


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Uploads of jobs that were queued or running when the server last stopped.
    for stale in Path(tempfile.gettempdir()).glob("transcribe-job-*"):
        shutil.rmtree(stale, ignore_errors=True)
    threading.Thread(target=_job_worker, name="transcribe-jobs", daemon=True).start()
    yield


app = FastAPI(title="Whisper server", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "loaded_models": list(_models),  # Whisper: only while transcribing (+ WHISPER_KEEP_S)
        "whisper_keep_s": WHISPER_KEEP_S,
        "embed_model": embedding.EMBED_MODEL,
        "embed_loaded": embedding.is_loaded(),
        "jobs": {s: sum(1 for j in _jobs.values() if j["status"] == s) for s in ("queued", "running", "done", "failed")},
    }


# Embeddings run on the CPU, so they never compete with Whisper for the GPU.
app.post("/embed")(embedding.embed)


def _check(task: str, model: str) -> None:
    if task not in {"transcribe", "translate"}:
        raise HTTPException(400, "task must be transcribe or translate")
    if model not in available_models():
        raise HTTPException(400, f"unknown model {model}")


def _save_upload(file: UploadFile, folder: Path) -> Path:
    src = folder / (Path(file.filename or "input").name or "input")
    with open(src, "wb") as f:
        while chunk := file.file.read(1 << 20):
            f.write(chunk)
    return src


@app.post("/jobs")
def create_job(
    file: UploadFile = File(...),
    key: str = Form(...),
    language: str | None = Form(None),
    task: str = Form("transcribe"),
    model: str = Form(DEFAULT_MODEL),
    vad: bool = Form(True),
    gate_db: float = Form(12.0),
):
    _check(task, model)
    now = time.time()
    with _jobs_lock:
        for jid in [j["id"] for j in _jobs.values() if j.get("finished") and now - j["finished"] > JOB_KEEP_S]:
            del _jobs[jid]
        for j in _jobs.values():
            if j["key"] == key and j["status"] != "failed":
                return _job_view(j)  # already queued / running / done
    folder = Path(tempfile.mkdtemp(prefix="transcribe-job-"))
    job = {
        "id": uuid.uuid4().hex, "key": key, "status": "queued", "queued": now, "dir": folder,
        "path": _save_upload(file, folder),
        "opts": dict(language=language, task=task, model=model, vad=vad, gate_db=gate_db),
    }
    with _jobs_lock:
        _jobs[job["id"]] = job
    _job_queue.put(job)
    return _job_view(job)


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "no such job (finished long ago, or the server restarted)")
    return _job_view(job, with_result=True)


@app.post("/transcribe")
def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(None),
    task: str = Form("transcribe"),
    model: str = Form(DEFAULT_MODEL),
    format: str = Form("json"),
    vad: bool = Form(True),
    gate_db: float = Form(12.0),
):
    if format not in {"json", "text", "srt", "vtt"}:
        raise HTTPException(400, "format must be json, text, srt or vtt")
    _check(task, model)

    with tempfile.TemporaryDirectory() as tmp:
        src = _save_upload(file, Path(tmp))
        try:
            result = run_transcription(src, language, task, model, vad, gate_db)
        except RuntimeError as e:  # ffmpeg decode failure, etc.
            raise HTTPException(422, str(e))

        if format == "json":
            return result
        if format == "text":
            return PlainTextResponse(result["text"].strip() + "\n")
        get_writer(format, tmp)(result, src.name)
        return PlainTextResponse((Path(tmp) / f"{src.stem}.{format}").read_text())
