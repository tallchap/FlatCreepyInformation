#!/usr/bin/env bash
# One-shot Home-feed snapshot: signed-in check -> scrape -> enrich + append tab.
#
# Usage: ./pull.sh [tab-suffix] [--dry-run] [--open]
#   tab-suffix  e.g. post-watch  -> "Run N — YYYY-MM-DD post-watch"
#   --dry-run   scrape + fetch metadata, but do not write to the sheet
#   --open      open the new tab in the browser when done (macOS `open`)
set -euo pipefail
cd "$(dirname "$0")"

SUFFIX=""; DRY=""; OPEN=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY="--dry-run" ;;
    --open) OPEN=1 ;;
    *) SUFFIX="$a" ;;
  esac
done

[ -d node_modules ] || npm install --no-audit --no-fund

# The profile can only be driven by one Playwright instance: close our own
# interactive launcher if it is still up.
pkill -f 'snippy-pull/launch.mjs' 2>/dev/null || true

echo "== 1/3 signed-in check"
node check-signed-in.mjs

OUT="runs/yt-home-$(date +%F).json"
echo "== 2/3 scrape Home feed -> $OUT"
node scrape-home.mjs "$OUT"

echo "== 3/3 enrich + append tab"
LOG=$(python3 enrich-append.py "$OUT" ${SUFFIX:+"$SUFFIX"} $DRY | tee /dev/stderr)

if [ -n "$OPEN" ] && [ -z "$DRY" ]; then
  URL=$(printf '%s\n' "$LOG" | sed -n 's/^URL: //p')
  [ -n "$URL" ] && open "$URL"
fi
