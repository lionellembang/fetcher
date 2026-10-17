"""Text embeddings for search (multilingual-e5 by default), on the CPU.

Shared by the transcriber (server.py, next to Whisper) and the embedding-only
server (embed_server.py, on a hub that doesn't transcribe). Needs only torch,
numpy, pydantic/fastapi and, once the model loads, sentencepiece,
huggingface_hub and transformers: nothing Whisper.

POST /embed  JSON {texts: [...], kind: "query"|"passage"} -> {model, dim, vectors}
"""
import os
import threading

import numpy as np
import torch
from fastapi import HTTPException
from pydantic import BaseModel

EMBED_MODEL = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-base")
EMBED_MAX_TEXTS = 256

_embedder = None
_embed_lock = threading.Lock()  # separate from Whisper's lock: search works while a transcription runs


class SentencePieceE5:
    """multilingual-e5 without sentence-transformers, for RAM: transformers' tokenizer
    for its 250k-word vocabulary holds ~360 MB and importing sentence-transformers
    another ~150 MB, while sentencepiece runs the same 5 MB model in a few MB. Same
    token ids (checked on every indexed chunk), mean pooling and normalisation as
    the model's sentence-transformers config, so the vectors are the same too."""

    MAX_TOKENS = 512
    BOS, PAD, EOS, UNK = 0, 1, 2, 3  # XLM-R's ids; sentencepiece's own are shifted by one

    def __init__(self, name: str):
        import sentencepiece
        from huggingface_hub import hf_hub_download
        from transformers import AutoModel

        self.sp = sentencepiece.SentencePieceProcessor(model_file=hf_hub_download(name, "sentencepiece.bpe.model"))
        self.model = AutoModel.from_pretrained(name).eval()  # weights are memory-mapped from the HF cache

    def _ids(self, text: str) -> list[int]:
        pieces = [i + 1 if i else self.UNK for i in self.sp.encode(text)]
        return [self.BOS, *pieces[: self.MAX_TOKENS - 2], self.EOS]

    def encode(self, texts: list[str], batch_size: int = 16, **_) -> np.ndarray:
        all_ids = [self._ids(t) for t in texts]
        order = sorted(range(len(texts)), key=lambda i: -len(all_ids[i]))  # similar lengths share a batch: less padding
        out = []
        for i in range(0, len(order), batch_size):
            batch = [all_ids[j] for j in order[i : i + batch_size]]
            width = max(map(len, batch))
            ids = torch.tensor([b + [self.PAD] * (width - len(b)) for b in batch])
            mask = torch.tensor([[1] * len(b) + [0] * (width - len(b)) for b in batch])
            with torch.inference_mode():
                hidden = self.model(input_ids=ids, attention_mask=mask).last_hidden_state
            m = mask.unsqueeze(-1).to(hidden.dtype)
            mean = (hidden * m).sum(1) / m.sum(1).clamp(min=1e-9)
            out.append(torch.nn.functional.normalize(mean, dim=-1).numpy())
        vecs = np.empty((len(texts), out[0].shape[1]), dtype=np.float32)
        vecs[order] = np.concatenate(out)
        return vecs


def get_embedder():
    """Load the embedding model on first use, so it costs no RAM until search is used."""
    global _embedder
    if _embedder is None:
        if "multilingual-e5" in EMBED_MODEL:
            _embedder = SentencePieceE5(EMBED_MODEL)
        else:
            from sentence_transformers import SentenceTransformer

            _embedder = SentenceTransformer(EMBED_MODEL, device="cpu")
    return _embedder


def is_loaded() -> bool:
    return _embedder is not None


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: str = "passage"


def embed(req: EmbedRequest):
    """Normalised embeddings. e5 models expect a "query: " / "passage: " prefix, added here."""
    if req.kind not in {"query", "passage"}:
        raise HTTPException(400, "kind must be query or passage")
    if not req.texts or len(req.texts) > EMBED_MAX_TEXTS:
        raise HTTPException(400, f"send 1-{EMBED_MAX_TEXTS} texts")
    texts = [f"{req.kind}: {t}" for t in req.texts] if "e5" in EMBED_MODEL else req.texts
    with _embed_lock:
        vecs = get_embedder().encode(texts, normalize_embeddings=True, batch_size=16, convert_to_numpy=True)
    return {"model": EMBED_MODEL, "dim": int(vecs.shape[1]), "vectors": vecs.astype(np.float32).tolist()}
