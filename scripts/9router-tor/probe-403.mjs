#!/usr/bin/env node
// @ts-check
/**
 * Phase 0 probe (plan v2 §5 / task T1).
 *
 * Sends small chat-completion requests through the local 9router instance and
 * classifies every response, so the decision gate in §5.4 can be answered with
 * counts instead of guesses.
 *
 * Read-only: it never writes to 9router, its database, or the project.
 * It logs status, response class, latency and at most BODY_HEAD_LIMIT
 * characters of the response body. It never logs request prompts, request
 * headers, or credentials.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {"ok"|"client_contract"|"free_models_unavailable"|"cloudflare"|"abuse_ip"|"rate_limit"|"server_error"|"bad_request"|"unknown"} ResponseClass
 * @typedef {{ status: number, cls: ResponseClass, latencyMs: number, bodyHead: string, error: string|null, rateLimit: { limit: string|null, remaining: string|null, reset: string|null, retryAfter: string|null } }} ProbeResult
 * @typedef {{ url: string, key: string, model: string, samples: number, concurrency: number, timeoutMs: number }} ProbeOptions
 */

const BODY_HEAD_LIMIT = 300;
const DEFAULT_SAMPLES = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Checked before free_models so a body that mentions both stays client_contract. */
const CLIENT_CONTRACT_MARKERS = ["only be used from within opencode", "free tier"];
const FREE_MODELS_MARKERS = ["free models"];
const CLOUDFLARE_MARKERS = [
  "just a moment",
  "attention required",
  "cf-ray",
  "enable javascript and cookies",
];

/**
 * Classify one HTTP response from the OpenCode free tier.
 *
 * @param {number} status HTTP status code.
 * @param {string} body Response body text.
 * @returns {ResponseClass}
 */
export function classifyResponse(status, body) {
  const text = body.toLowerCase();
  if (status >= 200 && status < 300) return "ok";
  if (status === 403) {
    if (CLIENT_CONTRACT_MARKERS.some((marker) => text.includes(marker))) return "client_contract";
    if (FREE_MODELS_MARKERS.some((marker) => text.includes(marker))) return "free_models_unavailable";
    if (CLOUDFLARE_MARKERS.some((marker) => text.includes(marker))) return "cloudflare";
    return "abuse_ip";
  }
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/**
 * Resolve the 9router API key: environment first, then the local key store.
 *
 * @returns {Promise<string|null>}
 */
export async function resolveApiKey() {
  const fromEnv = process.env.NINEROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const dbPath = join(homedir(), ".9router", "db", "data.sqlite");
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("select key from apiKeys where isActive = 1 order by createdAt limit 1")
        .get();
      const value = row?.key;
      return typeof value === "string" && value.length > 0 ? value : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Candidate 9router base URLs, most specific first.
 *
 * The shell profile exports NINEROUTER_URL, but that port is not always the
 * one the running instance listens on, so the known local ports follow it.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function candidateUrls(env) {
  /** @type {string[]} */
  const candidates = [];
  /** @param {string|undefined} value */
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  push(env.NINEROUTER_URL?.trim());
  const omniRoute = env.OMNIROUTE_BASE_URL?.trim();
  if (omniRoute) push(`${omniRoute.replace(/\/+$/, "")}/v1`);
  push("http://127.0.0.1:20128/v1");
  push("http://127.0.0.1:20127/v1");
  return candidates;
}

/**
 * Return the first candidate that answers.
 *
 * @param {string[]} candidates
 * @param {(url: string) => Promise<boolean>} isReachable
 * @returns {Promise<string|null>}
 */
export async function resolveBaseUrl(candidates, isReachable) {
  for (const candidate of candidates) {
    try {
      if (await isReachable(candidate)) return candidate;
    } catch {
      // Keep probing the remaining candidates.
    }
  }
  return null;
}

/**
 * Read provider quota headers.
 *
 * OpenRouter free models expose a daily request budget; without these headers
 * a quota wall is indistinguishable from an upstream outage.
 *
 * @param {Headers} headers
 * @returns {{ limit: string|null, remaining: string|null, reset: string|null, retryAfter: string|null }}
 */
export function readRateLimit(headers) {
  return {
    limit: headers.get("x-ratelimit-limit-requests") ?? headers.get("x-ratelimit-limit") ?? null,
    remaining:
      headers.get("x-ratelimit-remaining-requests") ?? headers.get("x-ratelimit-remaining") ?? null,
    reset: headers.get("x-ratelimit-reset") ?? null,
    retryAfter: headers.get("retry-after") ?? null,
  };
}

/**
 * Build the request for a model.
 *
 * OpenCode ("oc/") models speak the Anthropic-style messages protocol and
 * reject OpenAI chat completions with ModelProtocolUnsupported; everything
 * else uses the OpenAI chat completions protocol.
 *
 * @param {string} model Model id.
 * @param {string} key API key.
 * @returns {{ path: string, headers: Record<string, string>, body: Record<string, unknown> }}
 */
export function buildRequest(model, key) {
  if (model.startsWith("oc/")) {
    return {
      path: "/messages",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: { model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] },
    };
  }
  return {
    path: "/chat/completions",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: { model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] },
  };
}

/**
 * Pick a model id: explicit option first, else an OpenCode ("oc/") free-tier
 * model, preferring the GLM 5.3 Flash one the local combo is locked to.
 *
 * @param {string} url 9router base URL ending in /v1.
 * @param {string} key API key.
 * @returns {Promise<string|null>}
 */
