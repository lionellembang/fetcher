#!/usr/bin/env bash
# Start the embedding-only server (search on a hub; see embed_server.py).
# Override with e.g. PORT=8001 ./run-embed.sh. VENV points at the Python
# environment (default ./.venv-embed); it must have requirements-embed.txt installed.
set -euo pipefail
cd "$(dirname "$0")"
VENV="${VENV:-$PWD/.venv-embed}"
# embedding.py is shared with the compute node's transcriber
export PYTHONPATH="$PWD/../../shared/embedding${PYTHONPATH:+:$PYTHONPATH}"
exec "$VENV/bin/python" -m uvicorn embed_server:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
