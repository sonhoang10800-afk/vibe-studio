# 9router gateway lanes

Extra 9router HTTP gateways on ports `20130` and `20133`, next to the main
gateway on `20128`. **Every port owns a complete data directory** — its own
SQLite DB, settings, API keys, provider connections, combos, usage history and
jwt-secret — so each port can be logged into a different upstream account.
Nothing is shared between ports except the 9router code itself. This is a
local-ops helper, not product code.

| Port | data dir | notes |
| --- | --- | --- |
| `20128` | `~/.9router` | main gateway, `launchd com.hoangson.9router` |
| `20130` | `~/.9router-lanes/20130` | lane |
| `20133` | `~/.9router-lanes/20133` | lane |

## Why not just `9router -p 20130`?

9router 0.5.104 runs `killAllAppProcesses()` on startup (`cli.js:268-363`). It
scans `ps aux` and kills every process that matches

```
node + "9router" + ("cli.js" or "/9router")     OR     "next-server"
```

with no port scoping and no env opt-out. Standalone Next servers rename
themselves to `next-server (vX)`, so **every 9router server on the machine
matches**. Starting a second CLI instance therefore kills the main one, the main
one kills it back, and a watchdog restart of the main takes every extra port down
with it. Path tricks (symlink, copy, rename) do not help: the process title hides
the path.

The fix has two parts:

1. **`patch`** — narrow `killAllAppProcesses()` to processes that hold the CLI's
   own port (found via `/usr/sbin/lsof`, absolute, because launchd's `PATH` has no
   `/usr/sbin`). Applied to the installed `cli.js`, with a backup and an exact
   revert.
2. **`install`** — run each lane as a plain Next standalone server under launchd
   (`node …/app/custom-server.js`), never through `cli.js`, so a lane never runs
   the sweep at all.

## Install / provision

```bash
node scripts/gateway-lanes/lanes.mjs patch apply
node scripts/gateway-lanes/lanes.mjs patch verify

scripts/gateway-lanes/install.sh                 # 20130 + 20133, with provisioning
scripts/gateway-lanes/install.sh --port 20134    # different port
```

`install` is idempotent and does three things per port:

1. writes, lints and bootstraps `~/Library/LaunchAgents/com.hoangson.9router-lane-<port>.plist`
   with `DATA_DIR=~/.9router-lanes/<port>`;
2. waits for `/api/health`;
3. **provisions** the lane: triggers DB creation, writes the lane auth contract
   (`requireLogin=false`, `requireApiKey=true`), creates its own API key and
   stores it at `~/.9router-lanes/<port>/api-key` (mode 600), optionally copies
   combo definitions, restarts the lane and proves that the key works.

`provision` can be re-run on its own:

```bash
node scripts/gateway-lanes/lanes.mjs provision --port 20130
node scripts/gateway-lanes/lanes.mjs provision --port 20130 --copy-combo openrouter-minimax-m3.1-flash
```

- `--copy-combo <name>` copies only the **combo definition** (model alias → list
  of models) from `~/.9router/db/data.sqlite`. It never copies credentials.
- `--source-db <path>` reads combos from a different DB.
- `--data-root <path>` moves the whole lane root (default `~/.9router-lanes`).
- `--skip-provision` installs the launchd agents only.

## Give each port its own upstream account

After provisioning every lane is an independent, empty gateway. Add the account
you want for that port in **its own** dashboard:

```bash
open http://127.0.0.1:20130/dashboard   # e.g. OpenRouter account #1
open http://127.0.0.1:20133/dashboard   # e.g. OpenRouter account #2
```

Then point an agent at that port with that port's key:

```bash
# key file (do not paste it into logs/chat)
cat ~/.9router-lanes/20130/api-key
# base URL: http://127.0.0.1:20130/v1
```

Combos are per port too: create them in the dashboard, or copy a definition with
`--copy-combo` (then add the matching provider account in that port).

## Status / acceptance

```bash
node scripts/gateway-lanes/lanes.mjs status
```

```text
main  20128  health=ok  db=/Users/…/.9router/db/data.sqlite
lane  20130  launchd=running  pid=…  health=ok  data=/Users/…/.9router-lanes/20130 keys=1 providers=1 combos=1  api-key=yes
lane  20133  launchd=running  pid=…  health=ok  data=/Users/…/.9router-lanes/20133 keys=1 providers=0 combos=0  api-key=yes
patch cli.js: applied
```

