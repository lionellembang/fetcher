#!/usr/bin/env bash
# Start the Whisper server. Override with e.g. WHISPER_MODEL=large-v3 PORT=9000 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
VENV="$PWD/.venv"
export PATH="$VENV/bin:$PATH"   # picks up the bundled ffmpeg
export WHISPER_MODEL="${WHISPER_MODEL:-turbo}"
exec "$VENV/bin/python" -m uvicorn server:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}"
