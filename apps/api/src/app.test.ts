import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../test/helpers.js";

/**
 * Liveness/readiness endpoint wiring. See apps/tracker/src/app.test.ts for
 * the equivalent tracker-side coverage.
 */
describe("api service boundary", () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app?.close();
  });

  it("exposes a health check", async () => {
    app ??= await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });
  });

  it("exposes a readiness check that confirms database connectivity", async () => {
    app ??= await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", service: "api" });
  });
});
