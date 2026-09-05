#!/usr/bin/env bash
# Run the bundled Hermes dashboard as a Replit-managed foreground service.
set -euo pipefail

cd "$(dirname "$0")/.."

export HERMES_HOME="${HERMES_HOME:-$PWD/.hermes}"
export PATH="$PWD/bin:$PWD/node_modules/.bin:$PATH"

HOST="${HERMES_DASHBOARD_HOST:-0.0.0.0}"
PORT="${HERMES_DASHBOARD_PORT:-8000}"

if [[ ! -x "$PWD/bin/hermes" ]]; then
  echo "[hermes-dashboard] Workspace launcher is missing or not executable." >&2
  exit 1
fi

if [[ ! -x "$HERMES_HOME/hermes-agent/venv/bin/hermes" ]]; then
  echo "[hermes-dashboard] Pinned Hermes runtime is missing." >&2
  echo "[hermes-dashboard] Restore it with scripts/install-hermes.sh; this service will not install or upgrade Hermes." >&2
  exit 1
fi

"$HERMES_HOME/hermes-agent/venv/bin/python" \
  "$PWD/scripts/configure-hermes-unrestricted.py" \
  --config "$HERMES_HOME/config.yaml"

# A Replit Preview requires a non-loopback bind. Hermes deliberately refuses
# that bind unless an auth provider is configured, so fail before launch if
# the existing workspace secrets are unavailable.
if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" && "$HOST" != "::1" ]]; then
  if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
    echo "[hermes-dashboard] ADMIN_PASSWORD is required for dashboard login." >&2
    exit 1
  fi
  if [[ -z "${SESSION_SECRET:-}" ]]; then
    echo "[hermes-dashboard] SESSION_SECRET is required to sign dashboard sessions." >&2
    exit 1
  fi

  export HERMES_DASHBOARD_BASIC_AUTH_USERNAME="${HERMES_DASHBOARD_USERNAME:-admin}"
  export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="$ADMIN_PASSWORD"
  export HERMES_DASHBOARD_BASIC_AUTH_SECRET="$SESSION_SECRET"
fi

echo "[hermes-dashboard] Starting bundled dashboard on ${HOST}:${PORT}."
echo "[hermes-dashboard] Hermes home: $HERMES_HOME"
echo "[hermes-dashboard] Frontend assets are built only when the pinned source is newer or the build is missing."

# Keep Hermes in the foreground so Replit owns its lifecycle. Do not run
# `hermes update` here: scripts/install-hermes.sh remains the only mechanism
# that restores the project's pinned Agent version.
exec "$PWD/bin/hermes" dashboard \
  --host "$HOST" \
  --port "$PORT" \
  --no-open