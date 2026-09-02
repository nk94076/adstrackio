import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYTICS_RANGE_DAYS,
  MAX_ANALYTICS_RANGE_DAYS,
  analyticsFilterSchema,
  timeseriesFilterSchema,
} from "./analytics.js";

describe("analyticsFilterSchema", () => {
  it("defaults to the last DEFAULT_ANALYTICS_RANGE_DAYS days in UTC when nothing is provided", () => {
    const result = analyticsFilterSchema.parse({});
    expect(result.timezone).toBe("UTC");
    const spanMs = result.to.getTime() - result.from.getTime();
    expect(spanMs).toBeCloseTo(DEFAULT_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000, -2);
  });

  it("accepts an explicit valid range", () => {
    const result = analyticsFilterSchema.parse({ from: "2026-01-01", to: "2026-01-08" });
    expect(result.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(result.to.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("accepts a valid IANA timezone", () => {
    const result = analyticsFilterSchema.parse({ timezone: "America/New_York" });
    expect(result.timezone).toBe("America/New_York");
  });

  it("rejects an invalid timezone", () => {
    expect(() => analyticsFilterSchema.parse({ timezone: "Mars/Olympus_Mons" })).toThrow();
  });

  it("rejects from after to", () => {
    expect(() => analyticsFilterSchema.parse({ from: "2026-02-01", to: "2026-01-01" })).toThrow();
  });

  it("rejects a range exceeding MAX_ANALYTICS_RANGE_DAYS", () => {
    expect(() =>
      analyticsFilterSchema.parse({
        from: "2020-01-01",
        to: new Date(
          new Date("2020-01-01").getTime() + (MAX_ANALYTICS_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    ).toThrow();
  });

  it("accepts a range exactly at MAX_ANALYTICS_RANGE_DAYS", () => {
    const from = new Date("2020-01-01");
    const to = new Date(from.getTime() + MAX_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000);
    expect(() =>
      analyticsFilterSchema.parse({ from: from.toISOString(), to: to.toISOString() }),
    ).not.toThrow();
  });

  it("rejects a malformed campaignId", () => {
    expect(() => analyticsFilterSchema.parse({ campaignId: "not-a-cuid" })).toThrow();
  });

  it("accepts optional scoping filters", () => {
    const result = analyticsFilterSchema.parse({
      campaignId: "cltestcampaign00000000000",
      trackingLinkId: "cltestlink000000000000000",
      trackingDomainId: "cltestdomain00000000000000",
    });
    expect(result.campaignId).toBe("cltestcampaign00000000000");
  });
});

describe("timeseriesFilterSchema", () => {
  it("defaults bucket to day", () => {
    const result = timeseriesFilterSchema.parse({});
    expect(result.bucket).toBe("day");
  });

  it("accepts hour/day/week", () => {
    expect(timeseriesFilterSchema.parse({ bucket: "hour" }).bucket).toBe("hour");
    expect(timeseriesFilterSchema.parse({ bucket: "week" }).bucket).toBe("week");
  });

  it("rejects an invalid bucket", () => {
    expect(() => timeseriesFilterSchema.parse({ bucket: "fortnight" })).toThrow();
  });
});
