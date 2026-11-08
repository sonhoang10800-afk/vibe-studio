#!/usr/bin/env node
// @ts-check
/**
 * 9router gateway lanes — extra 9router HTTP gateways on additional ports, each
 * with a fully independent data directory (own SQLite DB, settings, API keys,
 * provider connections, combos, usage history, jwt-secret).
 *
 * Why a dedicated launcher instead of `9router -p <port>`: 9router 0.5.104 runs
 * killAllAppProcesses() on startup, which kills every process whose command line
 * mentions 9router and every "next-server" process — regardless of port
 * (cli.js:268-363). Two CLI instances therefore kill each other, and every main
 * restart takes the extra ports down with it.
 *
 * Two-part fix:
 *   1. `patch` narrows that sweep to the CLI's own port (the only reliable
 *      discriminator, because standalone Next servers rename themselves to
 *      "next-server (vX)" and lose their path).
 *   2. `install` runs each lane as a plain Next standalone server under launchd,
 *      so a lane never executes the sweep at all.
 *
 * Isolation: lane N uses DATA_DIR=~/.9router-lanes/<port>. The main gateway keeps
 * ~/.9router untouched. Nothing is shared between ports except the 9router code
 * itself, so each port can be logged into a different upstream account.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAIN_PORT = 20128;
export const LANE_PORTS = [20130, 20133];
export const DEFAULT_DATA_ROOT_NAME = ".9router-lanes";
const LANE_HOST = "127.0.0.1";
const LABEL_PREFIX = "com.hoangson.9router-lane-";
const PATCH_BACKUP_SUFFIX = ".gateway-lanes.bak";
export const PATCH_ANCHOR = "      // Kill all found processes\n";
export const PATCH_BEGIN = "      // [gateway-lanes] begin";
export const PATCH_END = "      // [gateway-lanes] end";

const HEALTH_TIMEOUT_MS = 2000;
const HEALTH_ATTEMPTS = 20;
const HEALTH_POLL_MS = 1000;
const DB_WAIT_TIMEOUT_MS = 20000;
const DB_WAIT_POLL_MS = 500;

/**
 * The port filter inserted before the "Kill all found processes" block in
 * 9router's cli.js. /usr/sbin/lsof is used by absolute path on purpose: the
 * launchd PATH has no /usr/sbin, and a failing lsof (bare name) would make the
 * sweep kill nothing — leaving the old server on the port and crash-looping the
 * new one.
 */
const PATCH_BLOCK = [
  `${PATCH_BEGIN} — only reclaim processes that hold THIS port.`,
  '      // Standalone Next servers appear in ps as "next-server (vX)", so the',
  "      // whitelist above also matches sibling 9router instances on other ports.",
  "      try {",
  '        const lsofBin = fs.existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";',
  "        const ownPortPids = new Set(",
  '          execSync(`${lsofBin} -ti:${appPort} -sTCP:LISTEN`, { encoding: "utf8", timeout: 5000 })',
  "            .split(/\\s+/).filter(Boolean)",
  "        );",
  "        pids = pids.filter((pid) => ownPortPids.has(pid));",
  "      } catch {",
  "        pids = [];",
  "      }",
  PATCH_END,
].join("\n") + "\n";

/**
 * @typedef {{
 *   command: "install"|"provision"|"status"|"uninstall"|"patch"|"help",
 *   action: "apply"|"verify"|"revert"|null,
 *   ports: number[],
 *   dryRun: boolean,
 *   nodeBin: string|null,
 *   appDir: string|null,
 *   cliPath: string|null,
 *   dataRoot: string|null,
 *   sourceDb: string|null,
 *   copyCombos: string[],
 *   skipProvision: boolean,
 *   purge: boolean,
 * }} Options
 * @typedef {{ label: string, plistPath: string, outLog: string, errLog: string }} LanePaths
 * @typedef {{ state: string|null, pid: number|null }} JobSummary
 * @typedef {{ apiKeys: number, providerConnections: number, combos: number }} LaneSummary
 */

