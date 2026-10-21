import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkHealth,
  decideAction,
  parseArgs,
  probeHealth,
  readState,
  restartService,
  runOnce,
  waitForHealthy,
  writeState,
} from "../../scripts/gateway-watchdog/healthcheck.mjs";

/**
 * The watchdog exists for one failure mode: 9router is alive but its HTTP event
 * loop stopped answering /api/health. These tests pin the decision boundaries
 * (retry, cooldown, restart budget) and the no-restart-when-healthy rule.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "9router-watchdog-"));
  tempDirs.push(dir);
  return dir;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

function refusedError(): Error {
  const error = new Error("fetch failed");
  (error as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  return error;
}

function options(overrides: Partial<ReturnType<typeof parseArgs>> = {}) {
  const dir = tempDir();
  return {
    ...parseArgs([]),
    stateFile: join(dir, "state.json"),
    logFile: join(dir, "watchdog.log"),
    ...overrides,
  };
}

describe("parseArgs()", () => {
  it("uses the documented defaults", () => {
    const parsed = parseArgs([]);
    expect(parsed.healthUrl).toBe("http://127.0.0.1:20128/api/health");
    expect(parsed.timeoutMs).toBe(3000);
    expect(parsed.attempts).toBe(2);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.help).toBe(false);
  });

  it("overrides every operational flag", () => {
    const parsed = parseArgs([
      "--health-url",
      "http://127.0.0.1:9/api/health",
      "--timeout-ms",
      "250",
      "--attempts",
      "1",
      "--state-file",
      "/tmp/state.json",
      "--log-file",
      "/tmp/watchdog.log",
      "--label",
      "com.example.router",
      "--dry-run",
    ]);
    expect(parsed.healthUrl).toBe("http://127.0.0.1:9/api/health");
    expect(parsed.timeoutMs).toBe(250);
    expect(parsed.attempts).toBe(1);
    expect(parsed.stateFile).toBe("/tmp/state.json");
    expect(parsed.logFile).toBe("/tmp/watchdog.log");
    expect(parsed.label).toBe("com.example.router");
    expect(parsed.dryRun).toBe(true);
  });

  it("rejects an unknown flag instead of silently ignoring it", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/i);
  });

  it("rejects a non-numeric timeout", () => {
    expect(() => parseArgs(["--timeout-ms", "soon"])).toThrow(/timeout-ms/i);
  });

  it("rejects a flag without its value", () => {
    expect(() => parseArgs(["--health-url"])).toThrow(/health-url/i);
  });
});

describe("probeHealth()", () => {
  it("accepts a 200 response with ok:true", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const result = await probeHealth("http://health", 1000, fetchImpl);
    expect(result).toMatchObject({ ok: true, kind: "ok", error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a 200 response without ok:true as invalid", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "up" }));
    const result = await probeHealth("http://health", 1000, fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "invalid_response" });
  });

  it("classifies a non-2xx response as http_error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false }, 503));
    const result = await probeHealth("http://health", 1000, fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "http_error" });
    expect(result.error).toContain("503");
  });

  it("classifies ECONNREFUSED as refused", async () => {
    const fetchImpl = vi.fn(async () => {
      throw refusedError();
    });
    const result = await probeHealth("http://health", 1000, fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "refused" });
  });

  it("times out against a server that accepts the connection but never answers", async () => {
    const server = createServer(() => {
      // Intentionally never respond: this is the hung 9router shape.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const result = await probeHealth(`http://127.0.0.1:${address.port}/api/health`, 50);
      expect(result).toMatchObject({ ok: false, kind: "timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("checkHealth()", () => {
  it("retries the configured number of times and reports every kind", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false }, 503));
    const sleep = vi.fn(async () => {});
    const result = await checkHealth({
      url: "http://health",
      attempts: 2,
      timeoutMs: 1000,
      retryDelayMs: 10,
      fetchImpl,
      sleep,
    });
    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.kinds).toEqual(["http_error", "http_error"]);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("stops at the first healthy attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await checkHealth({
      url: "http://health",
      attempts: 2,
      timeoutMs: 1000,
      retryDelayMs: 0,
      fetchImpl,
      sleep: async () => {},
    });
    expect(result.healthy).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("decideAction()", () => {
  const base = { cooldownMs: 30_000, maxRestarts: 5, windowMs: 600_000 };

  it("does nothing while healthy", () => {
    expect(
      decideAction({ ...base, healthy: true, now: 1_000_000, restarts: [1] }).action
    ).toBe("none");
  });

  it("restarts on the first unhealthy observation", () => {
    expect(
      decideAction({ ...base, healthy: false, now: 1_000_000, restarts: [] }).action
    ).toBe("restart");
  });

  it("respects the cooldown after a restart", () => {
    expect(
      decideAction({
        ...base,
        healthy: false,
        now: 1_000_000,
        restarts: [1_000_000 - 5_000],
      }).action
    ).toBe("cooldown");
  });

  it("stops once the restart budget is exhausted", () => {
    const now = 1_000_000;
    const restarts = Array.from({ length: 5 }, (_, index) => now - index * 10_000);
    expect(decideAction({ ...base, healthy: false, now, restarts }).action).toBe("exhausted");
  });

  it("prunes restarts older than the window", () => {
    const now = 10_000_000;
    const result = decideAction({
      ...base,
      healthy: false,
      now,
      restarts: [now - 700_000, now - 10_000],
    });
    expect(result.restarts).toEqual([now - 10_000]);
    expect(result.action).toBe("cooldown");
  });
});

describe("state storage", () => {
  it("round-trips restarts and downSince", () => {
    const file = join(tempDir(), "state.json");
    writeState(file, { restarts: [123, 456], downSince: 789 });
    expect(readState(file)).toEqual({ restarts: [123, 456], downSince: 789 });
  });

  it("falls back to defaults for missing or corrupt state", () => {
    const missing = join(tempDir(), "missing.json");
    expect(readState(missing)).toEqual({ restarts: [], downSince: null });

    const corrupt = join(tempDir(), "corrupt.json");
    writeFileSync(corrupt, "{not json", "utf8");
    expect(readState(corrupt)).toEqual({ restarts: [], downSince: null });
  });
});

describe("restartService()", () => {
  it("does not execute anything in dry-run mode", () => {
    const runCommand = vi.fn();
    const result = restartService({
      label: "com.example.router",
      processPattern: "/tmp/router",
      dryRun: true,
      runCommand,
    });
    expect(result).toMatchObject({ ok: true, method: "dry-run" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("falls back to pkill when launchctl fails", () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("launchctl failed");
      })
      .mockImplementationOnce(() => {});
    const result = restartService({
      label: "com.example.router",
      processPattern: "/tmp/router",
      runCommand,
    });
    expect(result).toMatchObject({ ok: true, method: "pkill" });
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "/bin/launchctl",
      ["kickstart", "-k", expect.stringContaining("com.example.router")]
    );
    expect(runCommand).toHaveBeenNthCalledWith(2, "/usr/bin/pkill", [
      "-TERM",
      "-f",
      "/tmp/router",
    ]);
  });
});

describe("waitForHealthy()", () => {
  it("recovers when a later poll succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await waitForHealthy({
      url: "http://health",
      timeoutMs: 1000,
      pollMs: 1,
      fetchImpl,
      sleep: async () => {},
    });
    expect(result.healthy).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("gives up after the deadline", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false }, 503));
    const result = await waitForHealthy({
      url: "http://health",
      timeoutMs: 20,
      pollMs: 2,
      fetchImpl,
    });
    expect(result.healthy).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(20);
  });
});

describe("deployment path guard", () => {
  it("does not live under a /9router path segment", () => {
    const modulePath = fileURLToPath(
      new URL("../../scripts/gateway-watchdog/healthcheck.mjs", import.meta.url)
    );
    // 9router's startup killAllAppProcesses() kills node processes whose command
    // line contains "/9router"; this watchdog must stay outside that pattern.
    expect(modulePath).not.toContain("/9router");
    expect(modulePath).not.toContain("cli.js");
  });
});

describe("runOnce()", () => {
  it("stays silent and never restarts while 9router is healthy", async () => {
    const opts = options();
    const restart = vi.fn();
    const log = vi.fn();
    const result = await runOnce(opts, {
      fetchImpl: async () => jsonResponse({ ok: true }),
      restart,
      log,
      sleep: async () => {},
    });
    expect(result.status).toBe("healthy");
    expect(restart).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(existsSync(opts.stateFile)).toBe(false);
  });

  it("restarts once on a timeout and records the restart", async () => {
    const opts = options({
      retryDelayMs: 0,
      startupTimeoutMs: 10,
      startupPollMs: 1,
    });
    const restart = vi.fn(() => ({ ok: true, method: "launchctl", error: null }));
    const log = vi.fn();
    const result = await runOnce(opts, {
      fetchImpl: async () => {
        throw timeoutError();
      },
      restart,
      log,
      sleep: async () => {},
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("restart-failed");
    const state = JSON.parse(readFileSync(opts.stateFile, "utf8")) as { restarts: number[] };
    expect(state.restarts).toHaveLength(1);
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/action=restart/);
  });

  it("gives a refused connection a startup grace before restarting", async () => {
    const opts = options({
      retryDelayMs: 0,
      startupTimeoutMs: 5,
      startupPollMs: 1,
    });
    const restart = vi.fn(() => ({ ok: true, method: "launchctl", error: null }));
    const log = vi.fn();
    const fetchImpl = async () => {
      throw refusedError();
    };
    let current = 1_000_000;

    const first = await runOnce(opts, {
      fetchImpl,
      restart,
      log,
      sleep: async () => {},
      now: () => current,
    });
    expect(first.status).toBe("starting");
    expect(restart).not.toHaveBeenCalled();

    current += 16_000;
    const second = await runOnce(opts, {
      fetchImpl,
      restart,
      log,
      sleep: async () => {},
      now: () => current,
    });
    expect(second.status).toBe("restart-failed");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart or write state in dry-run mode", async () => {
    const opts = options({ retryDelayMs: 0, dryRun: true });
    const restart = vi.fn();
    const log = vi.fn();
    const result = await runOnce(opts, {
      fetchImpl: async () => {
        throw timeoutError();
      },
      restart,
      log,
      sleep: async () => {},
    });
    expect(result.status).toBe("dry-run");
    expect(restart).not.toHaveBeenCalled();
    expect(existsSync(opts.stateFile)).toBe(false);
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/dryRun=true/);
  });

  it("does not write state for a refused dry-run", async () => {
    const opts = options({ retryDelayMs: 0, dryRun: true });
    const restart = vi.fn();
    const log = vi.fn();
    const result = await runOnce(opts, {
      fetchImpl: async () => {
        throw refusedError();
      },
      restart,
      log,
      sleep: async () => {},
    });
    expect(result.status).toBe("starting");
    expect(restart).not.toHaveBeenCalled();
    expect(existsSync(opts.stateFile)).toBe(false);
  });

  it("honours the cooldown instead of restarting again", async () => {
    const opts = options({ retryDelayMs: 0, startupTimeoutMs: 5, startupPollMs: 1 });
    const restart = vi.fn(() => ({ ok: true, method: "launchctl", error: null }));
    const log = vi.fn();
    const fetchImpl = async () => {
      throw timeoutError();
    };
    let current = 1_000_000;
    await runOnce(opts, { fetchImpl, restart, log, sleep: async () => {}, now: () => current });
    expect(restart).toHaveBeenCalledTimes(1);

    current += 5_000;
    const second = await runOnce(opts, {
      fetchImpl,
      restart,
      log,
      sleep: async () => {},
      now: () => current,
    });
    expect(second.status).toBe("cooldown");
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
