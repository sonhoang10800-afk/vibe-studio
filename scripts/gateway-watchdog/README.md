# 9router health watchdog

Restarts the local 9router launchd service when its HTTP event loop stops
answering. The old healthcheck waited `curl --max-time 30` twice (up to ~60s)
before deciding; this watchdog uses a 3-second per-attempt timeout, two
attempts, and then `launchctl kickstart -k` immediately. Worst-case detection
is about 12s: a 5s launchd interval plus the 7s health probe.

**Scope:** health endpoint only. Provider-side `fetch connect timeout` errors
do not make `/api/health` fail and are intentionally out of scope.

The directory is `gateway-watchdog` on purpose: 9router's startup
`killAllAppProcesses()` kills any node process whose command line contains
`/9router`, which would kill a watchdog living under `.../9router-watchdog/`
mid-restart.

## How it works

```
launchd (StartInterval 5s)
  └─ node healthcheck.mjs
       ├─ GET /api/health, 3s timeout, 2 attempts
       ├─ healthy ─────────────────────► exit 0, no log noise
       └─ unhealthy
            ├─ ECONNREFUSED < 15s ─────► startup grace, no restart
            ├─ cooldown / budget spent ► log, no restart
            └─ restart
                 ├─ record restart timestamp (state file)
                 ├─ launchctl kickstart -k gui/<uid>/com.hoangson.9router
                 │    └─ failure → pkill -TERM -f ~/.local/bin/9router
                 └─ poll health up to 30s → log recovered / failed
```

A restart interrupts in-flight requests. The watchdog only does it when the
health endpoint is unresponsive, and it enforces a 30-second cooldown plus a
5-restart/10-minute budget so a broken service cannot cause a restart storm.

## Install

```bash
bash scripts/gateway-watchdog/install.sh
```

The installer:

- writes `~/Library/LaunchAgents/com.hoangson.9router-watchdog.plist`
  (`StartInterval` 5s, `ThrottleInterval` 1s so launchd does not clamp the
  interval to 10s, `RunAtLoad`);
- points it at `<repo>/scripts/gateway-watchdog/healthcheck.mjs` with an
  absolute `node` path;
- rewrites `~/.local/bin/9router-healthcheck.sh` as a wrapper for manual runs;
- backs up the original plist and wrapper to `*.bak` (created once);
- bootouts and bootstraps the launchd agent. It does **not** restart 9router.

Re-run it after moving the repo. `NODE_BIN=/absolute/path/to/node` overrides the
interpreter.

## Verify

```bash
# healthy: prints JSON with status=healthy, does not restart or write state
~/.local/bin/9router-healthcheck.sh --dry-run

# refused connection: status=starting during the 15s boot grace, no restart
~/.local/bin/9router-healthcheck.sh \
  --health-url http://127.0.0.1:54321/api/health \
  --timeout-ms 200 --attempts 1 --dry-run

# hung endpoint: status=dry-run + would restart, still no action.
# Start a throwaway server that accepts connections but never answers:
node -e 'require("node:http").createServer(() => {}).listen(20299, "127.0.0.1")' &
SERVER_PID=$!
~/.local/bin/9router-healthcheck.sh \
  --health-url http://127.0.0.1:20299/api/health \
  --timeout-ms 200 --attempts 1 --dry-run
kill "$SERVER_PID"

launchctl print "gui/$(id -u)/com.hoangson.9router-watchdog" | grep -E 'state|runs|last exit'
tail -n 20 ~/Library/Logs/9router-watchdog.out.log
```

The log only receives unhealthy/restart lines, so a healthy 9router should
leave it quiet while `runs` keeps increasing.

## Tuning

Defaults live in `DEFAULTS` at the top of `healthcheck.mjs`:

| Constant | Default | Meaning |
|---|---|---|
| `timeoutMs` | 3000 | per-attempt health timeout |
| `attempts` | 2 | attempts before restarting |
| `retryDelayMs` | 1000 | pause between attempts |
| `cooldownMs` | 30000 | minimum gap between restarts |
| `maxRestarts` | 5 | restart budget per window |
| `windowMs` | 600000 | budget window (10 minutes) |
| `startupGraceMs` | 15000 | grace for `ECONNREFUSED` (service starting) |
| `startupTimeoutMs` | 30000 | post-restart recovery wait |
| `startupPollMs` | 500 | post-restart poll interval |
| `label` | `com.hoangson.9router` | launchd job to kickstart |

CLI flags: `--health-url`, `--timeout-ms`, `--attempts`, `--state-file`,
`--log-file`, `--label`, `--dry-run`, `--help`.

State lives in `~/.9router/watchdog-state.json` (`restarts`, `downSince`).
Durable events append to `~/Library/Logs/9router-watchdog.out.log`.

## Rollback

```bash
launchctl bootout "gui/$(id -u)/com.hoangson.9router-watchdog"
mv ~/Library/LaunchAgents/com.hoangson.9router-watchdog.plist.bak \
   ~/Library/LaunchAgents/com.hoangson.9router-watchdog.plist
mv ~/.local/bin/9router-healthcheck.sh.bak ~/.local/bin/9router-healthcheck.sh
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.hoangson.9router-watchdog.plist
```

To stop the watchdog without restoring the old one, just boot it out:

```bash
launchctl bootout "gui/$(id -u)/com.hoangson.9router-watchdog"
```