/** @param {string} value */
export function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @param {number} port */
export function laneLabel(port) {
  return `${LABEL_PREFIX}${port}`;
}

/**
 * @param {string} home
 * @param {number} port
 * @returns {LanePaths}
 */
export function lanePaths(home, port) {
  const label = laneLabel(port);
  return {
    label,
    plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
    outLog: join(home, "Library", "Logs", `9router-lane-${port}.out.log`),
    errLog: join(home, "Library", "Logs", `9router-lane-${port}.err.log`),
  };
}

/**
 * @param {string} home
 * @param {string} value
 * @returns {string}
 */
export function expandHome(home, value) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

/**
 * @param {string} home
 * @param {string|null} dataRoot
 * @returns {string}
 */
export function laneDataRoot(home, dataRoot) {
  return dataRoot ? expandHome(home, dataRoot) : join(home, DEFAULT_DATA_ROOT_NAME);
}

/**
 * Every lane owns a complete 9router data dir: DB, settings, API keys,
 * providers, combos, usage, jwt-secret.
 *
 * @param {string} home
 * @param {string|null} dataRoot
 * @param {number} port
 * @returns {string}
 */
export function laneDataDir(home, dataRoot, port) {
  return join(laneDataRoot(home, dataRoot), String(port));
}

/**
 * @param {number[]} ports
 * @returns {number[]}
 */
export function validatePorts(ports) {
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error("at least one --port is required");
  }
  /** @type {Set<number>} */
  const seen = new Set();
  for (const port of ports) {
    if (!Number.isInteger(port)) throw new Error(`port must be an integer: ${String(port)}`);
    if (port < 1024 || port > 65535) throw new Error(`port out of range 1024-65535: ${port}`);
    if (port === MAIN_PORT) throw new Error(`port ${port} is reserved for the main gateway`);
    if (seen.has(port)) throw new Error(`duplicate port: ${port}`);
    seen.add(port);
  }
  return ports;
}

/**
 * @param {string} source
 * @returns {boolean}
 */
export function isPatched(source) {
  return source.includes(PATCH_BEGIN) && source.includes(PATCH_END);
}

/**
 * Insert the port-scoped kill filter before the sweep's kill block.
 *
 * @param {string} source
 * @returns {{ source: string, changed: boolean }}
 */
export function applyPatch(source) {
  if (isPatched(source)) return { source, changed: false };

  const first = source.indexOf(PATCH_ANCHOR);
  if (first === -1) {
    throw new Error(
      "patch anchor not found: 9router cli.js layout changed; inspect killAllAppProcesses() before patching"
    );
  }
  if (source.indexOf(PATCH_ANCHOR, first + 1) !== -1) {
    throw new Error("patch anchor is ambiguous: found more than once in cli.js");
  }

  return {
    source: source.slice(0, first) + PATCH_BLOCK + source.slice(first),
    changed: true,
  };
}

/**
 * Remove the marker block. Returns the source unchanged when not patched.
 *
 * @param {string} source
 * @returns {string}
 */
export function revertPatch(source) {
  const begin = source.indexOf(PATCH_BEGIN);
  if (begin === -1) return source;
  const endMarker = source.indexOf(PATCH_END, begin);
  if (endMarker === -1) throw new Error("corrupt patch: begin marker without end marker");
  const end = endMarker + PATCH_END.length + 1;
  return source.slice(0, begin) + source.slice(end);
}

/**
 * @param {string} text
 * @returns {JobSummary}
 */
export function summarizeLaunchctl(text) {
  const stateMatch = text.match(/^\s*state = (\S+)/m);
  const pidMatch = text.match(/^\s*pid = (\d+)/m);
  return {
    state: stateMatch?.[1] ?? null,
    pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
  };
}

/**
 * Merge the lane auth contract into an existing settings row without dropping
 * any other setting. A corrupt row is an operator problem: fail instead of
 * silently resetting someone's configuration.
 *
 * @param {string|null} existingJson
 * @param {{ requireLogin: boolean, requireApiKey: boolean }} flags
 * @returns {string}
 */
