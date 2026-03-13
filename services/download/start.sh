#!/usr/bin/env bash
set -e

# Start wireproxy (Cloudflare WARP → SOCKS5 on :1080)
wireproxy -c /etc/wireproxy.conf &
WARP_PID=$!
sleep 2
if ! kill -0 $WARP_PID 2>/dev/null; then
  echo "ERROR: wireproxy failed to start"
  exit 1
fi
echo "wireproxy WARP running on :1080 (PID $WARP_PID)"

# Start bgutil PO token server on :4416
node /opt/bgutil/server/build/main.js &
BGUTIL_PID=$!
sleep 3
if ! kill -0 $BGUTIL_PID 2>/dev/null; then
  echo "ERROR: bgutil server failed to start"
  exit 1
fi
echo "bgutil PO token server running on :4416 (PID $BGUTIL_PID)"

# Start download service (foreground — Render monitors this process)
exec node server.js
