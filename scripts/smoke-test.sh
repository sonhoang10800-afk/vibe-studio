#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3000}"
ENDPOINT="http://localhost:${PORT}/api/health"

echo "Smoke testing Vibe Studio Health API on ${ENDPOINT}..."

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for smoke testing."
  exit 1
fi

HTTP_CODE=$(curl -s -o /tmp/health_response.json -w "%{http_code}" "${ENDPOINT}" || echo "000")

if [ "${HTTP_CODE}" = "200" ]; then
  echo "✅ Smoke test PASSED: HTTP 200 OK"
  cat /tmp/health_response.json
  echo ""
  exit 0
else
  echo "❌ Smoke test FAILED: HTTP ${HTTP_CODE}"
  if [ -f /tmp/health_response.json ]; then
    cat /tmp/health_response.json
    echo ""
  fi
  exit 1
fi
