import { describe, it, expect } from "vitest";
import {
  buildRequest,
  candidateUrls,
  classifyResponse,
  percentile,
  readRateLimit,
  resolveBaseUrl,
} from "../../scripts/9router-tor/probe-403.mjs";

/**
 * Classifier rules for the Phase 0 probe (plan v2 §5, unit cases U1-U5, U18).
 * Order matters: a client-contract body may also mention "free models", and a
 * Cloudflare HTML page must never be read as an IP ban.
 */
describe("classifyResponse()", () => {
  it("classifies 2xx as ok", () => {
    expect(classifyResponse(200, '{"choices":[]}')).toBe("ok");
    expect(classifyResponse(201, "")).toBe("ok");
    expect(classifyResponse(204, "")).toBe("ok");
  });

  it("classifies the OpenCode free-tier client contract as client_contract", () => {
    const body =
      '{"error":{"message":"FreeTierError: \\"OpenCode\'s free tier can only be used from within OpenCode\\"","type":"invalid_request_error"}}';
    expect(classifyResponse(403, body)).toBe("client_contract");
  });

  it("classifies a 403 mentioning free models as free_models_unavailable", () => {
    expect(
      classifyResponse(403, '{"error":{"message":"No free models available for this account"}}')
    ).toBe("free_models_unavailable");
  });

  it("prefers client_contract over free_models_unavailable when both appear", () => {
    const body =
      '{"error":{"message":"FreeTierError: free models can only be used from within OpenCode"}}';
    expect(classifyResponse(403, body)).toBe("client_contract");
  });

  it("classifies Cloudflare HTML as cloudflare", () => {
    expect(
      classifyResponse(403, "<html><head><title>Just a moment...</title></head><body>cf-ray</body></html>")
    ).toBe("cloudflare");
  });

  it("classifies an unrecognised 403 as abuse_ip", () => {
    expect(classifyResponse(403, '{"error":{"message":"Forbidden"}}')).toBe("abuse_ip");
  });

  it("classifies 429 as rate_limit", () => {
    expect(classifyResponse(429, '{"error":{"message":"slow down"}}')).toBe("rate_limit");
  });

  it("classifies 5xx as server_error", () => {
    expect(classifyResponse(500, "")).toBe("server_error");
    expect(classifyResponse(503, "")).toBe("server_error");
  });

  it("classifies other 4xx as bad_request", () => {
    expect(classifyResponse(400, '{"error":{"message":"bad model"}}')).toBe("bad_request");
    expect(classifyResponse(404, "")).toBe("bad_request");
  });

  it("classifies anything else as unknown", () => {
    expect(classifyResponse(302, "")).toBe("unknown");
    expect(classifyResponse(100, "")).toBe("unknown");
  });

  it("matches markers case-insensitively", () => {
    expect(classifyResponse(403, '{"message":"ONLY BE USED FROM WITHIN OPENCODE"}')).toBe(
      "client_contract"
    );
  });
});

describe("candidateUrls()", () => {
  it("prefers the environment URL, then the OmniRoute base, then the known ports", () => {
    expect(
      candidateUrls({
        NINEROUTER_URL: "http://localhost:20127/v1",
        OMNIROUTE_BASE_URL: "http://localhost:20128",
      })
    ).toEqual([
      "http://localhost:20127/v1",
      "http://localhost:20128/v1",
      "http://127.0.0.1:20128/v1",
      "http://127.0.0.1:20127/v1",
    ]);
  });

  it("falls back to the known local ports when the environment is empty", () => {
    expect(candidateUrls({})).toEqual([
      "http://127.0.0.1:20128/v1",
      "http://127.0.0.1:20127/v1",
    ]);
  });

  it("does not repeat a candidate", () => {
    const urls = candidateUrls({ NINEROUTER_URL: "http://127.0.0.1:20128/v1" });
    expect(urls).toEqual(["http://127.0.0.1:20128/v1", "http://127.0.0.1:20127/v1"]);
  });
});

describe("resolveBaseUrl()", () => {  it("returns the first candidate that answers", async () => {
    const probed: string[] = [];
    const url = await resolveBaseUrl(["http://a/v1", "http://b/v1"], async (candidate) => {
      probed.push(candidate);
      return candidate === "http://b/v1";
    });
    expect(url).toBe("http://b/v1");
    expect(probed).toEqual(["http://a/v1", "http://b/v1"]);
  });

  it("skips a candidate whose probe throws", async () => {
    const url = await resolveBaseUrl(["http://a/v1", "http://b/v1"], async (candidate) => {
      if (candidate === "http://a/v1") throw new Error("fetch failed");
      return true;
    });
    expect(url).toBe("http://b/v1");
  });

  it("returns null when no candidate answers", async () => {
    expect(await resolveBaseUrl(["http://a/v1"], async () => false)).toBeNull();
  });
});

describe("buildRequest()", () => {  it("uses the Anthropic-style messages endpoint for OpenCode models", () => {
    const request = buildRequest("oc/glm-5.3-flash-free", "secret");
    expect(request.path).toBe("/messages");
    expect(request.headers["x-api-key"]).toBe("secret");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.body.model).toBe("oc/glm-5.3-flash-free");
  });

  it("uses the OpenAI chat completions endpoint for other models", () => {
    const request = buildRequest("openrouter-minimax-m3.1-flash", "secret");
    expect(request.path).toBe("/chat/completions");
    expect(request.headers.authorization).toBe("Bearer secret");
    expect(request.body.model).toBe("openrouter-minimax-m3.1-flash");
  });

  it("never puts the key in the request body", () => {
    const request = buildRequest("oc/glm-5.3-flash-free", "secret");
    expect(JSON.stringify(request.body)).not.toContain("secret");
  });
});

describe("percentile()", () => {  it("returns the nearest-rank percentile", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
  });

  it("sorts before ranking", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
  });

  it("returns 0 for an empty list", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe("readRateLimit()", () => {
  it("reads the OpenRouter quota headers", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "37",
      "x-ratelimit-reset": "1730000000",
    });
    expect(readRateLimit(headers)).toEqual({
      limit: "50",
      remaining: "37",
      reset: "1730000000",
      retryAfter: null,
    });
  });

  it("falls back to the generic headers", () => {
    const headers = new Headers({ "x-ratelimit-limit": "10", "x-ratelimit-remaining": "0" });
    const quota = readRateLimit(headers);
    expect(quota.limit).toBe("10");
    expect(quota.remaining).toBe("0");
  });

  it("returns nulls when the provider sends no quota headers", () => {
    expect(readRateLimit(new Headers())).toEqual({
      limit: null,
      remaining: null,
      reset: null,
      retryAfter: null,
    });
  });
});
