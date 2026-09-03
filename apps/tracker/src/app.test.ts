import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BotClassificationResult,
  TrackingResolutionResult,
  TrackingResolver,
} from "@adstrackio/shared";
import { DEFAULT_BOT_TRAFFIC_POLICY, TrackingResolutionError } from "@adstrackio/shared";
import { buildTrackerApp } from "./app.js";

/**
 * Fast, DB-free tests exercising app wiring and the transparent-redirect
 * contract with injected fakes. The full real-Postgres integration suite
 * (domain/link gating, bot routing, cross-org isolation, click logging)
 * lives in apps/tracker/test/tracker.routes.test.ts.
 */

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

class FakeResolver implements TrackingResolver {
  constructor(
    private readonly result: TrackingResolutionResult | (() => never),
  ) {}

  resolve(): Promise<TrackingResolutionResult> {
    if (typeof this.result === "function") {
      this.result();
    }
    return Promise.resolve(this.result as TrackingResolutionResult);
  }
}

function fakeHumanResolver(overrides: Partial<TrackingResolutionResult> = {}) {
  return new FakeResolver({
    trackingLinkId: "link_1",
    campaignId: "campaign_1",
    organizationId: "org_1",
    safePageUrl: null,
    botTrafficPolicy: DEFAULT_BOT_TRAFFIC_POLICY,
    routingRules: [],
    affiliatePartnerId: null,
    ...overrides,
  });
}

function fakeBotEngine(classification: BotClassificationResult["classification"]) {
  return {
    classify: () =>
      Promise.resolve({
        classification,
        score: 1,
        reasonCodes: [],
        detectionSource: "fake",
      }),
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("tracker service boundary", () => {
  it("exposes a health check", async () => {
    app = await buildTrackerApp({
      env: testEnv,
      logger: false,
      resolver: fakeHumanResolver(),
      botDetectionEngine: fakeBotEngine("HUMAN"),
    });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "tracker" });
  });

  it("rejects a request with no redirection_url", async () => {
    app = await buildTrackerApp({
      env: testEnv,
      logger: false,
      resolver: fakeHumanResolver(),
      botDetectionEngine: fakeBotEngine("HUMAN"),
    });
    const response = await app.inject({ method: "GET", url: "/abc123" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a dangerous-scheme redirection_url before ever resolving the link", async () => {
    let resolveCalled = false;
    app = await buildTrackerApp({
      env: testEnv,
      logger: false,
      resolver: {
        resolve: () => {
          resolveCalled = true;
          return Promise.resolve({
            trackingLinkId: "x",
            campaignId: "x",
            organizationId: "x",
            safePageUrl: null,
            botTrafficPolicy: DEFAULT_BOT_TRAFFIC_POLICY,
            routingRules: [],
            affiliatePartnerId: null,
          });
        },
      },
      botDetectionEngine: fakeBotEngine("HUMAN"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/abc123?redirection_url=javascript:alert(1)",
    });
    expect(response.statusCode).toBe(400);
    expect(resolveCalled).toBe(false);
  });

  it("maps an unknown tracking link to 404 without leaking the reason", async () => {
    app = await buildTrackerApp({
      env: testEnv,
      logger: false,
      resolver: new FakeResolver(() => {
        throw new TrackingResolutionError("link_not_found", "No tracking link");
      }),
      botDetectionEngine: fakeBotEngine("HUMAN"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/unknown?redirection_url=https://example.com/offer",
    });
    expect(response.statusCode).toBe(404);
  });

  it("maps an inactive tracking link to 410", async () => {
    app = await buildTrackerApp({
      env: testEnv,
      logger: false,
      resolver: new FakeResolver(() => {
        throw new TrackingResolutionError("link_inactive", "Tracking link is not active");
      }),
      botDetectionEngine: fakeBotEngine("HUMAN"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/paused-link?redirection_url=https://example.com/offer",
    });
    expect(response.statusCode).toBe(410);
  });
});
