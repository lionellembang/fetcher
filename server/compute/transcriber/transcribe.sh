#!/usr/bin/env bash
# Transcribe videos via the local Whisper server into output/subtitles as .srt
# Usage: ./transcribe.sh [-l language] video1.mp4 video2.mp4 ...
set -euo pipefail
LANG_OPT=""
if [[ "${1:-}" == "-l" ]]; then LANG_OPT="$2"; shift 2; fi
OUT="${OUT:-$(cd "$(dirname "$0")" && pwd)/output/subtitles}"
URL="${URL:-http://localhost:8000}"
mkdir -p "$OUT"
for f in "$@"; do
  name="$(basename "${f%.*}")"
  start=$(date +%s)
  curl -sf --max-time 7200 -F "file=@$f" -F format=srt ${LANG_OPT:+-F "language=$LANG_OPT"} \
    "$URL/transcribe" -o "$OUT/$name.srt"
  echo "$name: $(( $(date +%s) - start ))s -> $OUT/$name.srt"
done