export async function resolveModel(url, key) {
  const explicit = process.env.PROBE_MODEL?.trim();
  if (explicit) return explicit;
  try {
    const response = await fetch(`${url}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    /** @type {{ data?: Array<{ id?: unknown }> }} */
    const payload = await response.json();
    const ids = Array.isArray(payload?.data)
      ? payload.data.map((entry) => String(entry?.id ?? ""))
      : [];
    const openCodeIds = ids.filter((id) => id.startsWith("oc/"));
    return (
      openCodeIds.find((id) => id.includes("glm-5.3-flash-free")) ??
      openCodeIds[0] ??
      ids[0] ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * Run the probe: `samples` requests, at most `concurrency` in flight.
 *
 * @param {ProbeOptions} options
 * @returns {Promise<ProbeResult[]>}
 */
export async function runProbe(options) {
  /** @type {ProbeResult[]} */
  const results = [];
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= options.samples) return;
      const startedAt = Date.now();
      try {
        const request = buildRequest(options.model, options.key);
        const response = await fetch(`${options.url}${request.path}`, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        const body = await response.text();
        results.push({
          status: response.status,
          cls: classifyResponse(response.status, body),
          latencyMs: Date.now() - startedAt,
          bodyHead: body.slice(0, BODY_HEAD_LIMIT),
          error: null,
          rateLimit: readRateLimit(response.headers),
        });
      } catch (error) {
        results.push({
          status: 0,
          cls: "unknown",
          latencyMs: Date.now() - startedAt,
          bodyHead: "",
          error: error instanceof Error ? error.message : String(error),
          rateLimit: { limit: null, remaining: null, reset: null, retryAfter: null },
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.samples) }, () => worker())
  );
  return results;
}

/**
 * Count results per response class.
 *
 * @param {ProbeResult[]} results
 * @returns {Record<string, number>}
 */
export function summarize(results) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const result of results) {
    counts[result.cls] = (counts[result.cls] ?? 0) + 1;
  }
  return counts;
}

/**
 * Nearest-rank percentile of a list of numbers.
 *
 * @param {number[]} values
 * @param {number} percentile Percentile in the 0..100 range.
 * @returns {number}
 */
export function percentile(values, percentile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

/**
 * @param {string[]} argv
 * @returns {{ samples: number, concurrency: number, url: string|null, model: string|null, out: string|null }}
 */
export function parseArgs(argv) {
  /** @type {{ samples: number, concurrency: number, url: string|null, model: string|null, out: string|null }} */
  const options = {
    samples: DEFAULT_SAMPLES,
    concurrency: DEFAULT_CONCURRENCY,
    url: null,
    model: process.env.PROBE_MODEL?.trim() || null,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--samples" && value) {
      options.samples = Number.parseInt(value, 10) || DEFAULT_SAMPLES;
      index += 1;
    } else if (arg === "--concurrency" && value) {
      options.concurrency = Number.parseInt(value, 10) || DEFAULT_CONCURRENCY;
      index += 1;
    } else if (arg === "--url" && value) {
      options.url = value;
      index += 1;
    } else if (arg === "--model" && value) {
      options.model = value;
      index += 1;
    } else if (arg === "--out" && value) {
      options.out = value;
      index += 1;
    }
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const key = await resolveApiKey();
  if (!key) {
    console.error(
      "No 9router API key found. Export NINEROUTER_API_KEY or start 9router so ~/.9router/db/data.sqlite has an active key."
    );
    process.exit(1);
  }

  const url =
    args.url ??
    (await resolveBaseUrl(candidateUrls(process.env), async (candidate) => {
      try {
        const response = await fetch(`${candidate}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    }));
  if (!url) {
    console.error(
      `No reachable 9router found. Tried: ${candidateUrls(process.env).join(", ")}. Pass --url.`
    );
    process.exit(1);
  }

  const model = args.model ?? (await resolveModel(url, key));
  if (!model) {
    console.error("No model resolved. Pass --model or set PROBE_MODEL.");
    process.exit(1);
  }

  console.log(`probe url=${url} model=${model} samples=${args.samples} concurrency=${args.concurrency}`);
  const results = await runProbe({
    url,
    key,
    model,
    samples: args.samples,
    concurrency: args.concurrency,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  results.forEach((result, index) => {
    const detail = result.error ?? result.bodyHead.replace(/\s+/g, " ");
    console.log(
      `[${String(index + 1).padStart(2, "0")}] status=${result.status} class=${result.cls} ${result.latencyMs}ms ${detail}`
    );
  });

  const counts = summarize(results);
  console.log("\n--- class counts ---");
  for (const [cls, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`${cls}: ${count}`);
  }

  const latencies = results.map((result) => result.latencyMs);
  const stats = {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    max: latencies.length ? Math.max(...latencies) : 0,
  };
  console.log(
    `--- latency ms --- p50=${stats.p50} p95=${stats.p95} max=${stats.max}`
  );

  const quota = results.map((result) => result.rateLimit).find((entry) => entry.limit || entry.remaining);
  if (quota) {
    console.log(
      `--- quota --- limit=${quota.limit} remaining=${quota.remaining} reset=${quota.reset} retryAfter=${quota.retryAfter}`
    );
  }

  if (args.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      args.out,
      `${JSON.stringify({ model, url: args.url, counts, results }, null, 2)}\n`,
      "utf8"
    );
    console.log(`\nreport written to ${args.out}`);
  }
}
