import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTrackerApp } from "./app.js";

const testEnv = {
  NODE_ENV: "test" as const,
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(32),
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:4000",
  TRACKER_URL: "http://localhost:4100",
  API_PORT: 4000,
  TRACKER_PORT: 4100,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTrackerApp({ env: testEnv, logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("tracker service boundary", () => {
  it("exposes a health check", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "tracker" });
  });

  it("responds 501 for any tracking-style request instead of faking a redirect", async () => {
    const response = await app.inject({ method: "GET", url: "/abc123" });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("NOT_IMPLEMENTED");
  });
});
