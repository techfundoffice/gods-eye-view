#!/usr/bin/env bash
set -euo pipefail

# Reconcile JavaScript dependencies after isolated task branches are merged.
# This is idempotent and non-interactive; workflow reconciliation restarts the
# already-running Vite application after this script completes.
npm install --no-audit --no-fund --prefer-offline