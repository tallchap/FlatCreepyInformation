#!/usr/bin/env bash
set -e
# Start bgutil PO token HTTP server (port 4416) in background
node /opt/bgutil/server/build/main.js &
BGUTIL_PID=$!
sleep 3
# Verify it started
if ! kill -0 $BGUTIL_PID 2>/dev/null; then
  echo "ERROR: bgutil server failed to start"
  exit 1
fi
echo "bgutil PO token server running on :4416 (PID $BGUTIL_PID)"
# Start download service (foreground — Render monitors this process)
exec node server.js
