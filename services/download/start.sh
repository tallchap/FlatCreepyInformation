#!/usr/bin/env bash
set -e

# Capture ALL startup output for debugging via /debug/system
exec > >(tee /tmp/startup.log) 2>&1

WARP_OK=false

echo "=== Startup $(date -u) ==="
echo "hostname: $(hostname)"
echo "ip: $(curl -s --max-time 5 ifconfig.me || echo 'unknown')"

# Generate WARP account and wireproxy config at runtime
if [ ! -f /etc/wireproxy.conf ]; then
  echo "=== Generating Cloudflare WARP account ==="
  cd /tmp

  echo "--- wgcf register ---"
  if wgcf register --accept-tos 2>&1; then
    echo "wgcf register exit=$?"
    echo "--- wgcf generate ---"
    if wgcf generate 2>&1; then
      echo "wgcf generate exit=$?"
      echo "--- wgcf-profile.conf ---"
      cat wgcf-profile.conf
      echo "--- end wgcf-profile.conf ---"
      mv wgcf-profile.conf /etc/wireproxy.conf
      printf '\n[Socks5]\nBindAddress = 127.0.0.1:1080\n[http]\nBindAddress = 127.0.0.1:8080\n' >> /etc/wireproxy.conf
      echo "--- final wireproxy.conf ---"
      cat /etc/wireproxy.conf
      echo "--- end wireproxy.conf ---"
      echo "WARP config generated"
    else
      echo "WARNING: wgcf generate FAILED (exit $?)"
      ls -la /tmp/wgcf* 2>/dev/null || echo "(no wgcf files found)"
    fi
  else
    echo "WARNING: wgcf register FAILED (exit $?)"
    echo "wgcf version: $(wgcf --version 2>&1 || echo 'unknown')"
  fi
  cd /app
else
  echo "wireproxy.conf already exists, skipping WARP generation"
  cat /etc/wireproxy.conf
fi

# Start wireproxy if config exists
if [ -f /etc/wireproxy.conf ]; then
  echo "=== Starting wireproxy ==="
  wireproxy -c /etc/wireproxy.conf &
  WARP_PID=$!
  sleep 3
  if kill -0 $WARP_PID 2>/dev/null; then
    WARP_OK=true
    echo "wireproxy WARP running (PID $WARP_PID)"
    echo "--- port check ---"
    ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "(no ss/netstat)"
  else
    echo "WARNING: wireproxy exited — WARP proxy unavailable"
    echo "--- wireproxy.conf ---"
    cat /etc/wireproxy.conf
    echo "--- end wireproxy.conf ---"
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

echo "=== Startup complete ==="

# Start download service (foreground — Render monitors this process)
exec node server.js
