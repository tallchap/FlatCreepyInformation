#!/bin/bash
# Wait for Render deploy to complete after a git push
# Usage: ./scripts/wait-for-render-deploy.sh [commit_sha]
#
# Polls the Render API for the download service deploy status.
# Exits 0 on live, 1 on failure/timeout.

RENDER_API_KEY="rnd_84INjuzvrIpt6CoXWez0WLiWKpCr"
SERVICE_ID="srv-d6p7rfngi27c73ait8r0"
SHA="${1:-$(git rev-parse --short=7 HEAD)}"
MAX_POLLS=80       # 80 × 15s = 20 minutes max
POLL_INTERVAL=15

echo "Waiting for Render deploy of commit $SHA..."

for i in $(seq 1 $MAX_POLLS); do
  RESULT=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
    "https://api.render.com/v1/services/$SERVICE_ID/deploys?limit=1" \
    | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)[0]['deploy']
    commit = d['commit']['id'][:7]
    status = d['status']
    print(f'{commit} {status}')
except Exception as e:
    print(f'error {e}')
" 2>/dev/null)

  COMMIT=$(echo "$RESULT" | awk '{print $1}')
  STATUS=$(echo "$RESULT" | awk '{print $2}')
  echo "$(date +%H:%M:%S) $RESULT"

  # Only check status if this is our commit
  if [ "$COMMIT" = "$SHA" ]; then
    case "$STATUS" in
      live)
        echo "LIVE! Commit $SHA deployed successfully to Render."
        exit 0
        ;;
      build_failed|update_failed)
        echo "FAILED! Render deploy of commit $SHA failed ($STATUS)."
        exit 1
        ;;
    esac
  else
    echo "  (waiting for commit $SHA to appear, latest is $COMMIT)"
  fi

  sleep $POLL_INTERVAL
done

echo "TIMEOUT: Render deploy not completed after $((MAX_POLLS * POLL_INTERVAL / 60)) minutes."
exit 1
