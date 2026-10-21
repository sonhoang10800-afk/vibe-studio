#!/usr/bin/env node
// @ts-check
/**
 * 9router health watchdog.
 *
 * 9router can stay alive while its HTTP event loop stops answering. The old
 * healthcheck waited 30s per attempt and could spend a minute before deciding
 * to restart; this module answers the same question in a few seconds and keeps
 * a restart budget so a broken service cannot cause a restart storm.
 *
 * Scope: restart only when /api/health is unresponsive. Provider-side
 * "fetch connect timeout" errors do not affect health and are out of scope.
 *
 * The directory is gateway-watchdog, not 9router-watchdog, on purpose:
 * 9router's startup killAllAppProcesses() kills any node process whose command
 * line contains "/9router"; a script under .../9router-watchdog/ would be
 * killed mid-restart before it could record recovery.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {"ok"|"timeout"|"refused"|"http_error"|"invalid_response"|"error"} ProbeKind
 * @typedef {{ ok: boolean, kind: ProbeKind, latencyMs: number, error: string|null }} ProbeResult
 * @typedef {{ healthy: boolean, attempts: number, kinds: ProbeKind[], latencies: number[], lastError: string|null }} HealthResult
 * @typedef {{ restarts: number[], downSince: number|null }} WatchdogState
 * @typedef {{ action: "none"|"restart"|"cooldown"|"exhausted", restarts: number[] }} Decision
 * @typedef {(file: string, args: string[]) => void} RunCommand
 * @typedef {{ label: string, processPattern: string, dryRun?: boolean, runCommand?: RunCommand }} RestartOptions
 * @typedef {{
 *   healthUrl: string,
 *   timeoutMs: number,
 *   attempts: number,
 *   retryDelayMs: number,
 *   cooldownMs: number,
 *   maxRestarts: number,
 *   windowMs: number,
 *   startupGraceMs: number,
 *   startupTimeoutMs: number,
 *   startupPollMs: number,
 *   stateFile: string,
 *   logFile: string,
 *   label: string,
 *   processPattern: string,
 *   dryRun: boolean,
 *   help: boolean
 * }} WatchdogOptions
 */

/** @type {WatchdogOptions} */
export const DEFAULTS = {
  healthUrl: "http://127.0.0.1:20128/api/health",
  timeoutMs: 3000,
  attempts: 2,
  retryDelayMs: 1000,
  cooldownMs: 30_000,
  maxRestarts: 5,
  windowMs: 600_000,
  startupGraceMs: 15_000,
  startupTimeoutMs: 30_000,
  startupPollMs: 500,
  stateFile: join(homedir(), ".9router", "watchdog-state.json"),
  logFile: join(homedir(), "Library", "Logs", "9router-watchdog.out.log"),
  label: "com.hoangson.9router",
  processPattern: join(homedir(), ".local/bin", "9router"),
  dryRun: false,
  help: false,
};

const USAGE = `Usage: node scripts/gateway-watchdog/healthcheck.mjs [options]

Options:
  --health-url <url>    Health endpoint (default: ${DEFAULTS.healthUrl})
  --timeout-ms <ms>     Per-attempt timeout (default: ${DEFAULTS.timeoutMs})
  --attempts <count>    Attempts before restart (default: ${DEFAULTS.attempts})
  --state-file <path>   Restart state file (default: ${DEFAULTS.stateFile})
  --log-file <path>     Durable log file (default: ${DEFAULTS.logFile})
  --label <launchd>     launchd job label (default: ${DEFAULTS.label})
  --dry-run             Detect and log, never restart
  --help                Show this help
`;

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {string|null}
 */
function errorCode(error) {
  if (typeof error !== "object" || error === null) return null;
  /** @type {{ cause?: { code?: unknown, errors?: Array<{ code?: unknown }> } }} */
  const withCause = error;
  if (typeof withCause.cause?.code === "string") return withCause.cause.code;
  const firstCauseCode = withCause.cause?.errors?.[0]?.code;
  return typeof firstCauseCode === "string" ? firstCauseCode : null;
}

/**
 * @param {unknown} error
 * @returns {ProbeKind}
 */
export function classifyFetchError(error) {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (errorCode(error) === "ECONNREFUSED") return "refused";
  return "error";
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Probe the health endpoint once. A 2xx response is only healthy when its JSON
 * body is the `{ok:true}` contract; a 200 HTML page from a stray proxy must not
 * hide a dead gateway.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<ProbeResult>}
 */
