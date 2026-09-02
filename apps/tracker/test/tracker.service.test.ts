import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@adstrackio/database";
import type { GeoLocationProvider, UserAgentParser } from "@adstrackio/shared";
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
