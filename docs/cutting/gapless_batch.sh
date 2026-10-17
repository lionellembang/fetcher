#!/bin/bash
# Silence-cut every lecture recording with auto-editor (the engine behind Gapless).
#
#   usage: bash gapless_batch.sh [RECORDINGS_DIR]      (default: ~/Recordings)
#
# Reads   RECORDINGS_DIR/*.mp4  (skips *cutted.mp4 and *_ALTERED.mp4)
# Writes  RECORDINGS_DIR/cutted/"<name> cutted.mp4"   (replaces existing cuts)
# Logs and resume state live next to this script in logs/ and state/.
# Originals are never modified. An existing cut is only replaced once the
# new one finished. Re-running skips files already done with these settings.

EDIT="audio:-30dB"
MARGIN="0.3s,0.5s"
TEST="CN 1.mp4"          # known-good file (has audio) used as a smoke test

HERE="$(cd "$(dirname "$0")" && pwd)"
REC="${1:-$HOME/Recordings}"
cd "$REC" || { echo "ERROR: recordings folder not found: $REC"; exit 1; }
mkdir -p cutted "$HERE/logs" "$HERE/state"
LOG="$HERE/logs/gapless_reprocess.log"
DONE="$HERE/state/reprocessed_${EDIT}_${MARGIN}"
touch "$DONE"

# --- locate auto-editor (PATH first, then inside Gapless.app, then Homebrew) ---
AE="$(command -v auto-editor 2>/dev/null)"
if [ -z "$AE" ]; then
  for app in "/Applications/Gapless.app" "$HOME/Applications/Gapless.app"; do
    [ -d "$app" ] || continue
    AE="$(find "$app" -type f -name 'auto-editor*' -perm +111 2>/dev/null | head -n 1)"
    [ -n "$AE" ] && break
  done
fi
for p in /opt/homebrew/bin/auto-editor /usr/local/bin/auto-editor; do
  [ -z "$AE" ] && [ -x "$p" ] && AE="$p"
done
if [ -z "$AE" ]; then
  echo "ERROR: couldn't find auto-editor. Nothing was processed."; exit 1
fi
echo "Using auto-editor: $AE  (--edit $EDIT --margin $MARGIN) on $REC" | tee -a "$LOG"

SILENT=(); FAILED=()
process() {  # $1 = original file name. returns 0 ok, 1 failed, 2 silent
  local f="$1" b="${1%.mp4}"
  local out="cutted/$b cutted.mp4" tmp="cutted/.partial_$b cutted.mp4" txt="cutted/.partial_$b.txt"
  if grep -qxF "$f" "$DONE"; then echo "skip (already done): $f" | tee -a "$LOG"; return 0; fi
  echo "[$(date +%H:%M:%S)] processing: $f" | tee -a "$LOG"
  rm -f "$tmp"
  "$AE" "$f" --edit "$EDIT" --margin "$MARGIN" --no-open -o "$tmp" >"$txt" 2>&1
  local rc=$?
  # keep the log small: drop progress-bar lines
  tr '\r' '\n' < "$txt" | grep -av -e '⏳' -e '^ *$' | tail -n 20 >> "$LOG"
  if [ $rc -eq 0 ] && [ -s "$tmp" ] && [ "$(stat -f%z "$tmp")" -gt 100000 ]; then
    mv -f "$tmp" "$out"; rm -f "$txt"
    echo "$f" >> "$DONE"
    echo "[$(date +%H:%M:%S)]   done -> $out" | tee -a "$LOG"
    return 0
  fi
  rm -f "$tmp"
  if grep -aq "Timeline is empty" "$txt"; then
    rm -f "$txt"
    echo "[$(date +%H:%M:%S)]   SKIPPED (silent): nothing in $f is louder than ${EDIT#audio:}" | tee -a "$LOG"
    SILENT+=("$f"); return 2
  fi
  rm -f "$txt"
  echo "[$(date +%H:%M:%S)]   FAILED: $f (old cut, if any, left untouched; see $LOG)" | tee -a "$LOG"
  FAILED+=("$f"); return 1
}

# --- discover: every original recording (not cuts, not _ALTERED) ---
TODO=()
for f in *.mp4; do
  [ -e "$f" ] || continue
  b="${f%.mp4}"
  case "$b" in *cutted|*_ALTERED) continue ;; esac
  TODO+=("$f")
done

# --- 1) smoke test ---
if [ -e "$TEST" ]; then
  echo "=== Test run on \"$TEST\" ===" | tee -a "$LOG"
  process "$TEST"
  if [ $? -ne 0 ]; then echo "Test failed — stopping before touching anything else."; exit 1; fi
  echo "Test OK. Continuing with the rest..."
fi

# --- 2) the rest ---
ok=0
for f in "${TODO[@]}"; do
  process "$f" && ok=$((ok+1))
done
echo "=== Finished: $ok done, ${#SILENT[@]} silent (skipped), ${#FAILED[@]} failed. Outputs in $REC/cutted ===" | tee -a "$LOG"
[ ${#SILENT[@]} -gt 0 ] && printf '  silent: %s\n' "${SILENT[@]}" | tee -a "$LOG"
[ ${#FAILED[@]} -gt 0 ] && printf '  failed: %s\n' "${FAILED[@]}" | tee -a "$LOG"
exit 0
