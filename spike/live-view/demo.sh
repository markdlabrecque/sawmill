#!/usr/bin/env bash
# SPIKE output for #28. Starts two fake millyards and one viewer.
#   spike/live-view/demo.sh web   # then open http://127.0.0.1:4444
#   spike/live-view/demo.sh tui
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d dist/src ] || npm run build --silent
trap 'kill 0' EXIT
node --no-warnings spike/live-view/simulate.ts islandhealth --tick 2500 &
node --no-warnings spike/live-view/simulate.ts registry --tick 4000 --logjam &
sleep 0.5
case "${1:-web}" in
  web) node --no-warnings spike/live-view/web.ts --port "${PORT:-4444}" ;;
  tui) node --no-warnings spike/live-view/tui.ts ;;
  *) echo "usage: demo.sh web|tui" >&2; exit 1 ;;
esac
