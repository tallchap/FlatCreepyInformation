#!/usr/bin/env bash
set -e

WARP_OK=false

# Generate WARP account and wireproxy config at runtime
if [ ! -f /etc/wireproxy.conf ]; then
  echo "=== Generating Cloudflare WARP account ==="
  cd /tmp
  if wgcf register --accept-tos 2>&1; then
    echo "wgcf register succeeded"
    if wgcf generate 2>&1; then
      echo "wgcf generate succeeded"
      mv wgcf-profile.conf /etc/wireproxy.conf
      printf '\n[Socks5]\nBindAddress = 127.0.0.1:1080\n[http]\nBindAddress = 127.0.0.1:8080\n' >> /etc/wireproxy.conf
      echo "WARP config generated"
    else
      echo "WARNING: wgcf generate failed (exit $?)"
    fi
  else
    echo "WARNING: wgcf register failed (exit $?)"
  fi
  cd /app
fi

# Start wireproxy if config exists
if [ -f /etc/wireproxy.conf ]; then
  echo "=== Starting wireproxy ==="
  wireproxy -c /etc/wireproxy.conf &
  WARP_PID=$!
  sleep 3
  if kill -0 $WARP_PID 2>/dev/null; then
    WARP_OK=true
    echo "wireproxy WARP running on :1080 (PID $WARP_PID)"
  else
    echo "WARNING: wireproxy exited — WARP proxy unavailable"
    echo "=== wireproxy.conf ==="
    cat /etc/wireproxy.conf
    echo "======================"
  fi
else
  echo "WARNING: no wireproxy.conf — WARP proxy unavailable"
fi

echo "WARP_OK=$WARP_OK"

# Start bgutil PO token server on :4416
echo "=== Starting bgutil PO token server ==="
node /opt/bgutil/server/build/main.js &
BGUTIL_PID=$!
sleep 3
if kill -0 $BGUTIL_PID 2>/dev/null; then
  echo "bgutil PO token server running on :4416 (PID $BGUTIL_PID)"
else
  echo "WARNING: bgutil server failed to start — PO tokens unavailable"
fi

# Start download service (foreground — Render monitors this process)
echo "=== Starting download service ==="
exec node server.js
