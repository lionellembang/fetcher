"""Minimal HTTP server around OpenAI Whisper, plus text embeddings for search.

POST /transcribe   multipart: file=<audio/video>, optional form fields:
                   language, task (transcribe|translate), model, format (json|text|srt|vtt)
POST /embed        JSON {texts: [...], kind: "query"|"passage"} -> normalised vectors
GET  /health
"""
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
import whisper
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from silero_vad import get_speech_timestamps, load_silero_vad
from whisper.utils import get_writer

DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "turbo")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# Embeddings run on the CPU: large-v3 already fills ~11.6 of the GPU's 12 GB.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-base")
EMBED_MAX_TEXTS = 256

_models: dict[str, whisper.Whisper] = {}
_lock = threading.Lock()  # one GPU job at a time
_vad = load_silero_vad()
_embedder = None
_embed_lock = threading.Lock()  # separate from _lock: search works while a transcription runs

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
    return [t for a, b in merged if b - a >= MIN_CLIP_S for t in (a, b)]


def get_model(name: str) -> whisper.Whisper:
    if name not in _models:
        _models[name] = whisper.load_model(name, device=DEVICE)
    return _models[name]


def get_embedder():
    """Load the embedding model on first use, so it costs no RAM until search is used."""
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer

        _embedder = SentenceTransformer(EMBED_MODEL, device="cpu")
    return _embedder


@asynccontextmanager
async def lifespan(_app: FastAPI):
    get_model(DEFAULT_MODEL)
    yield


app = FastAPI(title="Whisper server", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "loaded_models": list(_models),
        "embed_model": EMBED_MODEL,
        "embed_loaded": _embedder is not None,
    }


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: str = "passage"


@app.post("/embed")
def embed(req: EmbedRequest):
    """Normalised embeddings. e5 models expect a "query: " / "passage: " prefix, added here."""
    if req.kind not in {"query", "passage"}:
        raise HTTPException(400, "kind must be query or passage")
    if not req.texts or len(req.texts) > EMBED_MAX_TEXTS:
        raise HTTPException(400, f"send 1-{EMBED_MAX_TEXTS} texts")
    texts = [f"{req.kind}: {t}" for t in req.texts] if "e5" in EMBED_MODEL else req.texts
    with _embed_lock:
        vecs = get_embedder().encode(texts, normalize_embeddings=True, batch_size=32, convert_to_numpy=True)
    return {"model": EMBED_MODEL, "dim": int(vecs.shape[1]), "vectors": vecs.astype(np.float32).tolist()}


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
    if task not in {"transcribe", "translate"}:
        raise HTTPException(400, "task must be transcribe or translate")

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / (Path(file.filename or "input").name or "input")
        with open(src, "wb") as f:
            while chunk := file.file.read(1 << 20):
                f.write(chunk)

        with _lock:
            try:
                audio = whisper.load_audio(str(src))
                opts = dict(
                    language=language, task=task, fp16=(DEVICE == "cuda"),
                    condition_on_previous_text=False,  # stops one bad segment poisoning the rest
                )
                if vad:
                    clips = speech_clips(audio, gate_db)
                    if not clips:
                        result = {"text": "", "segments": [], "language": language}
                    else:
                        result = get_model(model).transcribe(audio, clip_timestamps=clips, **opts)
                else:
                    result = get_model(model).transcribe(audio, **opts)
            except RuntimeError as e:  # ffmpeg decode failure, etc.
                raise HTTPException(422, str(e))

        # drop blank segments and likely no-speech hallucinations
        result["segments"] = [
            sg for sg in result["segments"]
            if sg["text"].strip() and not (sg["no_speech_prob"] > 0.6 and sg["avg_logprob"] < -1.0)
        ]

        if format == "json":
            return result
        if format == "text":
            return PlainTextResponse(result["text"].strip() + "\n")
        get_writer(format, tmp)(result, src.name)
        return PlainTextResponse((Path(tmp) / f"{src.stem}.{format}").read_text())
