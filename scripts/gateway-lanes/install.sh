#!/usr/bin/env bash
set -euo pipefail

# Install/refresh the 9router gateway lanes as launchd user agents.
# Idempotent: an existing lane agent is booted out before bootstrap.
# Ports default to 20130 and 20133; pass --port for anything else.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found; set NODE_BIN to an absolute interpreter path." >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/lanes.mjs" install "$@"
