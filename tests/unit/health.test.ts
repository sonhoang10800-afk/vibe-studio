import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";
import type { ApiResponse, HealthCheckData } from "@/types/common";

describe("src/app/api/health/route", () => {
  it("should return HTTP 200 with ok health status", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const json = (await response.json()) as ApiResponse<HealthCheckData>;
    expect(json.success).toBe(true);
    expect(json.data?.status).toBe("ok");
    expect(json.data?.version).toBe("0.1.0");
    expect(typeof json.data?.uptimeSeconds).toBe("number");
    expect(new Date(json.timestamp).getTime()).not.toBeNaN();
  });

  it("should return no-store cache headers", async () => {
    const response = await GET();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
