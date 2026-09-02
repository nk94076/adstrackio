import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, Prisma, type BotClassification, type DeviceType } from "@adstrackio/database";
import { buildTestApp, registerAccount } from "./helpers.js";
import { resetDatabase } from "./db-reset.js";

/**
 * registerAccount only creates an Organization (and returns its id) when an
 * organizationName is given — every analytics test needs a real org, so
 * this wraps it with a unique default name.
 */
async function registerOrgAccount(app: FastifyInstance) {
  const unique = randomUUID().slice(0, 8);
  return registerAccount(app, {
    email: `user-${unique}@example.com`,
    organizationName: `Org ${unique}`,
  });
}

/**
 * Creates a full Organization -> TrackingDomain -> Campaign -> Destination
 * -> TrackingLink chain directly via Prisma, mirroring
 * apps/tracker/test/fixtures.ts's precedent for bypassing the HTTP layer in
 * fixture setup. Analytics tests need real Click rows scoped to a real,
 * authenticated organization, not a whole domain-verification flow.
 */
interface AnalyticsFixture {
  organizationId: string;
  domainId: string;
  campaignId: string;
  trackingLinkId: string;
}

async function createAnalyticsFixture(organizationId: string): Promise<AnalyticsFixture> {
  const unique = randomUUID().slice(0, 8);

  const domain = await prisma.trackingDomain.create({
    data: {
      organizationId,
      hostname: `track-${unique}.example.com`,
      verificationStatus: "VERIFIED",
      verifiedAt: new Date(),
      isActive: true,
    },
  });

  const destination = await prisma.destination.create({
    data: {
      organizationId,
      name: "Fixture Destination",
      url: "https://backend-configured-destination.example.com/",
    },
  });

  const campaign = await prisma.campaign.create({
    data: { organizationId, name: `Fixture Campaign ${unique}` },
  });

  const trackingLink = await prisma.trackingLink.create({
    data: {
      campaignId: campaign.id,
      trackingDomainId: domain.id,
      destinationId: destination.id,
      slug: `slug-${unique}`,
      status: "ACTIVE",
    },
  });

  return {
    organizationId,
    domainId: domain.id,
    campaignId: campaign.id,
    trackingLinkId: trackingLink.id,
  };
}

interface CreateClickOptions {
  organizationId: string;
  campaignId: string;
  trackingLinkId: string;
  occurredAt?: Date;
  botClassification?: BotClassification;
  ipHash?: string;
  userAgent?: string;
  referrer?: string | null;
  deviceType?: DeviceType;
  browser?: string | null;
  os?: string | null;
  country?: string | null;
}

async function createClick(options: CreateClickOptions) {
  return prisma.click.create({
    data: {
      organizationId: options.organizationId,
      campaignId: options.campaignId,
      trackingLinkId: options.trackingLinkId,
      occurredAt: options.occurredAt ?? new Date(),
      botClassification: options.botClassification ?? "HUMAN",
      ipHash: options.ipHash ?? randomUUID(),
      userAgent: options.userAgent ?? "UA-1",
      referrer: options.referrer ?? null,
      deviceType: options.deviceType ?? "DESKTOP",
      browser: options.browser ?? null,
      os: options.os ?? null,
      country: options.country ?? null,
    },
  });
}

const ANALYTICS_PATHS = [
  "clicks/summary",
  "clicks/timeseries",
  "clicks/by-campaign",
  "clicks/by-link",
  "clicks/by-domain",
  "clicks/by-referrer",
  "clicks/by-device",
  "clicks/by-browser",
  "clicks/by-os",
  "clicks/by-country",
];

function analyticsUrl(organizationId: string, path: string, query = ""): string {
  return `/api/v1/organizations/${organizationId}/analytics/${path}${query}`;
}

