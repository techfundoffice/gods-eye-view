#!/usr/bin/env bash
# Replit Run button must not crash when Vite is already on PORT.
# If 5000 is serving, hold this workflow. If it drops, start Vite.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-5000}"
HOST="${HOST:-0.0.0.0}"

port_up() {
  python3 -c "import socket,sys
s=socket.socket()
s.settimeout(1)
try:
    sys.exit(0 if s.connect_ex(('127.0.0.1', int(sys.argv[1])))==0 else 1)
finally:
    s.close()" "$PORT"
}

if port_up; then
  echo "[dev-replit] Port ${PORT} is already serving. Holding so Replit does not mark the app crashed."
  while port_up; do
    sleep 4
  done
  echo "[dev-replit] Port ${PORT} dropped; starting Vite."
fi

export HOST PORT
exec npx vite --host 0.0.0.0 --port "$PORT" --strictPort
