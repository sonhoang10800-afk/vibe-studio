export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export type StatusState = "idle" | "loading" | "success" | "error";

export interface HealthCheckData {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  environment: string;
}
