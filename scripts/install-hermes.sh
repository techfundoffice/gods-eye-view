#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_HOME="$ROOT/.hermes"
INSTALL_DIR="$HERMES_HOME/hermes-agent"
PINNED_COMMIT="29112bef099274229cadff79cdff7bf7b99c4b77"
INSTALLER_URL="https://hermes-agent.nousresearch.com/install.sh"

if [[ -x "$INSTALL_DIR/venv/bin/hermes" ]] \
  && [[ "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)" == "$PINNED_COMMIT" ]]; then
  exec "$INSTALL_DIR/venv/bin/hermes" --version
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$INSTALLER_URL" -o "$tmp"
HERMES_HOME="$HERMES_HOME" HERMES_INSTALL_DIR="$INSTALL_DIR" \
  bash "$tmp" \
    --dir "$INSTALL_DIR" \
    --hermes-home "$HERMES_HOME" \
    --commit "$PINNED_COMMIT" \
    --non-interactive \
    --skip-setup \
    --no-skills \
    --skip-browser || {
      # The official installer may fail only while trying to update the
      # read-only Replit shell profile after the runtime is complete.
      [[ -x "$INSTALL_DIR/venv/bin/hermes" ]] || exit 1
    }

"$INSTALL_DIR/venv/bin/hermes" --version