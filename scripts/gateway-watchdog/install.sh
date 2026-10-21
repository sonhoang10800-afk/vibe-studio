#!/usr/bin/env bash
set -euo pipefail

# Install the 9router health watchdog as a launchd user agent.
# Idempotent: the existing agent (if present) is booted out before bootstrap.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WATCHDOG_SCRIPT="$REPO_ROOT/scripts/gateway-watchdog/healthcheck.mjs"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found; set NODE_BIN to an absolute interpreter path." >&2
  exit 1
fi
if [ ! -f "$WATCHDOG_SCRIPT" ]; then
  echo "watchdog script not found: $WATCHDOG_SCRIPT" >&2
  exit 1
fi

UID_NUM="$(id -u)"
LABEL="com.hoangson.9router-watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER="$HOME/.local/bin/9router-healthcheck.sh"
OUT_LOG="$HOME/Library/Logs/9router-watchdog.out.log"
ERR_LOG="$HOME/Library/Logs/9router-watchdog.err.log"

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$WRAPPER")" "$(dirname "$OUT_LOG")"

if [ -f "$PLIST" ] && [ ! -f "$PLIST.bak" ]; then cp -p "$PLIST" "$PLIST.bak"; fi
if [ -f "$WRAPPER" ] && [ ! -f "$WRAPPER.bak" ]; then cp -p "$WRAPPER" "$WRAPPER.bak"; fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${WATCHDOG_SCRIPT}</string>
  </array>
  <key>StartInterval</key>
  <integer>5</integer>
  <!-- launchd otherwise throttles quick one-shot jobs to 10s, which would
       push worst-case detection to ~17s with the 3s x 2 health probe. -->
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
PLIST_EOF

cat > "$WRAPPER" <<WRAPPER_EOF
#!/bin/bash
# Managed by $REPO_ROOT/scripts/gateway-watchdog/install.sh
exec "$NODE_BIN" "$WATCHDOG_SCRIPT" "\$@"
WRAPPER_EOF
chmod 755 "$WRAPPER"

plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST"; then
  echo "launchctl bootstrap failed; trying legacy load..." >&2
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load -w "$PLIST"
fi
launchctl kickstart "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true

echo "Installed $LABEL"
echo "  node:      $NODE_BIN"
echo "  script:    $WATCHDOG_SCRIPT"
echo "  plist:     $PLIST"
echo "  interval:  5s"
echo "  log:       $OUT_LOG"
echo
echo "Verify:"
echo "  launchctl print gui/$UID_NUM/$LABEL | grep -E 'state|runs|last exit'"
echo "  \"$WRAPPER\" --dry-run"
echo "  tail -n 20 \"$OUT_LOG\""
echo
echo "Rollback:"
echo "  launchctl bootout gui/$UID_NUM/$LABEL"
echo "  cp \"$PLIST.bak\" \"$PLIST\" && cp \"$WRAPPER.bak\" \"$WRAPPER\""
echo "  launchctl bootstrap gui/$UID_NUM \"$PLIST\""
