#!/usr/bin/env bash
# Start everything, in order:
#   1. transcriber  (Whisper + search embeddings)   logs/transcriber.log
#   2. server       (scan, pipeline, dashboard, MCP) logs/server.log
#   3. cloudflared  (public HTTPS), if CLOUDFLARE_TUNNEL is set   logs/cloudflared.log
# Shows the server log. Ctrl-C stops all of them; if one dies, the rest stop too.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE: cp .env.example .env and fill it in."; exit 1; }
set -a; . "$ENV_FILE"; set +a
export PATH="$HOME/.local/bin:$PATH"

if [ "${#ACCESS_TOKEN}" -lt 32 ]; then
  echo "ACCESS_TOKEN is too short to put on the internet. Generate one with:"
  echo "  node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\""
  exit 1
fi
for tool in node ffmpeg ffprobe auto-editor curl; do
  command -v "$tool" >/dev/null || { echo "Missing $tool on PATH (see README → Setup)."; exit 1; }
done

mkdir -p logs
PIDS=()
TAIL=
cleanup() {
  trap - INT TERM EXIT
  echo; echo "Stopping …"
  [ -n "$TAIL" ] && kill "$TAIL" 2>/dev/null || true
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

# 1. transcriber
WHISPER_URL="${WHISPER_URL:-http://127.0.0.1:8000}"
if curl -sf -m 2 "$WHISPER_URL/health" >/dev/null; then
  echo "Transcriber already running at $WHISPER_URL (not managed by this script)."
else
  VENV="$(cd "$ROOT" && realpath -m "${TRANSCRIBER_VENV:-./transcriber/.venv}")"
  [ -x "$VENV/bin/python" ] || { echo "No Python environment at $VENV (set TRANSCRIBER_VENV)."; exit 1; }
  echo "Starting the transcriber (loading ${WHISPER_MODEL:-large-v3} takes a minute) …"
  PORT_W="${WHISPER_URL##*:}"; PORT_W="${PORT_W%%/*}"
  VENV="$VENV" HOST=127.0.0.1 PORT="$PORT_W" transcriber/run.sh >> logs/transcriber.log 2>&1 &
  PIDS+=($!)
  until curl -sf -m 2 "$WHISPER_URL/health" >/dev/null; do
    kill -0 "${PIDS[-1]}" 2>/dev/null || { echo "The transcriber exited; see logs/transcriber.log"; exit 1; }
    sleep 3
  done
  echo "Transcriber up."
fi

# 2. server
(cd server && exec node index.js) >> logs/server.log 2>&1 &
PIDS+=($!)

# 3. tunnel
if [ -n "${CLOUDFLARE_TUNNEL:-}" ]; then
  command -v cloudflared >/dev/null || { echo "CLOUDFLARE_TUNNEL is set but cloudflared isn't installed."; exit 1; }
  cloudflared tunnel --no-autoupdate run "$CLOUDFLARE_TUNNEL" >> logs/cloudflared.log 2>&1 &
  PIDS+=($!)
fi

echo
echo "Dashboard: ${PUBLIC_URL:-http://localhost:${PORT:-3100}}/d/<ACCESS_TOKEN>   (local: http://localhost:${PORT:-3100}/d/<ACCESS_TOKEN>)"
echo "MCP:       ${PUBLIC_URL:-http://localhost:${PORT:-3100}}/d/<ACCESS_TOKEN>/mcp"
echo "Ctrl-C stops everything. Server log follows:"
echo
tail -n 0 -F logs/server.log &
TAIL=$!

# Stop everything as soon as one service exits.
wait -n "${PIDS[@]}" || true
echo "A service exited; check logs/." >&2
