#!/usr/bin/env bash
# Start everything and follow the logs. Services now run detached and keep
# running when you press Ctrl-C (which only stops following the logs); use
# `scripts/fetcher stop` to stop them, or restart one part with e.g.
# `scripts/fetcher restart web`. See scripts/fetcher for all commands.
set -euo pipefail
F="$(dirname "$0")/fetcher"
"$F" start all
echo; echo "Following the logs. Ctrl-C stops following; services keep running."
exec "$F" logs