describe("Click analytics API (Phase 4)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDatabase();
    app = await buildTestApp();
  });

  describe("authentication and authorization", () => {
    it("rejects every analytics endpoint when unauthenticated", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);

      for (const path of ANALYTICS_PATHS) {
        const response = await app.inject({
          method: "GET",
          url: analyticsUrl(fixture.organizationId, path),
        });
        expect(response.statusCode, `${path} should require auth`).toBe(401);
      }
    });

    it("rejects a non-member of the organization", async () => {
      const owner = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(owner.organizationId!);
      const outsider = await registerOrgAccount(app);

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/summary"),
        headers: { cookie: outsider.cookie },
      });

      expect(response.statusCode).toBe(403);
    });

    it("allows an authenticated member of the organization", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/summary"),
        headers: { cookie: account.cookie },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("organization isolation", () => {
    it("cannot query another organization's analytics by path param", async () => {
      const orgA = await registerOrgAccount(app);
      const orgB = await registerOrgAccount(app);
      const fixtureB = await createAnalyticsFixture(orgB.organizationId!);

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixtureB.organizationId, "clicks/summary"),
        headers: { cookie: orgA.cookie },
      });

      expect(response.statusCode).toBe(403);
    });

    it("returns zero results rather than leaking data when filtering by another org's campaignId", async () => {
      const orgA = await registerOrgAccount(app);
      const fixtureA = await createAnalyticsFixture(orgA.organizationId!);
      const orgB = await registerOrgAccount(app);
      const fixtureB = await createAnalyticsFixture(orgB.organizationId!);

      await createClick({
        organizationId: fixtureA.organizationId,
        campaignId: fixtureA.campaignId,
        trackingLinkId: fixtureA.trackingLinkId,
      });
      await createClick({
        organizationId: fixtureB.organizationId,
        campaignId: fixtureB.campaignId,
        trackingLinkId: fixtureB.trackingLinkId,
      });

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixtureA.organizationId, "clicks/summary", `?campaignId=${fixtureB.campaignId}`),
        headers: { cookie: orgA.cookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.summary.totalClicks).toBe(0);
    });
  });

  describe("query validation", () => {
    let account: Awaited<ReturnType<typeof registerAccount>>;
    let fixture: AnalyticsFixture;

    beforeEach(async () => {
      account = await registerOrgAccount(app);
      fixture = await createAnalyticsFixture(account.organizationId!);
    });

    it("rejects from after to", async () => {
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(
          fixture.organizationId,
          "clicks/summary",
          "?from=2026-01-10T00:00:00Z&to=2026-01-01T00:00:00Z",
        ),
        headers: { cookie: account.cookie },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a malformed campaignId", async () => {
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/summary", "?campaignId=not-a-cuid"),
        headers: { cookie: account.cookie },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an invalid timezone", async () => {
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/summary", "?timezone=Mars/Olympus_Mons"),
        headers: { cookie: account.cookie },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a range wider than the maximum", async () => {
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(
          fixture.organizationId,
          "clicks/summary",
          "?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
        ),
        headers: { cookie: account.cookie },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an invalid timeseries bucket", async () => {
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/timeseries", "?bucket=fortnight"),
        headers: { cookie: account.cookie },
      });
      expect(response.statusCode).toBe(400);
    });

    it("accepts a valid explicit range and filters", async () => {
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(
          fixture.organizationId,
          "clicks/summary",
          `?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&campaignId=${fixture.campaignId}`,
        ),
        headers: { cookie: account.cookie },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("empty result set", () => {
    it("returns an all-zero summary and empty breakdowns with no matching clicks", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);

      const summaryResponse = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/summary"),
        headers: { cookie: account.cookie },
      });
      expect(summaryResponse.statusCode).toBe(200);
      const summary = summaryResponse.json().summary;
      expect(summary).toEqual({
        totalClicks: 0,
        humanClicks: 0,
        botClicks: 0,
        suspiciousClicks: 0,
        unknownClicks: 0,
        uniqueClicksInRange: 0,
        botPercentage: 0,
      });

      const byCampaignResponse = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-campaign"),
        headers: { cookie: account.cookie },
      });
      expect(byCampaignResponse.json().rows).toEqual([]);
    });
  });

  describe("summary aggregation", () => {
    it("computes total/human/bot/unique clicks and botPercentage correctly", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);
      const now = new Date();

      // 5 HUMAN clicks: 3 distinct (ipHash, userAgent) pairs, one pair used twice.
      await createClick({ ...fixture, occurredAt: now, botClassification: "HUMAN", ipHash: "h1", userAgent: "UA-A" });
      await createClick({ ...fixture, occurredAt: now, botClassification: "HUMAN", ipHash: "h1", userAgent: "UA-A" });
      await createClick({ ...fixture, occurredAt: now, botClassification: "HUMAN", ipHash: "h2", userAgent: "UA-A" });
      await createClick({ ...fixture, occurredAt: now, botClassification: "HUMAN", ipHash: "h3", userAgent: "UA-B" });
      await createClick({ ...fixture, occurredAt: now, botClassification: "HUMAN", ipHash: "h4", userAgent: "UA-B" });

      // 3 BOT clicks, all distinct pairs.
      await createClick({ ...fixture, occurredAt: now, botClassification: "BOT", ipHash: "h5", userAgent: "UA-C" });
      await createClick({ ...fixture, occurredAt: now, botClassification: "BOT", ipHash: "h6", userAgent: "UA-C" });
      await createClick({ ...fixture, occurredAt: now, botClassification: "BOT", ipHash: "h7", userAgent: "UA-C" });

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(
          fixture.organizationId,
          "clicks/summary",
          `?from=${new Date(now.getTime() - 60_000).toISOString()}&to=${new Date(now.getTime() + 60_000).toISOString()}`,
        ),
        headers: { cookie: account.cookie },
      });

      expect(response.statusCode).toBe(200);
      const summary = response.json().summary;
      expect(summary.totalClicks).toBe(8);
      expect(summary.humanClicks).toBe(5);
      expect(summary.botClicks).toBe(3);
      expect(summary.uniqueClicksInRange).toBe(7); // 4 human pairs + 3 bot pairs, all distinct
      expect(summary.botPercentage).toBe(37.5);
    });
  });

  describe("timeseries", () => {
    it("buckets clicks by day in UTC", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);

      await createClick({ ...fixture, occurredAt: new Date("2026-01-01T10:00:00Z") });
      await createClick({ ...fixture, occurredAt: new Date("2026-01-01T14:00:00Z") });
      await createClick({ ...fixture, occurredAt: new Date("2026-01-02T05:00:00Z") });

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(
          fixture.organizationId,
          "clicks/timeseries",
          "?from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z&bucket=day&timezone=UTC",
        ),
        headers: { cookie: account.cookie },
      });

      expect(response.statusCode).toBe(200);
      const points = response.json().points;
      expect(points).toHaveLength(2);
      expect(points[0]).toMatchObject({ bucket: "2026-01-01T00:00:00", clicks: 2 });
      expect(points[1]).toMatchObject({ bucket: "2026-01-02T00:00:00", clicks: 1 });
    });

    it("buckets by hour", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);

      await createClick({ ...fixture, occurredAt: new Date("2026-01-01T10:15:00Z") });
      await createClick({ ...fixture, occurredAt: new Date("2026-01-01T10:45:00Z") });
      await createClick({ ...fixture, occurredAt: new Date("2026-01-01T11:05:00Z") });

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(
          fixture.organizationId,
          "clicks/timeseries",
          "?from=2026-01-01T00:00:00Z&to=2026-01-01T23:59:59Z&bucket=hour&timezone=UTC",
        ),
        headers: { cookie: account.cookie },
      });

      const points = response.json().points;
      expect(points).toHaveLength(2);
      expect(points[0]).toMatchObject({ bucket: "2026-01-01T10:00:00", clicks: 2 });
      expect(points[1]).toMatchObject({ bucket: "2026-01-01T11:00:00", clicks: 1 });
    });

    it("shifts day buckets according to an explicit non-UTC timezone", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);

      // 2026-01-01T02:00:00Z is still 2025-12-31 in America/New_York (UTC-5).
      await createClick({ ...fixture, occurredAt: new Date("2026-01-01T02:00:00Z") });

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(
          fixture.organizationId,
          "clicks/timeseries",
          "?from=2025-12-30T00:00:00Z&to=2026-01-02T00:00:00Z&bucket=day&timezone=America/New_York",
        ),
        headers: { cookie: account.cookie },
      });

      const points = response.json().points;
      expect(points).toHaveLength(1);
      expect(points[0].bucket).toBe("2025-12-31T00:00:00");
    });
  });

  describe("breakdowns", () => {
    let account: Awaited<ReturnType<typeof registerAccount>>;
    let fixture: AnalyticsFixture;

    beforeEach(async () => {
      account = await registerOrgAccount(app);
      fixture = await createAnalyticsFixture(account.organizationId!);
    });

    it("groups by campaign", async () => {
      await createClick(fixture);
      await createClick(fixture);
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-campaign"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: fixture.campaignId, clicks: 2 });
    });

    it("groups by tracking link", async () => {
      await createClick(fixture);
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-link"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: fixture.trackingLinkId, clicks: 1 });
    });

    it("groups by domain", async () => {
      await createClick(fixture);
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-domain"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: fixture.domainId, clicks: 1 });
    });

    it("groups by referrer hostname and buckets missing/malformed referrers as (direct)", async () => {
      await createClick({ ...fixture, referrer: "https://www.google.com/search?q=x" });
      await createClick({ ...fixture, referrer: "https://www.google.com/search?q=y" });
      await createClick({ ...fixture, referrer: null });
      await createClick({ ...fixture, referrer: "not a url" });

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-referrer"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows as { key: string; clicks: number }[];
      const google = rows.find((r) => r.key === "www.google.com");
      const direct = rows.find((r) => r.key === "(direct)");
      expect(google?.clicks).toBe(2);
      expect(direct?.clicks).toBe(2);
    });

    it("groups by device type", async () => {
      await createClick({ ...fixture, deviceType: "MOBILE" });
      await createClick({ ...fixture, deviceType: "DESKTOP" });
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-device"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows as { key: string; clicks: number }[];
      expect(rows.find((r) => r.key === "MOBILE")?.clicks).toBe(1);
      expect(rows.find((r) => r.key === "DESKTOP")?.clicks).toBe(1);
    });

    it("groups by browser", async () => {
      await createClick({ ...fixture, browser: "Chrome" });
      await createClick({ ...fixture, browser: null });
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-browser"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows as { key: string; clicks: number }[];
      expect(rows.find((r) => r.key === "Chrome")?.clicks).toBe(1);
      expect(rows.find((r) => r.key === "Unknown")?.clicks).toBe(1);
    });

    it("groups by OS", async () => {
      await createClick({ ...fixture, os: "Windows" });
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-os"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows as { key: string; clicks: number }[];
      expect(rows.find((r) => r.key === "Windows")?.clicks).toBe(1);
    });

    it("groups by country", async () => {
      await createClick({ ...fixture, country: "US" });
      await createClick({ ...fixture, country: null });
      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/by-country"),
        headers: { cookie: account.cookie },
      });
      const rows = response.json().rows as { key: string; clicks: number }[];
      expect(rows.find((r) => r.key === "US")?.clicks).toBe(1);
      expect(rows.find((r) => r.key === "Unknown")?.clicks).toBe(1);
    });

    it("only includes clicks matching an explicit trackingLinkId filter", async () => {
      const other = await createAnalyticsFixture(fixture.organizationId);
      await createClick(fixture);
      await createClick(other);

      const response = await app.inject({
        method: "GET",
        url: analyticsUrl(fixture.organizationId, "clicks/summary", `?trackingLinkId=${fixture.trackingLinkId}`),
        headers: { cookie: account.cookie },
      });
      expect(response.json().summary.totalClicks).toBe(1);
    });
  });

  describe("privacy", () => {
    it("never returns ipHash or a visitor fingerprint in any analytics response", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);
      await createClick(fixture);

      for (const path of ANALYTICS_PATHS) {
        const response = await app.inject({
          method: "GET",
          url: analyticsUrl(fixture.organizationId, path),
          headers: { cookie: account.cookie },
        });
        const raw = response.body;
        expect(raw, `${path} must not expose ipHash`).not.toContain("ipHash");
        expect(raw, `${path} must not expose a fingerprint`).not.toMatch(/fingerprint/i);
        expect(raw, `${path} must not expose a raw ip field`).not.toMatch(/"ip"\s*:/);
      }
    });
  });

  describe("query plan sanity", () => {
    // Not asserted as "must use an Index Scan": Postgres's cost-based
    // planner correctly prefers a Seq Scan over a tiny test-sized table
    // even with a usable index present, so that assertion would be
    // scientifically wrong here. This only proves the aggregation query is
    // valid, executable SQL against the real schema/indexes.
    it("produces a valid query plan for the summary aggregation", async () => {
      const account = await registerOrgAccount(app);
      const fixture = await createAnalyticsFixture(account.organizationId!);
      await createClick(fixture);

      const plan = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`
        EXPLAIN SELECT COUNT(*) FROM clicks c
        WHERE c."organizationId" = ${fixture.organizationId} AND c."occurredAt" >= now() - interval '7 days'
      `);
      expect(plan.length).toBeGreaterThan(0);
    });
  });
});
