import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_DATA_ROOT_NAME,
  LANE_PORTS,
  MAIN_PORT,
  PATCH_ANCHOR,
  PATCH_BEGIN,
  PATCH_END,
  applyPatch,
  buildLanePlist,
  copyComboRow,
  escapeXml,
  expandHome,
  isPatched,
  laneDataDir,
  laneDataRoot,
  laneLabel,
  lanePaths,
  laneSummary,
  mergeSettingsJson,
  parseArgs,
  readSettingsJson,
  revertPatch,
  summarizeLaunchctl,
  tableExists,
  validatePorts,
  writeAtomic,
  writeSettingsJson,
} from "../../scripts/gateway-lanes/lanes.mjs";

/**
 * Invariants that must never regress:
 *  1. the cli.js patch is a byte-exact, reversible transform — it edits a vendor
 *     file that `npm i -g 9router` will replace;
 *  2. a lane launches the Next server directly, never the `9router` CLI, and owns
 *     its own DATA_DIR — that is what makes ports independent;
 *  3. lane provisioning writes settings/keys without clobbering other settings.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-lanes-"));
  tempDirs.push(dir);
  return dir;
}

const ANCHOR_LINE = PATCH_ANCHOR.trimEnd();

const CLI_FIXTURE = [
  "function killAllAppProcesses(appPort) {",
  "  const pids = [];",
  ANCHOR_LINE,
  "  if (pids.length > 0) {",
  "  }",
  "}",
  "",
].join("\n");

function laneDb(path: string, options: { combos?: Array<[string, string, string]> } = {}): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL);
    CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
  `);
  for (const [id, name, models] of options.combos ?? []) {
    db.prepare(
      "INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, name, "fallback", models, "2026-10-22T00:00:00Z", "2026-10-22T00:00:00Z");
  }
  db.close();
  return path;
}

describe("applyPatch() / revertPatch() / isPatched()", () => {
  it("inserts the port-scoped filter before the kill block", () => {
    const patched = applyPatch(CLI_FIXTURE);

    expect(patched.changed).toBe(true);
    expect(isPatched(patched.source)).toBe(true);
    expect(patched.source).toContain("ownPortPids");
    expect(patched.source).toContain('fs.existsSync("/usr/sbin/lsof")');
    // LISTEN only: a bare -ti:port also reports clients connected to the port.
    expect(patched.source).toContain("-ti:${appPort} -sTCP:LISTEN");
    expect(patched.source.indexOf(PATCH_BEGIN)).toBeLessThan(patched.source.indexOf(PATCH_END));
    expect(patched.source.indexOf(PATCH_END)).toBeLessThan(patched.source.indexOf(ANCHOR_LINE));

    // The vendor's own kill block is untouched.
    expect(patched.source).toContain("if (pids.length > 0) {");
  });

  it("is a no-op when already patched", () => {
    const patched = applyPatch(CLI_FIXTURE);
    const again = applyPatch(patched.source);

    expect(again.changed).toBe(false);
    expect(again.source).toBe(patched.source);
  });

  it("reverts to a byte-identical original", () => {
    const patched = applyPatch(CLI_FIXTURE);

    expect(revertPatch(patched.source)).toBe(CLI_FIXTURE);
  });

  it("leaves an unpatched file untouched on revert", () => {
    expect(revertPatch(CLI_FIXTURE)).toBe(CLI_FIXTURE);
  });

  it("refuses to patch when the anchor is missing", () => {
    expect(() => applyPatch("function killAllAppProcesses() {}\n")).toThrow(/anchor not found/);
  });

  it("refuses to patch when the anchor is ambiguous", () => {
    const ambiguous = `${CLI_FIXTURE}${ANCHOR_LINE}\n`;

    expect(() => applyPatch(ambiguous)).toThrow(/ambiguous/);
  });

  it("produces syntactically valid JavaScript", () => {
    const dir = tempDir();
    const file = join(dir, "cli.js");
    writeFileSync(file, applyPatch(CLI_FIXTURE).source, "utf8");

    expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).not.toThrow();
  });
});

describe("buildLanePlist()", () => {
  const dataDir = `/Users/example/${DEFAULT_DATA_ROOT_NAME}/${LANE_PORTS[0]}`;
  const options = {
    label: laneLabel(LANE_PORTS[0]),
    port: LANE_PORTS[0],
    host: "127.0.0.1",
    nodeBin: "/Users/example/.hermes/node/bin/node",
    appDir: "/Users/example/.local/lib/node_modules/9router/app",
    dataDir,
    home: "/Users/example",
    outLog: "/Users/example/Library/Logs/9router-lane-20130.out.log",
    errLog: "/Users/example/Library/Logs/9router-lane-20130.err.log",
  };

  it("launches the Next server directly, never the 9router CLI", () => {
    const plist = buildLanePlist(options);

    expect(plist).toContain(`${options.appDir}/custom-server.js`);
    expect(plist).not.toContain("/.local/bin/9router");
    expect(plist).not.toContain("cli.js");
  });

  it("prepends /usr/sbin so absolute tooling resolves under launchd", () => {
    expect(buildLanePlist(options)).toContain("<string>/usr/sbin:/Users/example/.local/bin:");
  });

  it("gives every port its own data dir and no shared main dir", () => {
    const plist = buildLanePlist(options);

    expect(plist).toContain(`<key>DATA_DIR</key>\n    <string>${dataDir}</string>`);
    expect(plist).not.toContain("/Users/example/.9router</string>");
    expect(plist).toContain(
      `<string>${dataDir}/runtime/node_modules:${options.appDir}/node_modules</string>`
    );
  });

  it("lets each lane refresh its own tokens (no cross-lane duplication anymore)", () => {
    expect(buildLanePlist(options)).not.toContain("DISABLE_BACKGROUND_TOKEN_REFRESH");
  });

  it("pins the lane contract: localhost and its own port", () => {
    const plist = buildLanePlist(options);

    expect(plist).toContain(`<key>Label</key>\n  <string>com.hoangson.9router-lane-${options.port}</string>`);
    expect(plist).toContain(`<key>PORT</key>\n    <string>${options.port}</string>`);
    expect(plist).toContain("<key>HOSTNAME</key>\n    <string>127.0.0.1</string>");
  });

  it("keeps the lane supervised", () => {
    const plist = buildLanePlist(options);

    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    expect(plist).toContain(options.outLog);
    expect(plist).toContain(options.errLog);
  });

  it("escapes XML-sensitive characters in every path", () => {
    const plist = buildLanePlist({ ...options, appDir: "/Users/example/a&b<app>", nodeBin: "/n\"ode" });

    expect(plist).toContain("/Users/example/a&amp;b&lt;app&gt;/custom-server.js");
    expect(plist).toContain("/n&quot;ode");
    expect(plist).not.toContain("a&b");
  });

  it("is a plist that plutil accepts", () => {
    if (process.platform !== "darwin") return;
    const file = join(tempDir(), "lane.plist");
    writeFileSync(file, buildLanePlist(options), "utf8");

    expect(() => execFileSync("/usr/bin/plutil", ["-lint", file], { stdio: "pipe" })).not.toThrow();
  });
});

describe("escapeXml()", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml(`a&<>"'b`)).toBe("a&amp;&lt;&gt;&quot;&apos;b");
  });
});

describe("laneDataRoot() / laneDataDir() / expandHome()", () => {
  it("derives one data dir per port under the default root", () => {
    expect(laneDataRoot("/Users/example", null)).toBe(`/Users/example/${DEFAULT_DATA_ROOT_NAME}`);
    expect(laneDataDir("/Users/example", null, 20130)).toBe(
      `/Users/example/${DEFAULT_DATA_ROOT_NAME}/20130`
    );
    expect(laneDataDir("/Users/example", null, 20133)).toBe(
      `/Users/example/${DEFAULT_DATA_ROOT_NAME}/20133`
    );
  });

  it("keeps ports on separate paths even for a custom root", () => {
    const first = laneDataDir("/Users/example", "/Volumes/tmp/lanes", 20130);
    const second = laneDataDir("/Users/example", "/Volumes/tmp/lanes", 20133);

    expect(first).not.toBe(second);
    expect(first.startsWith("/Volumes/tmp/lanes/")).toBe(true);
  });

  it("expands ~ in the root", () => {
    expect(expandHome("/Users/example", "~/ops")).toBe("/Users/example/ops");
    expect(expandHome("/Users/example", "~")).toBe("/Users/example");
    expect(laneDataDir("/Users/example", "~/lanes", 20130)).toBe("/Users/example/lanes/20130");
  });
});

describe("laneLabel() / lanePaths()", () => {
  it("derives the label from the port", () => {
    expect(laneLabel(20130)).toBe("com.hoangson.9router-lane-20130");
  });

  it("keeps plists and logs per port", () => {
    const paths = lanePaths("/Users/example", 20133);

    expect(paths.plistPath).toBe(
      "/Users/example/Library/LaunchAgents/com.hoangson.9router-lane-20133.plist"
    );
    expect(paths.outLog).toBe("/Users/example/Library/Logs/9router-lane-20133.out.log");
    expect(paths.errLog).toBe("/Users/example/Library/Logs/9router-lane-20133.err.log");
  });
});

describe("validatePorts()", () => {
  it("accepts the documented lane ports", () => {
    expect(validatePorts([...LANE_PORTS])).toEqual([...LANE_PORTS]);
  });

  it("rejects duplicates", () => {
    expect(() => validatePorts([20130, 20130])).toThrow(/duplicate/);
  });

  it("rejects the main gateway port", () => {
    expect(() => validatePorts([MAIN_PORT])).toThrow(/reserved/);
  });

  it("rejects privileged and out-of-range ports", () => {
    expect(() => validatePorts([80])).toThrow(/range/);
    expect(() => validatePorts([70000])).toThrow(/range/);
  });

  it("rejects an empty list and non-integers", () => {
    expect(() => validatePorts([])).toThrow(/at least one/);
    expect(() => validatePorts([Number.NaN])).toThrow(/integer/);
  });
});

describe("parseArgs()", () => {
  it("defaults to help with no arguments", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("collects repeated --port values", () => {
    const options = parseArgs(["install", "--port", "20130", "--port", "20133", "--dry-run"]);

    expect(options.command).toBe("install");
    expect(options.ports).toEqual([20130, 20133]);
    expect(options.dryRun).toBe(true);
  });

  it("supports provision-specific flags", () => {
    const options = parseArgs([
      "provision",
      "--port",
      "20130",
      "--data-root",
      "/tmp/lanes",
      "--source-db",
      "/tmp/main.sqlite",
      "--copy-combo",
      "a",
      "--copy-combo",
      "b",
      "--skip-provision",
    ]);

    expect(options.command).toBe("provision");
    expect(options.dataRoot).toBe("/tmp/lanes");
    expect(options.sourceDb).toBe("/tmp/main.sqlite");
    expect(options.copyCombos).toEqual(["a", "b"]);
    expect(options.skipProvision).toBe(true);
  });

  it("supports uninstall --purge", () => {
    expect(parseArgs(["uninstall", "--purge"]).purge).toBe(true);
  });

  it("requires a patch action", () => {
    expect(() => parseArgs(["patch"])).toThrow(/apply, verify, revert/);
    expect(parseArgs(["patch", "verify"]).action).toBe("verify");
  });

  it("rejects unknown commands and options", () => {
    expect(() => parseArgs(["start"])).toThrow(/unknown command/);
    expect(() => parseArgs(["install", "--wat"])).toThrow(/unknown option/);
  });

  it("rejects a missing or malformed value", () => {
    expect(() => parseArgs(["install", "--port"])).toThrow(/requires a value/);
    expect(() => parseArgs(["install", "--port", "20x"])).toThrow(/integer/);
    expect(() => parseArgs(["provision", "--copy-combo"])).toThrow(/requires a value/);
  });
});

describe("mergeSettingsJson()", () => {
  it("keeps every unrelated setting and applies the lane auth contract", () => {
    const merged = JSON.parse(
      mergeSettingsJson('{"requireLogin":true,"cavemanEnabled":true}', {
        requireLogin: false,
        requireApiKey: true,
      })
    );

    expect(merged).toEqual({ requireLogin: false, requireApiKey: true, cavemanEnabled: true });
  });

  it("starts from an empty object when the lane has no settings row yet", () => {
    expect(JSON.parse(mergeSettingsJson(null, { requireLogin: false, requireApiKey: true }))).toEqual({
      requireLogin: false,
      requireApiKey: true,
    });
    expect(JSON.parse(mergeSettingsJson("  ", { requireLogin: false, requireApiKey: true }))).toEqual({
      requireLogin: false,
      requireApiKey: true,
    });
  });

  it("refuses to overwrite a corrupt settings row", () => {
    expect(() => mergeSettingsJson("{not json", { requireLogin: false, requireApiKey: true })).toThrow(
      /not valid JSON/
    );
    expect(() => mergeSettingsJson("[1,2]", { requireLogin: false, requireApiKey: true })).toThrow(
      /not a JSON object/
    );
  });
});

describe("lane DB helpers", () => {
  it("round-trips the settings row without touching other columns", async () => {
    const file = laneDb(join(tempDir(), "data.sqlite"));

    expect(await readSettingsJson(file)).toBeNull();

    await writeSettingsJson(file, '{"requireLogin":false}');
    expect(await readSettingsJson(file)).toBe('{"requireLogin":false}');

    await writeSettingsJson(file, '{"requireLogin":true,"requireApiKey":false}');
    expect(await readSettingsJson(file)).toBe('{"requireLogin":true,"requireApiKey":false}');
  });

  it("reports which tables exist and tolerates a missing file", async () => {
    const dir = tempDir();
    const file = laneDb(join(dir, "data.sqlite"));

    expect(await tableExists(file, "settings")).toBe(true);
    expect(await tableExists(file, "nope")).toBe(false);
    expect(await tableExists(join(dir, "missing.sqlite"), "settings")).toBe(false);
  });

  it("counts keys, providers and combos for status output", async () => {
    const file = laneDb(join(tempDir(), "data.sqlite"), {
      combos: [["c1", "openrouter-minimax-m3.1-flash", '["openrouter/minimax/minimax-m3.1-flash:free"]']],
    });
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO apiKeys (id, key) VALUES (?, ?)").run("k1", "sk-test");
    db.prepare("INSERT INTO providerConnections (id, provider) VALUES (?, ?)").run("p1", "openrouter");
    db.close();

    expect(await laneSummary(file)).toEqual({ apiKeys: 1, providerConnections: 1, combos: 1 });
  });

  it("copies a combo definition into a lane DB", async () => {
    const source = laneDb(join(tempDir(), "main.sqlite"), {
      combos: [["c1", "smart", '["openrouter/minimax/minimax-m3.1-flash:free"]']],
    });
    const target = laneDb(join(tempDir(), "lane.sqlite"));

    expect(await copyComboRow(source, target, "smart")).toBe("smart");

    const db = new DatabaseSync(target, { readOnly: true });
    const row = db.prepare("SELECT models FROM combos WHERE name = ?").get("smart");
    db.close();
    expect(row).toEqual({ models: '["openrouter/minimax/minimax-m3.1-flash:free"]' });
  });

  it("updates an existing combo instead of failing on the unique name", async () => {
    const source = laneDb(join(tempDir(), "main.sqlite"), {
      combos: [["c1", "smart", '["new/model"]']],
    });
    const target = laneDb(join(tempDir(), "lane.sqlite"), {
      combos: [["old", "smart", '["old/model"]']],
    });

    await copyComboRow(source, target, "smart");

    const db = new DatabaseSync(target, { readOnly: true });
    const rows = db.prepare("SELECT COUNT(*) AS n, MAX(models) AS models FROM combos").get() as {
      n: number;
      models: string;
    };
    db.close();
    expect(rows.n).toBe(1);
    expect(rows.models).toBe('["new/model"]');
  });

  it("fails clearly when the combo does not exist", async () => {
    const source = laneDb(join(tempDir(), "main.sqlite"));
    const target = laneDb(join(tempDir(), "lane.sqlite"));

    await expect(copyComboRow(source, target, "nope")).rejects.toThrow(/combo not found/);
    await expect(copyComboRow(join(tempDir(), "missing.sqlite"), target, "x")).rejects.toThrow(
      /source DB not found/
    );
  });
});

describe("summarizeLaunchctl()", () => {
  it("reads state and pid from a running job", () => {
    const output = "\tstate = running\n\tpid = 68796\n\tprogram = /Users/x/.local/bin/9router\n";

    expect(summarizeLaunchctl(output)).toEqual({ state: "running", pid: 68796 });
  });

  it("returns a null pid for a stopped job", () => {
    expect(summarizeLaunchctl("\tstate = exited\n\tlast exit code = 0\n")).toEqual({
      state: "exited",
      pid: null,
    });
  });

  it("returns nulls for empty output", () => {
    expect(summarizeLaunchctl("")).toEqual({ state: null, pid: null });
  });
});

describe("writeAtomic()", () => {
  it("keeps the executable bit, because launchd execs cli.js through a symlink", () => {
    const file = join(tempDir(), "cli.js");
    writeAtomic(file, "#!/usr/bin/env node\n", 0o755);

    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it("keeps the lane API key owner-only", () => {
    const file = join(tempDir(), "api-key");
    writeAtomic(file, "sk-test\n", 0o600);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces the target without leaving the temp file behind", () => {
    const file = join(tempDir(), "lane.plist");
    writeAtomic(file, "<plist/>", 0o644);

    expect(readFileSync(file, "utf8")).toBe("<plist/>");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("fixture guard", () => {
  it("pins the vendor anchor the patch depends on", () => {
    expect(PATCH_ANCHOR).toBe("      // Kill all found processes\n");
  });
});
