"""Embedding-only server for a hub that doesn't transcribe (COMPUTE=remote):
the same /embed and /health as the transcriber (server.py), without Whisper,
CUDA or the GPU. The server's EMBED_URL points here.

POST /embed  JSON {texts: [...], kind: "query"|"passage"} -> normalised vectors
GET  /health

The model loads on the first /embed, so it costs no RAM until search is used.
"""
from fastapi import FastAPI

import embedding

app = FastAPI(title="Embedding server")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": "cpu",
        "embed_model": embedding.EMBED_MODEL,
        "embed_loaded": embedding.is_loaded(),
    }


app.post("/embed")(embedding.embed)