Proof that the ports are independent (run these after any change):

```bash
# 1. each process opens its own DB
for p in 20128 20130 20133; do
  pid=$(/usr/sbin/lsof -ti:$p -sTCP:LISTEN)
  printf '%s -> ' "$p"; /usr/sbin/lsof -p "$pid" | grep 'data.sqlite$' | awk '{print $NF}'
done

# 2. keys are per port: lane A's key must be rejected by lane B
KEY30=$(cat ~/.9router-lanes/20130/api-key)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $KEY30" -H 'content-type: application/json' \
  -d '{"model":"__probe__","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' \
  http://127.0.0.1:20133/v1/chat/completions      # expect 401

# 3. each lane accepts its own key (404 = auth passed, bogus model)
KEY33=$(cat ~/.9router-lanes/20133/api-key)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $KEY33" -H 'content-type: application/json' \
  -d '{"model":"__probe__","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' \
  http://127.0.0.1:20133/v1/chat/completions      # expect 404

# 4. restart isolation
launchctl kickstart -k "gui/$(id -u)/com.hoangson.9router"          # lanes keep their PIDs
launchctl kickstart -k "gui/$(id -u)/com.hoangson.9router-lane-20130"
```

## After a 9router update

`npm i -g 9router` replaces `cli.js` and the patch is gone.

```bash
node scripts/gateway-lanes/lanes.mjs patch verify   # exits 1 when NOT applied
node scripts/gateway-lanes/lanes.mjs patch apply
launchctl kickstart -k "gui/$(id -u)/com.hoangson.9router"
scripts/gateway-lanes/install.sh                    # lanes pick up the new app dir
```

Lane data dirs survive updates (schema migrations run on boot). Until the patch is
re-applied the lanes still run, but every main restart (including watchdog
restarts) kills them and launchd brings them back — about a 10 second hole per
lane. `status` reports the patch state.

## Known limitations

- **Independent means independent.** Provider accounts, API keys, combos, model
  catalogs and usage history are not shared between ports; configure each port
  separately.
- **MITM is incompatible with lanes.** The app's MITM proxy binds a fixed `:443`;
  only one instance can hold it even though every port now has its own setting.
- **No per-lane watchdog yet.** The main gateway keeps
  `com.hoangson.9router-watchdog`; lanes only restart when the process exits, not
  when the event loop hangs. Adding per-lane watchdogs needs a `--port` option in
  `scripts/gateway-watchdog/healthcheck.mjs` so the fallback kill cannot hit the
  main CLI.
- **Each lane downloads its own model catalog** on first boot (~300 KB) and keeps
  its own SQLite WAL files; that is the price of full isolation.
- **Lanes are headless.** No tray icon, no CLI menu, no auto-update prompt. They
  are supervised by launchd and managed through this script.

## Backup / rollback

Backup one port by copying its directory while the lane is stopped. `~/.9router`
(main) is never touched by this tool.

```bash
node scripts/gateway-lanes/lanes.mjs uninstall              # bootout + remove plists, data kept
node scripts/gateway-lanes/lanes.mjs uninstall --purge      # also delete ~/.9router-lanes/<port>
node scripts/gateway-lanes/lanes.mjs patch revert           # restore cli.js from the .bak, byte-exact
launchctl kickstart -k "gui/$(id -u)/com.hoangson.9router"
```

If `patch revert` refuses, `cli.js` diverged from the backup (usually an update):
reinstall 9router and apply again rather than forcing the file.

## Files

| Path | Purpose |
| --- | --- |
| `scripts/gateway-lanes/lanes.mjs` | plist builder, install/provision/status/uninstall, patch apply/verify/revert |
| `scripts/gateway-lanes/install.sh` | thin `install` wrapper |
| `tests/unit/gateway-lanes.test.ts` | plist contract, patch round-trip, settings merge, DB helpers |

Host state: `~/.9router-lanes/<port>/` (data, `api-key`),
`~/Library/LaunchAgents/com.hoangson.9router-lane-<port>.plist`,
`~/Library/Logs/9router-lane-<port>.{out,err}.log`,
`~/.local/lib/node_modules/9router/cli.js.gateway-lanes.bak`.
