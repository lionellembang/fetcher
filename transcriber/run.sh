#!/usr/bin/env bash
# Start the Whisper server. Override with e.g. WHISPER_MODEL=turbo PORT=9000 ./run.sh
# VENV points at the Python environment (default ./.venv); it must have requirements.txt installed.
set -euo pipefail
cd "$(dirname "$0")"
VENV="${VENV:-$PWD/.venv}"
export PATH="$VENV/bin:$PATH"   # picks up the bundled ffmpeg
# faster-whisper (CTranslate2) needs CUDA 12's cuBLAS (libcublas.so.12), which PyTorch's
# CUDA 13 venv doesn't have. It lives in ./.cuda12 (see requirements.txt), outside the
# venv, because the cuDNN packages for 12 and 13 both install libcudnn.so.9 in the same
# place. (In practice CTranslate2 uses the cuDNN 9 PyTorch already loaded; the one in
# ./.cuda12 is only a fallback.)
for lib in "$PWD"/.cuda12/nvidia/*/lib; do
  [ -d "$lib" ] && LD_LIBRARY_PATH="$lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
done
export LD_LIBRARY_PATH
export WHISPER_MODEL="${WHISPER_MODEL:-large-v3}"
exec "$VENV/bin/python" -m uvicorn server:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