export function mergeSettingsJson(existingJson, flags) {
  /** @type {Record<string, unknown>} */
  let current = {};
  if (typeof existingJson === "string" && existingJson.trim() !== "") {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(existingJson);
    } catch {
      throw new Error("settings row is not valid JSON; refusing to overwrite it");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings row is not a JSON object; refusing to overwrite it");
    }
    current = /** @type {Record<string, unknown>} */ (parsed);
  }
  return JSON.stringify({
    ...current,
    requireLogin: flags.requireLogin,
    requireApiKey: flags.requireApiKey,
  });
}

/**
 * @param {{
 *   label: string,
 *   port: number,
 *   host: string,
 *   nodeBin: string,
 *   appDir: string,
 *   dataDir: string,
 *   home: string,
 *   outLog: string,
 *   errLog: string,
 * }} options
 * @returns {string}
 */
export function buildLanePlist(options) {
  const { label, port, host, nodeBin, appDir, dataDir, home, outLog, errLog } = options;
  const nodePath = [join(dataDir, "runtime", "node_modules"), join(appDir, "node_modules")].join(":");
  const path = ["/usr/sbin", join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const env = [
    ["HOME", home],
    ["PATH", path],
    ["DATA_DIR", dataDir],
    ["PORT", String(port)],
    ["HOSTNAME", host],
    ["NODE_PATH", nodePath],
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>--dns-result-order=ipv4first</string>
    <string>--max-old-space-size=6144</string>
    <string>${escapeXml(join(appDir, "custom-server.js"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(appDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env
  .map(
    ([key, value]) =>
      `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`
  )
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
}

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    command: "help",
    action: null,
    ports: [],
    dryRun: false,
    nodeBin: null,
    appDir: null,
    cliPath: null,
    dataRoot: null,
    sourceDb: null,
    copyCombos: [],
    skipProvision: false,
    purge: false,
  };

  const command = argv[0];
  if (
    command === "install" ||
    command === "provision" ||
    command === "status" ||
    command === "uninstall" ||
    command === "patch"
  ) {
    options.command = command;
  } else if (command === "help" || command === "--help" || command === "-h" || command === undefined) {
    options.command = "help";
  } else {
    throw new Error(`unknown command: ${command}`);
  }

  let index = 1;
  if (options.command === "patch") {
    const action = argv[1];
    if (action !== "apply" && action !== "verify" && action !== "revert") {
      throw new Error("patch requires one of: apply, verify, revert");
    }
    options.action = action;
    index = 2;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-provision") {
      options.skipProvision = true;
      continue;
    }
    if (arg === "--purge") {
      options.purge = true;
      continue;
    }
    if (
      arg === "--port" ||
      arg === "--node-bin" ||
      arg === "--app-dir" ||
      arg === "--cli-path" ||
      arg === "--data-root" ||
      arg === "--source-db" ||
      arg === "--copy-combo"
    ) {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--port") {
        const port = Number.parseInt(value, 10);
        if (!Number.isInteger(port) || String(port) !== value) {
          throw new Error(`--port must be an integer: ${value}`);
        }
        options.ports.push(port);
      } else if (arg === "--node-bin") {
        options.nodeBin = value;
      } else if (arg === "--app-dir") {
        options.appDir = value;
      } else if (arg === "--cli-path") {
        options.cliPath = value;
      } else if (arg === "--data-root") {
        options.dataRoot = value;
      } else if (arg === "--source-db") {
        options.sourceDb = value;
      } else {
        options.copyCombos.push(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

// ---------------------------------------------------------------------------
// Lane database helpers (node:sqlite, no shell quoting, no new dependency)
// ---------------------------------------------------------------------------

/** @returns {Promise<typeof import("node:sqlite")>} */
async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch {
    throw new Error("node:sqlite is unavailable; Node >= 22.5 is required for provisioning");
  }
}

/**
 * @param {string} dbPath
 * @param {string} table
 * @returns {Promise<boolean>}
 */
export async function tableExists(dbPath, table) {
  if (!existsSync(dbPath)) return false;
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * @param {string} dbPath
 * @returns {Promise<string|null>}
 */
export async function readSettingsJson(dbPath) {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
    if (!row || !("data" in row)) return null;
    return typeof row.data === "string" ? row.data : null;
  } finally {
    db.close();
  }
}

/**
 * @param {string} dbPath
 * @param {string} json
 * @returns {Promise<void>}
 */
export async function writeSettingsJson(dbPath, json) {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      "INSERT INTO settings (id, data) VALUES (1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data"
    ).run(json);
  } finally {
    db.close();
  }
}

/**
 * @param {string} dbPath
 * @returns {Promise<LaneSummary>}
 */
export async function laneSummary(dbPath) {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  /** @param {string} table */
  const count = (table) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (!row || !("n" in row)) return 0;
    return typeof row.n === "number" ? row.n : Number(row.n);
  };
  try {
    return {
      apiKeys: count("apiKeys"),
      providerConnections: count("providerConnections"),
      combos: count("combos"),
    };
  } finally {
    db.close();
  }
}

/**
 * Copy one combo definition (no credentials) from the source DB into a lane DB.
 *
 * @param {string} sourceDbPath
 * @param {string} targetDbPath
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function copyComboRow(sourceDbPath, targetDbPath, name) {
  if (!existsSync(sourceDbPath)) throw new Error(`source DB not found: ${sourceDbPath}`);
  const { DatabaseSync } = await loadSqlite();

  const source = new DatabaseSync(sourceDbPath, { readOnly: true });
  /** @type {Record<string, import("node:sqlite").SQLOutputValue> | undefined} */
  let row;
  try {
    row = source.prepare("SELECT id, name, kind, models, createdAt, updatedAt FROM combos WHERE name = ?").get(name);
  } finally {
    source.close();
  }
  if (!row) throw new Error(`combo not found in ${sourceDbPath}: ${name}`);

  const target = new DatabaseSync(targetDbPath);
  try {
    target.exec("PRAGMA busy_timeout = 5000");
    target
      .prepare(
        "INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, models = excluded.models, updatedAt = excluded.updatedAt"
      )
      .run(row.id, row.name, row.kind, row.models, row.createdAt, row.updatedAt);
  } finally {
    target.close();
  }
  return name;
}

// ---------------------------------------------------------------------------
// System helpers
// ---------------------------------------------------------------------------

/** @param {string} file @param {string[]} args */
function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} file @param {string[]} args */
function tryRun(file, args) {
  try {
    return run(file, args);
  } catch {
    return null;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write through a temp file so a crash never leaves a half-written file.
 * The mode is applied explicitly: cli.js is executed by launchd through a
 * symlink, and the lane API key must stay readable by its owner only.
 *
 * @param {string} path
 * @param {string} content
 * @param {number} [mode]
 */
export function writeAtomic(path, content, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** @param {string} home @param {string|null} override */
function resolveNodeBin(home, override) {
  const candidates = [override, process.env.NODE_BIN, join(home, ".hermes", "node", "bin", "node"), process.execPath];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  throw new Error("node interpreter not found; pass --node-bin");
}

/** @param {string} home @param {string|null} override */
function resolveAppDir(home, override) {
  const candidates = [override, process.env.NINEROUTER_APP_DIR, join(home, ".local", "lib", "node_modules", "9router", "app")];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (existsSync(join(candidate, "custom-server.js"))) return candidate;
  }
  throw new Error("9router app dir not found (custom-server.js missing); pass --app-dir");
}

/** @param {string} appDir */
function assertIsNinrouter(appDir) {
  const pkgPath = join(dirname(appDir), "package.json");
  if (!existsSync(pkgPath)) throw new Error(`not a 9router install: ${pkgPath} missing`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.name !== "9router") throw new Error(`not a 9router install: package name is ${String(pkg.name)}`);
}

/** @param {string} home @param {string|null} override */
function resolveCliPath(home, override) {
  const path = override ?? process.env.NINEROUTER_CLI ?? join(home, ".local", "lib", "node_modules", "9router", "cli.js");
  if (!existsSync(path)) throw new Error(`9router cli.js not found: ${path}`);
  return path;
}

/** @param {string} label */
function launchctlPrint(label) {
  return tryRun("/bin/launchctl", ["print", `gui/${uid()}/${label}`]);
}

/** @param {number} port */
function portPids(port) {
  const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  // LISTEN only: `lsof -ti:port` also reports clients connected to that port.
  const output = tryRun(lsof, ["-ti", `:${port}`, "-sTCP:LISTEN"]);
  if (output === null) return [];
  return output
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
}

/** @param {number} port */
async function probeHealth(port) {
  try {
    const response = await fetch(`http://${LANE_HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return typeof payload === "object" && payload !== null && "ok" in payload && payload.ok === true;
  } catch {
    return false;
  }
}

/** @param {number} port */
async function waitForHealth(port) {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    if (await probeHealth(port)) return true;
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

/**
 * The app creates and migrates its DB lazily, on the first request that touches
 * it. /api/health does not, /dashboard does.
 *
 * @param {number} port
 */
async function requestDashboard(port) {
  try {
    await fetch(`http://${LANE_HOST}:${port}/dashboard`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // The health probe already proved the server answers; keep waiting for the DB.
  }
}

/** @param {string} dbPath */
async function waitForDatabase(dbPath) {
  const deadline = Date.now() + DB_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tableExists(dbPath, "settings")) return true;
    await sleep(DB_WAIT_POLL_MS);
  }
  return false;
}

/**
 * Status of a synthetic completion. With a bogus model the gateway answers 404
 * (auth passed) or 401/403 (missing or rejected key) without calling upstream.
 *
 * @param {number} port
 * @param {string} key
 * @returns {Promise<number>}
 */
async function completionStatus(port, key) {
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`http://${LANE_HOST}:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "__lane_probe__",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(10000),
  });
  return response.status;
}

/**
 * @param {number} port
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function keyIsValid(port, key) {
  try {
    return (await completionStatus(port, key)) !== 401;
  } catch {
    return false;
  }
}

/**
 * @param {number} port
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createApiKey(port, name) {
  const response = await fetch(`http://${LANE_HOST}:${port}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(
      `POST /api/keys on port ${port} failed: HTTP ${response.status} (is requireLogin still enabled?)`
    );
  }
  const payload = await response.json();
  if (typeof payload !== "object" || payload === null || !("key" in payload) || typeof payload.key !== "string") {
    throw new Error(`POST /api/keys on port ${port} returned no key`);
  }
  return payload.key;
}

