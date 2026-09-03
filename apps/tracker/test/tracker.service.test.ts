import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@adstrackio/database";
import type { GeoLocationProvider, GeoLocationResult, UserAgentParser } from "@adstrackio/shared";
import { recordClick } from "../src/modules/tracker/tracker.service.js";
import { resetDatabase } from "./db-reset.js";
import { createTrackerFixture } from "./fixtures.js";

/**
 * Real-Postgres tests for the enrichment failure-isolation guarantee:
 * a throwing UserAgentParser or GeoLocationProvider must never prevent
 * the Click (and its BotEvent) from being written — see
 * docs/architecture/click-analytics.md.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const throwingUserAgentParser: UserAgentParser = {
  parse() {
    throw new Error("boom: UA parser exploded");
  },
};

const throwingGeoLocationProvider: GeoLocationProvider = {
  lookup() {
    throw new Error("boom: geo provider exploded");
  },
};

const rejectingGeoLocationProvider: GeoLocationProvider = {
  lookup() {
    return Promise.reject(new Error("boom: geo provider rejected"));
  },
};

const nullGeoLocationProvider: GeoLocationProvider = {
  lookup: () => Promise.resolve({ country: null, region: null, city: null, timezone: null }),
};

describe("recordClick: enrichment failure isolation", () => {
  it("still writes the Click and BotEvent when the UserAgentParser throws", async () => {
    const fixture = await createTrackerFixture();

    const click = await recordClick(
      prisma,
      {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        trackingLinkId: fixture.trackingLinkId,
        userAgent: "Mozilla/5.0 Chrome/119.0",
        ipHash: "deadbeef",
        ip: "203.0.113.1",
        affiliatePartnerId: null,
        classification: {
          classification: "HUMAN",
          score: 0.5,
          reasonCodes: [],
          detectionSource: "test",
        },
      },
      { userAgentParser: throwingUserAgentParser, geoLocationProvider: nullGeoLocationProvider },
    );

    expect(click.id).toBeTruthy();
    expect(click.deviceType).toBe("UNKNOWN");
    expect(click.browser).toBeNull();

    const botEvent = await prisma.botEvent.findFirst({ where: { clickId: click.id } });
    expect(botEvent).not.toBeNull();
  });

  it("still writes the Click when the GeoLocationProvider throws synchronously", async () => {
    const fixture = await createTrackerFixture();

    const click = await recordClick(
      prisma,
      {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        trackingLinkId: fixture.trackingLinkId,
        userAgent: "Mozilla/5.0 Chrome/119.0",
        ipHash: "deadbeef",
        ip: "203.0.113.1",
        affiliatePartnerId: null,
        classification: {
          classification: "HUMAN",
          score: 0.5,
          reasonCodes: [],
          detectionSource: "test",
        },
      },
      {
        userAgentParser: {
          parse: () => ({
            deviceType: "DESKTOP",
            browser: "Chrome",
            browserVersion: "119",
            os: "Windows",
            osVersion: "10",
          }),
        },
        geoLocationProvider: throwingGeoLocationProvider,
      },
    );

    expect(click.id).toBeTruthy();
    expect(click.country).toBeNull();
    expect(click.browser).toBe("Chrome");
  });

  it("still writes the Click when the GeoLocationProvider's promise rejects", async () => {
    const fixture = await createTrackerFixture();

    const click = await recordClick(
      prisma,
      {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        trackingLinkId: fixture.trackingLinkId,
        userAgent: "Mozilla/5.0 Chrome/119.0",
        ipHash: "deadbeef",
        ip: "203.0.113.1",
        affiliatePartnerId: null,
        classification: {
          classification: "HUMAN",
          score: 0.5,
          reasonCodes: [],
          detectionSource: "test",
        },
      },
      {
        userAgentParser: {
          parse: () => ({
            deviceType: "DESKTOP",
            browser: "Chrome",
            browserVersion: "119",
            os: "Windows",
            osVersion: "10",
          }),
        },
        geoLocationProvider: rejectingGeoLocationProvider,
      },
    );

    expect(click.id).toBeTruthy();
    expect(click.country).toBeNull();
  });

  it("BOT classification always wins over the parsed deviceType", async () => {
    const fixture = await createTrackerFixture();

    const click = await recordClick(
      prisma,
      {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        trackingLinkId: fixture.trackingLinkId,
        userAgent: "Mozilla/5.0 (iPhone) Chrome/119.0",
        ipHash: "deadbeef",
        ip: "203.0.113.1",
        affiliatePartnerId: null,
        classification: {
          classification: "BOT",
          score: 0.9,
          reasonCodes: ["test"],
          detectionSource: "test",
        },
      },
      {
        userAgentParser: {
          parse: () => ({
            deviceType: "MOBILE",
            browser: "Chrome",
            browserVersion: "119",
            os: "iOS",
            osVersion: "17",
          }),
        },
        geoLocationProvider: nullGeoLocationProvider,
      },
    );

    expect(click.deviceType).toBe("BOT");
    // Non-deviceType enrichment fields are still recorded even for a bot.
    expect(click.browser).toBe("Chrome");
  });
});

describe("recordClick: geo lookup does not block the redirect critical path", () => {
  it("resolves without waiting for a GeoLocationProvider that never resolves during the test", async () => {
    const fixture = await createTrackerFixture();

    // This promise is intentionally never resolved during the assertions
    // below. If recordClick awaited it (directly or indirectly), the call
    // below would hang until the test's own timeout — the strongest
    // possible proof that it doesn't, stronger than any wall-clock timing
    // assertion could be.
    let geoLookupStarted = false;
    const neverResolvingGeoLocationProvider: GeoLocationProvider = {
      lookup: () => {
        geoLookupStarted = true;
        return new Promise<GeoLocationResult>(() => {
          /* deliberately never settles */
        });
      },
    };

    const click = await recordClick(
      prisma,
      {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        trackingLinkId: fixture.trackingLinkId,
        userAgent: "Mozilla/5.0 Chrome/119.0",
        ipHash: "deadbeef",
        ip: "203.0.113.1",
        affiliatePartnerId: null,
        classification: {
          classification: "HUMAN",
          score: 0.5,
          reasonCodes: [],
          detectionSource: "test",
        },
      },
      {
        userAgentParser: {
          parse: () => ({
            deviceType: "DESKTOP",
            browser: "Chrome",
            browserVersion: "119",
            os: "Windows",
            osVersion: "10",
          }),
        },
        geoLocationProvider: neverResolvingGeoLocationProvider,
      },
    );

    expect(click.id).toBeTruthy();
    expect(click.browser).toBe("Chrome");
    expect(click.country).toBeNull();
    // The lookup was invoked (geo enrichment still runs, in the
    // background) but recordClick's own promise did not wait on it.
    expect(geoLookupStarted).toBe(true);
  });

  it("applies geo enrichment in the background once a slow provider eventually resolves", async () => {
    const fixture = await createTrackerFixture();
    let resolveGeo!: (value: GeoLocationResult) => void;
    const slowGeoLocationProvider: GeoLocationProvider = {
      lookup: () =>
        new Promise<GeoLocationResult>((resolve) => {
          resolveGeo = resolve;
        }),
    };

    const click = await recordClick(
      prisma,
      {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        trackingLinkId: fixture.trackingLinkId,
        userAgent: "Mozilla/5.0 Chrome/119.0",
        ipHash: "deadbeef",
        ip: "203.0.113.1",
        affiliatePartnerId: null,
        classification: {
          classification: "HUMAN",
          score: 0.5,
          reasonCodes: [],
          detectionSource: "test",
        },
      },
      {
        userAgentParser: { parse: () => ({ deviceType: "DESKTOP", browser: null, browserVersion: null, os: null, osVersion: null }) },
        geoLocationProvider: slowGeoLocationProvider,
      },
    );

    // recordClick already returned — geo fields are still unset.
    expect(click.country).toBeNull();

    // Now let the "slow" lookup complete, and wait for the background
    // update it triggers to land.
    resolveGeo({ country: "US", region: "CA", city: "San Francisco", timezone: "America/Los_Angeles" });

    await vi.waitFor(async () => {
      const updated = await prisma.click.findUniqueOrThrow({ where: { id: click.id } });
      expect(updated.country).toBe("US");
      expect(updated.city).toBe("San Francisco");
    });
  });
});