export async function probeHealth(url, timeoutMs, fetchImpl = fetch) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, kind: "http_error", latencyMs, error: `HTTP ${response.status}` };
    }
    /** @type {unknown} */
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return {
        ok: false,
        kind: "invalid_response",
        latencyMs,
        error: `invalid JSON: ${errorMessage(error)}`,
      };
    }
    if (typeof payload !== "object" || payload === null || !("ok" in payload) || payload.ok !== true) {
      return { ok: false, kind: "invalid_response", latencyMs, error: "health body is not {ok:true}" };
    }
    return { ok: true, kind: "ok", latencyMs, error: null };
  } catch (error) {
    return {
      ok: false,
      kind: classifyFetchError(error),
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

/**
 * @param {{
 *   url: string,
 *   attempts: number,
 *   timeoutMs: number,
 *   retryDelayMs: number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>
 * }} options
 * @returns {Promise<HealthResult>}
 */
export async function checkHealth({
  url,
  attempts,
  timeoutMs,
  retryDelayMs,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  /** @type {ProbeKind[]} */
  const kinds = [];
  /** @type {number[]} */
  const latencies = [];
  /** @type {string|null} */
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await probeHealth(url, timeoutMs, fetchImpl);
    kinds.push(probe.kind);
    latencies.push(probe.latencyMs);
    if (probe.ok) {
      return { healthy: true, attempts: attempt + 1, kinds, latencies, lastError: null };
    }
    lastError = probe.error;
    if (attempt < attempts - 1) await sleep(retryDelayMs);
  }

  return { healthy: false, attempts, kinds, latencies, lastError };
}

/**
 * Decide whether a restart is allowed right now. Old timestamps are pruned so a
 * single restart last week cannot exhaust today's budget.
 *
 * @param {{
 *   healthy: boolean,
 *   now: number,
 *   restarts: number[],
 *   cooldownMs: number,
 *   maxRestarts: number,
 *   windowMs: number
 * }} options
 * @returns {Decision}
 */
export function decideAction({ healthy, now, restarts, cooldownMs, maxRestarts, windowMs }) {
  const source = Array.isArray(restarts) ? restarts : [];
  const recent = source
    .filter(isFiniteNumber)
    .filter((value) => now - value < windowMs)
    .sort((left, right) => left - right);

  if (healthy) return { action: "none", restarts: recent };
  if (recent.length >= maxRestarts) return { action: "exhausted", restarts: recent };
  const lastRestart = recent[recent.length - 1];
  if (typeof lastRestart === "number" && now - lastRestart < cooldownMs) {
    return { action: "cooldown", restarts: recent };
  }
  return { action: "restart", restarts: recent };
}

/**
 * @param {string} path
 * @returns {WatchdogState}
 */
export function readState(path) {
  try {
    /** @type {unknown} */
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return { restarts: [], downSince: null };
    /** @type {{ restarts?: unknown, downSince?: unknown }} */
    const record = raw;
    const restarts = Array.isArray(record.restarts)
      ? record.restarts.filter(isFiniteNumber)
      : [];
    const downSince = isFiniteNumber(record.downSince) ? record.downSince : null;
    return { restarts, downSince };
  } catch {
    // A missing or corrupt state file must never block a restart: start clean.
    return { restarts: [], downSince: null };
  }
}

/**
 * @param {string} path
 * @param {WatchdogState} state
 */
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(tempPath, path);
}

/**
 * @param {string} file
 * @param {string[]} args
 */
function defaultRunCommand(file, args) {
  execFileSync(file, args, { stdio: "pipe", timeout: 10_000 });
}

/**
 * @param {RestartOptions} options
 * @returns {{ ok: boolean, method: "launchctl"|"pkill"|"dry-run"|"none", error: string|null }}
 */
export function restartService({ label, processPattern, dryRun = false, runCommand = defaultRunCommand }) {
  if (dryRun) return { ok: true, method: "dry-run", error: null };

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  try {
    runCommand("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
    return { ok: true, method: "launchctl", error: null };
  } catch (launchctlError) {
    try {
      runCommand("/usr/bin/pkill", ["-TERM", "-f", processPattern]);
      return { ok: true, method: "pkill", error: null };
    } catch (pkillError) {
      return {
        ok: false,
        method: "none",
        error: `launchctl: ${errorMessage(launchctlError)}; pkill: ${errorMessage(pkillError)}`,
      };
    }
  }
}

/**
 * Poll after a restart so the log records whether the service actually came
 * back, instead of assuming kickstart success means recovery.
 *
 * @param {{
 *   url: string,
 *   timeoutMs: number,
 *   pollMs: number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>
 * }} options
 * @returns {Promise<{ healthy: boolean, attempts: number, elapsedMs: number }>}
 */
export async function waitForHealthy({ url, timeoutMs, pollMs, fetchImpl = fetch, sleep = defaultSleep }) {
  const startedAt = Date.now();
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return { healthy: false, attempts, elapsedMs: Date.now() - startedAt };

    const probe = await probeHealth(url, Math.max(1, Math.min(remaining, 1000)), fetchImpl);
    if (probe.ok) return { healthy: true, attempts, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) {
      return { healthy: false, attempts, elapsedMs: Date.now() - startedAt };
    }
    await sleep(pollMs);
  }
}

/**
 * @param {string} path
 * @param {WatchdogState} state
 * @param {(line: string) => void} log
 */
function persistState(path, state, log) {
  try {
    writeState(path, state);
  } catch (error) {
    log(`state-write-failed error=${errorMessage(error)}`);
  }
}

/**
 * @param {ProbeKind[]} kinds
 * @returns {string}
 */
function uniqueKinds(kinds) {
  return [...new Set(kinds)].join(",");
}

/**
 * @param {string} path
 * @param {string} line
 */
export function appendLog(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch (error) {
    console.error(`watchdog log write failed: ${errorMessage(error)}`);
  }
}

/**
 * Run one watchdog pass.
 *
 * @param {WatchdogOptions} options
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   restart?: (options: RestartOptions) => { ok: boolean, method: string, error: string|null },
 *   now?: () => number,
 *   log?: (line: string) => void
 * }} [deps]
 * @returns {Promise<{
 *   status: "healthy"|"starting"|"cooldown"|"exhausted"|"dry-run"|"restarted"|"restart-failed",
 *   health: HealthResult,
 *   action: string,
 *   restart?: { ok: boolean, method: string, error: string|null },
 *   recovery?: { healthy: boolean, attempts: number, elapsedMs: number }
 * }>}
 */
export async function runOnce(options, deps = {}) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const restart = deps.restart ?? restartService;
  const log = deps.log ?? ((line) => appendLog(options.logFile, line));
  /** @type {(next: WatchdogState) => void} */
  const persist = options.dryRun
    ? () => {}
    : (next) => persistState(options.stateFile, next, log);

  const health = await checkHealth({
    url: options.healthUrl,
    attempts: options.attempts,
    timeoutMs: options.timeoutMs,
    retryDelayMs: options.retryDelayMs,
    fetchImpl,
    sleep,
  });
  const currentTime = now();
  const state = readState(options.stateFile);
  const decision = decideAction({
    healthy: health.healthy,
    now: currentTime,
    restarts: state.restarts,
    cooldownMs: options.cooldownMs,
    maxRestarts: options.maxRestarts,
    windowMs: options.windowMs,
  });

  if (health.healthy) {
    if (state.downSince !== null) {
      persist({ restarts: decision.restarts, downSince: null });
    }
    return { status: "healthy", health, action: decision.action };
  }

  const allRefused = health.kinds.every((kind) => kind === "refused");
  if (allRefused) {
    const downSince = state.downSince ?? currentTime;
    if (currentTime - downSince < options.startupGraceMs) {
      persist({ restarts: decision.restarts, downSince });
      log(`starting kind=refused downForMs=${currentTime - downSince}`);
      return { status: "starting", health, action: "starting" };
    }
  }

  if (decision.action !== "restart") {
    if (decision.action !== "none") {
      persist({ restarts: decision.restarts, downSince: null });
      log(`unhealthy kind=${uniqueKinds(health.kinds)} action=${decision.action}`);
      return { status: decision.action, health, action: decision.action };
    }
    // decideAction never returns "none" for an unhealthy probe; fail safe rather than restart.
    return { status: "healthy", health, action: "none" };
  }

  if (options.dryRun) {
    log(`unhealthy kind=${uniqueKinds(health.kinds)} action=restart dryRun=true`);
    return { status: "dry-run", health, action: "restart" };
  }

  log(`unhealthy kind=${uniqueKinds(health.kinds)} action=restart`);
  const restartResult = restart({
    label: options.label,
    processPattern: options.processPattern,
    dryRun: false,
  });
  persist({ restarts: [...decision.restarts, currentTime], downSince: null });
  log(
    `restart method=${restartResult.method} ok=${String(restartResult.ok)}${
      restartResult.error ? ` error=${restartResult.error}` : ""
    }`
  );

  if (!restartResult.ok) {
    return { status: "restart-failed", health, action: "restart", restart: restartResult };
  }

  const recovery = await waitForHealthy({
    url: options.healthUrl,
    timeoutMs: options.startupTimeoutMs,
    pollMs: options.startupPollMs,
    fetchImpl,
    sleep,
  });
  log(`recovery healthy=${String(recovery.healthy)} waitedMs=${recovery.elapsedMs}`);
  return {
    status: recovery.healthy ? "restarted" : "restart-failed",
    health,
    action: "restart",
    restart: restartResult,
    recovery,
  };
}

/**
 * @param {string[]} argv
 * @returns {WatchdogOptions}
 */
export function parseArgs(argv) {
  /** @type {WatchdogOptions} */
  const options = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--health-url" || arg === "--state-file" || arg === "--log-file" || arg === "--label") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--label" && !/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error("--label must look like a launchd label");
      }
      if (arg === "--health-url") options.healthUrl = value;
      else if (arg === "--state-file") options.stateFile = value;
      else if (arg === "--log-file") options.logFile = value;
      else options.label = value;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" || arg === "--attempts") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${arg} requires a positive integer`);
      }
      if (arg === "--timeout-ms") options.timeoutMs = parsed;
      else options.attempts = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {WatchdogOptions} */
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const result = await runOnce(options);
    if (options.dryRun) {
      console.log(
        JSON.stringify(
          { status: result.status, action: result.action, kinds: result.health.kinds },
          null,
          2
        )
      );
    }
    return 0;
  } catch (error) {
    console.error(`watchdog failed: ${errorMessage(error)}`);
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
      console.error(`watchdog crashed: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
}
