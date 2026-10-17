import { NextResponse } from "next/server";
import type { ApiResponse, HealthCheckData } from "@/types/common";

export async function GET() {
  const payload: ApiResponse<HealthCheckData> = {
    success: true,
    data: {
      status: "ok",
      version: "0.1.0",
      uptimeSeconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || "development",
    },
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
