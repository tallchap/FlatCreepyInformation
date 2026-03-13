#!/bin/bash
# Wait for Vercel (frontend) deploy to complete after a git push
# Usage: ./scripts/wait-for-deploy.sh [commit_sha]
# NOTE: This only checks Vercel/GitHub Deployments API.
# For Render (download service), use wait-for-render-deploy.sh

REPO="tallchap/FlatCreepyInformation"
SHA="${1:-$(git rev-parse --short HEAD)}"
FULL_SHA="$(git rev-parse HEAD)"

echo "Waiting for deploy of commit $SHA to go live..."

for i in $(seq 1 60); do
  # Get latest deployment matching our commit
  STATUS=$(gh api "repos/$REPO/deployments?sha=$FULL_SHA" --jq '.[0].id' 2>/dev/null)

  if [ -n "$STATUS" ] && [ "$STATUS" != "null" ]; then
    STATE=$(gh api "repos/$REPO/deployments/$STATUS/statuses" --jq '.[0].state' 2>/dev/null)

    if [ "$STATE" = "success" ]; then
      echo "LIVE! Commit $SHA deployed successfully to production."
      exit 0
    elif [ "$STATE" = "failure" ] || [ "$STATE" = "error" ]; then
      echo "FAILED! Deploy of commit $SHA failed."
      exit 1
    fi
  fi

  sleep 5
done

echo "TIMEOUT: Deploy not completed after 5 minutes."
exit 1
