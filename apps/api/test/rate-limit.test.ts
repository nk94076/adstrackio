import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

/**
 * The auth rate limit is relaxed for NODE_ENV=test (see
 * apps/api/src/modules/auth/auth.routes.ts) so the rest of the suite can
 * register many accounts without tripping it. That means the production
 * limit itself needs its own isolated check, against an app instance built
 * with a non-test env so the real 10-requests-per-minute limit applies.
 */
describe("auth rate limiting (production configuration)", () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app?.close();
  });

  it("returns 429 after 10 login attempts within a minute", async () => {
    app = await buildApp({
      env: {
        NODE_ENV: "production",
        DATABASE_URL: process.env.DATABASE_URL!,
        REDIS_URL: process.env.REDIS_URL!,
        AUTH_SECRET: process.env.AUTH_SECRET!,
        APP_URL: process.env.APP_URL!,
        API_URL: process.env.API_URL!,
        TRACKER_URL: process.env.TRACKER_URL!,
        API_PORT: 4000,
        TRACKER_PORT: 4100,
      },
      logger: false,
    });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "nobody@example.com", password: "wrong-password" },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual(Array(2).fill(429));
  });
});