/**
 * @param {number} port
 * @param {string} key
 */
async function assertLaneAuth(port, key) {
  const withoutKey = await completionStatus(port, "");
  if (withoutKey !== 401) {
    throw new Error(`lane ${port}: expected 401 without an API key, got ${withoutKey}`);
  }
  const withKey = await completionStatus(port, key);
  if (withKey === 401 || withKey === 403) {
    throw new Error(`lane ${port}: the lane API key was rejected (HTTP ${withKey})`);
  }
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * @param {Options} options
 * @param {number[]} ports
 * @returns {Promise<number>}
 */
async function provisionPorts(options, ports) {
  const home = homedir();
  const sourceDb = options.sourceDb
    ? expandHome(home, options.sourceDb)
    : join(home, ".9router", "db", "data.sqlite");
  let failed = false;

  for (const port of ports) {
    const paths = lanePaths(home, port);
    const dataDir = laneDataDir(home, options.dataRoot, port);
    const dbPath = join(dataDir, "db", "data.sqlite");
    const keyPath = join(dataDir, "api-key");

    if (options.dryRun) {
      console.log(`# would provision lane ${port}: data=${dataDir} key=${keyPath}`);
      if (options.copyCombos.length > 0) {
        console.log(`# would copy combos from ${sourceDb}: ${options.copyCombos.join(", ")}`);
      }
      continue;
    }

    if (!launchctlPrint(paths.label)) {
      throw new Error(`lane ${port} is not installed; run install first`);
    }
    if (!(await waitForHealth(port))) {
      throw new Error(`lane ${port} is not healthy; check ${paths.errLog}`);
    }
    await requestDashboard(port);
    if (!(await waitForDatabase(dbPath))) {
      throw new Error(`lane ${port} did not create ${dbPath} within ${DB_WAIT_TIMEOUT_MS / 1000}s; check ${paths.errLog}`);
    }

    const existing = await readSettingsJson(dbPath);
    await writeSettingsJson(
      dbPath,
      mergeSettingsJson(existing, { requireLogin: false, requireApiKey: true })
    );

    let key = existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : "";
    if (!key || !(await keyIsValid(port, key))) {
      key = await createApiKey(port, `lane-${port}`);
      writeAtomic(keyPath, `${key}\n`, 0o600);
    }

    for (const combo of options.copyCombos) {
      await copyComboRow(sourceDb, dbPath, combo);
    }

    // Restart so the app loads the freshly seeded settings/combos exactly once.
    tryRun("/bin/launchctl", ["kickstart", "-k", `gui/${uid()}/${paths.label}`]);
    if (!(await waitForHealth(port))) {
      failed = true;
      console.error(`FAIL ${paths.label}: did not come back after provisioning; check ${paths.errLog}`);
      continue;
    }
    await assertLaneAuth(port, key);

    chmodSync(dataDir, 0o700);
    // The WAL/SHM files are recreated with the process umask, so keep the whole
    // db directory private instead of chasing individual files.
    chmodSync(join(dataDir, "db"), 0o700);
    chmodSync(dbPath, 0o600);
    chmodSync(keyPath, 0o600);
    const summary = await laneSummary(dbPath);
    console.log(
      `ok   ${paths.label} data=${dataDir} key=${keyPath} providers=${summary.providerConnections} combos=${summary.combos}`
    );
  }

  return failed ? 1 : 0;
}

/** @param {Options} options */
async function commandInstall(options) {
  const home = homedir();
  const nodeBin = resolveNodeBin(home, options.nodeBin);
  const appDir = resolveAppDir(home, options.appDir);
  assertIsNinrouter(appDir);
  const ports = validatePorts(options.ports.length > 0 ? options.ports : LANE_PORTS);
  const dataRoot = laneDataRoot(home, options.dataRoot);

  if (!options.dryRun) {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    chmodSync(dataRoot, 0o700);
  }

  for (const port of ports) {
    const paths = lanePaths(home, port);
    const dataDir = laneDataDir(home, options.dataRoot, port);
    const plist = buildLanePlist({
      label: paths.label,
      port,
      host: LANE_HOST,
      nodeBin,
      appDir,
      dataDir,
      home,
      outLog: paths.outLog,
      errLog: paths.errLog,
    });

    if (options.dryRun) {
      console.log(`# ${paths.plistPath}\n${plist}`);
      continue;
    }

    if (launchctlPrint(paths.label)) {
      tryRun("/bin/launchctl", ["bootout", `gui/${uid()}/${paths.label}`]);
      for (let wait = 0; wait < 30 && portPids(port).length > 0; wait += 1) {
        await sleep(100);
      }
    }

    const foreign = portPids(port);
    if (foreign.length > 0) {
      throw new Error(`port ${port} is in use by pid ${foreign.join(", ")}; refusing to kill it`);
    }

    writeAtomic(paths.plistPath, plist);
    run("/usr/bin/plutil", ["-lint", paths.plistPath]);
    try {
      run("/bin/launchctl", ["bootstrap", `gui/${uid()}`, paths.plistPath]);
    } catch (error) {
      throw new Error(
        `launchctl bootstrap failed for ${paths.label}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    console.log(`installed ${paths.label}`);
  }

  if (options.dryRun) return 0;

  let failed = false;
  for (const port of ports) {
    const paths = lanePaths(home, port);
    const health = await waitForHealth(port);
    const job = launchctlPrint(paths.label);
    const summary = job ? summarizeLaunchctl(job) : { state: "missing", pid: null };
    console.log(
      `${health ? "ok  " : "FAIL"} ${paths.label} state=${summary.state} pid=${summary.pid ?? "-"} url=http://${LANE_HOST}:${port}`
    );
    if (!health) {
      failed = true;
      if (existsSync(paths.errLog)) {
        const tail = readFileSync(paths.errLog, "utf8").trim().split("\n").slice(-8).join("\n");
        if (tail) console.error(`--- ${paths.errLog}\n${tail}`);
      }
    }
  }
  if (failed) return 1;

  if (options.skipProvision) return 0;
  return provisionPorts(options, ports);
}

/** @param {Options} options */
async function commandProvision(options) {
  const ports = validatePorts(options.ports.length > 0 ? options.ports : LANE_PORTS);
  return provisionPorts(options, ports);
}

/** @param {Options} options */
async function commandUninstall(options) {
  const home = homedir();
  const ports = validatePorts(options.ports.length > 0 ? options.ports : LANE_PORTS);
  for (const port of ports) {
    const paths = lanePaths(home, port);
    const dataDir = laneDataDir(home, options.dataRoot, port);
    if (options.dryRun) {
      console.log(`# would bootout ${paths.label} and remove ${paths.plistPath}`);
      if (options.purge) console.log(`# would delete ${dataDir}`);
      continue;
    }
    const had = launchctlPrint(paths.label) !== null;
    if (had) {
      tryRun("/bin/launchctl", ["bootout", `gui/${uid()}/${paths.label}`]);
      await sleep(500);
    }
    if (existsSync(paths.plistPath)) rmSync(paths.plistPath);
    if (options.purge) {
      console.log(`purging ${dataDir}`);
      rmSync(dataDir, { recursive: true, force: true });
    } else if (existsSync(dataDir)) {
      console.log(`kept data dir ${dataDir} (use --purge to delete)`);
    }
    console.log(`${had ? "booted out" : "not loaded"} ${paths.label}`);
  }
  return 0;
}

/** @param {Options} options */
async function commandStatus(options) {
  const home = homedir();
  const ports = validatePorts(options.ports.length > 0 ? options.ports : LANE_PORTS);
  const mainHealth = await probeHealth(MAIN_PORT);
  console.log(`main  ${MAIN_PORT}  health=${mainHealth ? "ok" : "down"}  db=${join(home, ".9router", "db", "data.sqlite")}`);

  for (const port of ports) {
    const paths = lanePaths(home, port);
    const dataDir = laneDataDir(home, options.dataRoot, port);
    const dbPath = join(dataDir, "db", "data.sqlite");
    const job = launchctlPrint(paths.label);
    const summary = job ? summarizeLaunchctl(job) : { state: "not installed", pid: null };
    const health = await probeHealth(port);
    let detail = `data=${dataDir}`;
    if (existsSync(dbPath)) {
      try {
        const counts = await laneSummary(dbPath);
        detail += ` keys=${counts.apiKeys} providers=${counts.providerConnections} combos=${counts.combos}`;
      } catch {
        detail += " db=unreadable";
      }
    } else {
      detail += " db=missing (run provision)";
    }
    const hasKey = existsSync(join(dataDir, "api-key"));
    console.log(
      `lane  ${port}  launchd=${summary.state}  pid=${summary.pid ?? "-"}  health=${health ? "ok" : "down"}  ${detail}  api-key=${hasKey ? "yes" : "no"}`
    );
  }

  const cliPath = join(home, ".local", "lib", "node_modules", "9router", "cli.js");
  if (existsSync(cliPath)) {
    const patched = isPatched(readFileSync(cliPath, "utf8"));
    console.log(`patch cli.js: ${patched ? "applied" : "NOT applied (a main restart will bounce every lane)"}`);
  } else {
    console.log(`patch cli.js: missing (${cliPath})`);
  }
  return 0;
}

/** @param {Options} options */
function commandPatch(options) {
  const home = homedir();
  const cliPath = resolveCliPath(home, options.cliPath);
  const backupPath = `${cliPath}${PATCH_BACKUP_SUFFIX}`;
  const current = readFileSync(cliPath, "utf8");

  if (options.action === "verify") {
    const patched = isPatched(current);
    const anchor = current.includes(PATCH_ANCHOR);
    const executable = (statSync(cliPath).mode & 0o111) !== 0;
    console.log(`cli.js:       ${cliPath}`);
    console.log(`patched:      ${patched ? "yes" : "no"}`);
    console.log(`anchor:       ${anchor ? "present" : "MISSING (9router layout changed)"}`);
    console.log(`executable:   ${executable ? "yes" : "NO (launchd cannot exec it)"}`);
    console.log(`backup:       ${existsSync(backupPath) ? backupPath : "missing"}`);
    return patched && anchor && executable ? 0 : 1;
  }

  if (options.action === "apply") {
    const result = applyPatch(current);
    if (!result.changed) {
      console.log("cli.js already patched");
      return 0;
    }
    if (options.dryRun) {
      console.log(PATCH_BLOCK);
      return 0;
    }
    const mode = statSync(cliPath).mode & 0o777;
    if (!existsSync(backupPath)) writeAtomic(backupPath, current, mode);
    const tmp = `${cliPath}.gateway-lanes.tmp.js`;
    writeAtomic(tmp, result.source, mode);
    try {
      run(process.execPath, ["--check", tmp]);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw new Error(`patched cli.js failed syntax check: ${error instanceof Error ? error.message : String(error)}`);
    }
    renameSync(tmp, cliPath);
    console.log(`patched ${cliPath}`);
    console.log(`backup  ${backupPath}`);
    return 0;
  }

  if (options.action === "revert") {
    if (!existsSync(backupPath)) throw new Error(`no backup to revert from: ${backupPath}`);
    const original = readFileSync(backupPath, "utf8");
    if (isPatched(original)) throw new Error("backup is itself patched; refusing to revert");
    const reverted = revertPatch(current);
    if (sha256(reverted) !== sha256(original)) {
      throw new Error("cli.js diverged from the backup (9router update?); refusing to overwrite");
    }
    if (options.dryRun) {
      console.log(`# would restore ${cliPath} from ${backupPath}`);
      return 0;
    }
    writeAtomic(cliPath, reverted, statSync(cliPath).mode & 0o777);
    console.log(`reverted ${cliPath}`);
    return 0;
  }

  throw new Error("unreachable patch action");
}

const USAGE = `Usage: node scripts/gateway-lanes/lanes.mjs <command> [options]

Commands:
  install       write, bootstrap and provision one launchd agent per lane port
  provision     create the lane DB/settings/API key (safe to re-run)
  status        launchd state, health, data dir and row counts per port
  uninstall     bootout lanes and remove their plists (add --purge for data)
  patch         apply|verify|revert the port-scoped killAllAppProcesses patch
  help          show this help

Options:
  --port <port>          lane port (repeatable; default ${LANE_PORTS.join(", ")})
  --data-root <path>     lane data root (default ~/${DEFAULT_DATA_ROOT_NAME})
  --source-db <path>     DB to read --copy-combo from (default ~/.9router/db/data.sqlite)
  --copy-combo <name>    copy one combo definition (no credentials); repeatable
  --skip-provision       install only the launchd agents
  --purge                uninstall: also delete the lane data dir
  --node-bin <path>      node interpreter (default: ~/.hermes/node/bin/node)
  --app-dir <path>       9router app dir (default: ~/.local/lib/node_modules/9router/app)
  --cli-path <path>      9router cli.js (patch only)
  --dry-run              print what would change, touch nothing
`;

/** @param {string[]} [argv] @returns {Promise<number>} */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  try {
    if (options.command === "help") {
      console.log(USAGE);
      return 0;
    }
    if (options.command === "install") return await commandInstall(options);
    if (options.command === "provision") return await commandProvision(options);
    if (options.command === "status") return await commandStatus(options);
    if (options.command === "uninstall") return await commandUninstall(options);
    return commandPatch(options);
  } catch (error) {
    console.error(`gateway-lanes: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`gateway-lanes crashed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
