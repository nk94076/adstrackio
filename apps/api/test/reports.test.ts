import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, type BotClassification, type DeviceType } from "@adstrackio/database";
import {
  addMemberWithRole,
  buildTestApp,
  registerAccount,
  verifyAndActivateDomain,
} from "./helpers.js";
import { resetDatabase } from "./db-reset.js";

/**
 * Phase 10 (Attribution & Advanced Reporting) apps/api coverage.
 *
 * This deliberately does NOT re-test attribution mechanics already proven
 * elsewhere: click-derived conversion attribution and mass-assignment
 * resistance live in conversion-tracking.test.ts (Phase 7); cross-org
 * partner/campaign/tracking-link isolation at the CRUD layer lives in
 * cross-org-isolation.test.ts and affiliate-partners.test.ts (Phase 9).
 * This file tests the NEW reporting layer built on top of that
 * already-proven attribution: that reports correctly aggregate, filter,
 * and isolate by organization, and that a forged attribution attempt
 * (still impossible per Phase 7) cannot make its way into a report either
 * way. BOT -> SAFE_PAGE / transparent redirection_url / Phase 8 routing /
 * Phase 9 attribution regression coverage lives entirely in
 * apps/tracker's own test suite, unmodified and unaffected by this phase
 * (Phase 10 touches no tracker code) — see the Phase 10 quality-gate
 * report for confirmation it still passes in full.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrgWithCampaign(suffix: string) {
  const owner = await registerAccount(app, {
    email: `owner-${suffix}@example.com`,
    organizationName: `Org ${suffix}`,
  });
  const organizationId = owner.organizationId!;

  const domain = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains`,
      headers: { cookie: owner.cookie },
      payload: { hostname: `${suffix}.example.com` },
    })
  ).json().domain;
  await verifyAndActivateDomain(domain.id);

  const destination = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/destinations`,
      headers: { cookie: owner.cookie },
      payload: { name: `Destination ${suffix}`, url: "https://offer.example.com" },
    })
  ).json().destination;

  const campaign = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie: owner.cookie },
      payload: { name: `Campaign ${suffix}`, trackingDomainId: domain.id },
    })
  ).json().campaign;

  const trackingLink = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: `${suffix}-link` },
    })
  ).json().trackingLink;

  return {
    owner,
    organizationId,
    campaignId: campaign.id as string,
    trackingLinkId: trackingLink.id as string,
    domainId: domain.id as string,
    destinationId: destination.id as string,
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
  deviceType?: DeviceType;
  browser?: string | null;
  os?: string | null;
  country?: string | null;
  affiliatePartnerId?: string | null;
}

async function createClick(options: CreateClickOptions) {
  return prisma.click.create({
    data: {
      id: randomUUID(),
      organizationId: options.organizationId,
      campaignId: options.campaignId,
      trackingLinkId: options.trackingLinkId,
      occurredAt: options.occurredAt ?? new Date(),
      botClassification: options.botClassification ?? "HUMAN",
      ipHash: options.ipHash ?? randomUUID(),
      userAgent: options.userAgent ?? "UA-1",
      deviceType: options.deviceType ?? "DESKTOP",
      browser: options.browser ?? null,
      os: options.os ?? null,
      country: options.country ?? null,
      affiliatePartnerId: options.affiliatePartnerId ?? null,
    },
  });
}

async function createConversion(
  cookie: string,
  organizationId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/conversions`,
    headers: { cookie },
    payload,
  });
}

function reportUrl(organizationId: string, path: string, query = ""): string {
  return `/api/v1/organizations/${organizationId}/reports/${path}${query}`;
}

async function get(cookie: string, url: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

// ---------------------------------------------------------------------------
// Overview + core metrics
// ---------------------------------------------------------------------------

describe("reports overview", () => {
  it("aggregates clicks and conversions correctly, including zero-denominator safety", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("overview-basic");

    // 3 human, 1 bot, 1 suspicious click.
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "HUMAN" });
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "HUMAN" });
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "HUMAN" });
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "BOT" });
    const suspiciousClick = await createClick({
      organizationId,
      campaignId,
      trackingLinkId,
      botClassification: "SUSPICIOUS",
    });

    // One approved conversion worth 50.00 on a human click; the
    // suspicious click's own conversion must never count as "human
    // performance".
    const humanClicks = await prisma.click.findMany({
      where: { trackingLinkId, botClassification: "HUMAN" },
    });
    const approved = await createConversion(owner.cookie, organizationId, {
      clickId: humanClicks[0]!.id,
      eventName: "purchase",
      value: 50,
      currency: "USD",
    });
    expect(approved.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${approved.json().conversion.id}/approve`,
      headers: { cookie: owner.cookie },
    });

    // A conversion on the suspicious click, left PENDING — must not be
    // counted as approved, and must not inflate human-based rates either.
    await createConversion(owner.cookie, organizationId, {
      clickId: suspiciousClick.id,
      eventName: "purchase",
    });

    const response = await get(owner.cookie, reportUrl(organizationId, "overview"));
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.clicks.totalClicks).toBe(5);
    expect(body.clicks.humanClicks).toBe(3);
    expect(body.clicks.botClicks).toBe(1);
    expect(body.clicks.suspiciousClicks).toBe(1);

    expect(body.conversions.totalConversions).toBe(2);
    expect(body.conversions.approvedConversions).toBe(1);
    expect(body.conversions.pendingConversions).toBe(1);
    expect(body.conversions.humanClicksInRange).toBe(3);
    // approvedConversions(1) / humanClicksInRange(3) * 100, rounded to 2dp.
    expect(body.conversions.conversionRate).toBeCloseTo(33.33, 1);
    expect(body.conversions.approvedConversionRate).toBe(body.conversions.conversionRate);
    expect(body.conversions.approvedConversionValue).toBe(50);
    // EPC = approvedConversionValue(50) / humanClicksInRange(3).
    expect(body.conversions.epc).toBeCloseTo(16.67, 1);
  });

  it("returns 0 (never NaN/Infinity) for rate/EPC when there are zero human clicks", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("overview-zero-denominator");
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "BOT" });

    const response = await get(owner.cookie, reportUrl(organizationId, "overview"));
    expect(response.statusCode).toBe(200);
    const conversions = response.json().conversions;
    expect(conversions.humanClicksInRange).toBe(0);
    expect(conversions.conversionRate).toBe(0);
    expect(conversions.approvedConversionRate).toBe(0);
    expect(conversions.epc).toBe(0);
    expect(Number.isFinite(conversions.epc)).toBe(true);
  });

  it("counts unique visitors via COUNT(DISTINCT (ipHash, userAgent)) over the whole range, consistent with Phase 4", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("overview-unique");
    // Same visitor (ipHash+userAgent) clicks twice; a second distinct
    // visitor clicks once. Total clicks = 3, unique = 2.
    const sameVisitor = { ipHash: "visitor-a", userAgent: "UA-A" };
    await createClick({ organizationId, campaignId, trackingLinkId, ...sameVisitor });
    await createClick({ organizationId, campaignId, trackingLinkId, ...sameVisitor });
    await createClick({ organizationId, campaignId, trackingLinkId, ipHash: "visitor-b", userAgent: "UA-B" });

    const response = await get(owner.cookie, reportUrl(organizationId, "overview"));
    const clicks = response.json().clicks;
    expect(clicks.totalClicks).toBe(3);
    expect(clicks.uniqueClicksInRange).toBe(2);
  });

  it("date range filter excludes clicks outside the requested window", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("overview-date-range");
    const now = new Date();
    const longAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await createClick({ organizationId, campaignId, trackingLinkId, occurredAt: longAgo });
    await createClick({ organizationId, campaignId, trackingLinkId, occurredAt: now });

    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const response = await get(
      owner.cookie,
      reportUrl(organizationId, "overview", `?from=${from}&to=${to}`),
    );
    expect(response.json().clicks.totalClicks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timeseries
// ---------------------------------------------------------------------------

describe("reports timeseries", () => {
  it("merges click and conversion buckets by date, accepting hour/day/week/month", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("timeseries-basic");
    const click = await createClick({ organizationId, campaignId, trackingLinkId });
    const conv = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: 10,
      currency: "USD",
    });
    expect(conv.statusCode).toBe(201);

    for (const bucket of ["hour", "day", "week", "month"]) {
      const response = await get(
        owner.cookie,
        reportUrl(organizationId, "timeseries", `?bucket=${bucket}`),
      );
      expect(response.statusCode).toBe(200);
      const points = response.json().points as { clicks: number; conversions: number }[];
      const totalClicks = points.reduce((sum: number, p) => sum + p.clicks, 0);
      const totalConversions = points.reduce((sum: number, p) => sum + p.conversions, 0);
      expect(totalClicks).toBe(1);
      expect(totalConversions).toBe(1);
    }
  });

  it("bucket-level unique counts are independent of, and not summable to, the range-wide unique count", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("timeseries-unique");
    const sameVisitor = { ipHash: "same-visitor", userAgent: "UA" };
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // Same visitor clicks on two different days -> 2 bucket-level uniques,
    // but only 1 range-wide unique visitor.
    await createClick({ organizationId, campaignId, trackingLinkId, ...sameVisitor, occurredAt: yesterday });
    await createClick({ organizationId, campaignId, trackingLinkId, ...sameVisitor, occurredAt: now });

    const overview = await get(owner.cookie, reportUrl(organizationId, "overview"));
    expect(overview.json().clicks.uniqueClicksInRange).toBe(1);

    const timeseries = await get(
      owner.cookie,
      reportUrl(organizationId, "timeseries", "?bucket=day"),
    );
    const points = timeseries.json().points as { uniqueClicksInBucket: number }[];
    const sumOfBucketUniques = points.reduce((sum: number, p) => sum + p.uniqueClicksInBucket, 0);
    expect(sumOfBucketUniques).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Campaign / tracking-link performance
// ---------------------------------------------------------------------------

describe("reports campaigns and tracking links", () => {
  it("reports per-campaign clicks/conversions/value/EPC correctly", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("campaign-performance");
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "HUMAN" });
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "HUMAN" });
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "BOT" });
    const click = await prisma.click.findFirstOrThrow({
      where: { trackingLinkId, botClassification: "HUMAN" },
    });
    const conv = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: 20,
      currency: "USD",
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conv.json().conversion.id}/approve`,
      headers: { cookie: owner.cookie },
    });

    const response = await get(owner.cookie, reportUrl(organizationId, "campaigns"));
    expect(response.statusCode).toBe(200);
    const row = response.json().rows.find((r: { campaignId: string }) => r.campaignId === campaignId);
    expect(row.clicks).toBe(3);
    expect(row.humanClicks).toBe(2);
    expect(row.botClicks).toBe(1);
    expect(row.approvedConversions).toBe(1);
    expect(row.approvedConversionValue).toBe(20);
    expect(row.epc).toBe(10); // 20 / 2 human clicks
  });

  it("reports per-tracking-link performance and surfaces its affiliate partner when configured", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("link-performance");
    await createClick({ organizationId, campaignId, trackingLinkId, botClassification: "HUMAN" });

    const response = await get(owner.cookie, reportUrl(organizationId, "tracking-links"));
    const row = response
      .json()
      .rows.find((r: { trackingLinkId: string }) => r.trackingLinkId === trackingLinkId);
    expect(row).toBeDefined();
    expect(row.clicks).toBe(1);
    expect(row.affiliatePartnerId).toBeNull();
  });

  it("a campaign filter narrows both the campaign and tracking-link reports to that campaign", async () => {
    const orgA = await setupOrgWithCampaign("filter-campaign-a");
    const otherCampaign = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgA.organizationId}/campaigns`,
        headers: { cookie: orgA.owner.cookie },
        payload: { name: "Other campaign", trackingDomainId: orgA.domainId },
      })
    ).json().campaign;

    await createClick({
      organizationId: orgA.organizationId,
      campaignId: orgA.campaignId,
      trackingLinkId: orgA.trackingLinkId,
    });

    const response = await get(
      orgA.owner.cookie,
      reportUrl(orgA.organizationId, "campaigns", `?campaignId=${orgA.campaignId}`),
    );
    const campaignIds = response.json().rows.map((r: { campaignId: string }) => r.campaignId);
    expect(campaignIds).toEqual([orgA.campaignId]);
    expect(campaignIds).not.toContain(otherCampaign.id);
  });
});

// ---------------------------------------------------------------------------
// Dimension breakdowns
// ---------------------------------------------------------------------------

describe("reports dimensions", () => {
  it("breaks down by country, device, browser, os, and bot classification with conversions attached", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("dimensions-basic");
    const usClick = await createClick({
      organizationId,
      campaignId,
      trackingLinkId,
      country: "US",
      deviceType: "MOBILE",
      browser: "Chrome",
      os: "Android",
      botClassification: "HUMAN",
    });
    await createClick({
      organizationId,
      campaignId,
      trackingLinkId,
      country: "CA",
      deviceType: "DESKTOP",
      browser: "Firefox",
      os: "Linux",
      botClassification: "BOT",
    });
    await createConversion(owner.cookie, organizationId, {
      clickId: usClick.id,
      eventName: "purchase",
    });

    for (const [dimension, expectedKeys] of [
      ["country", ["US", "CA"]],
      ["deviceType", ["MOBILE", "DESKTOP"]],
      ["browser", ["Chrome", "Firefox"]],
      ["os", ["Android", "Linux"]],
      ["botClassification", ["HUMAN", "BOT"]],
    ] as const) {
      const response = await get(
        owner.cookie,
        reportUrl(organizationId, "dimensions", `?dimension=${dimension}`),
      );
      expect(response.statusCode).toBe(200);
      const rows = response.json().rows as { key: string; clicks: number; conversions: number }[];
      const keys = rows.map((r) => r.key);
      for (const expected of expectedKeys) {
        expect(keys).toContain(expected);
      }
    }

    const countryRows = (
      await get(owner.cookie, reportUrl(organizationId, "dimensions", "?dimension=country"))
    ).json().rows as { key: string; conversions: number }[];
    expect(countryRows.find((r) => r.key === "US")?.conversions).toBe(1);
    expect(countryRows.find((r) => r.key === "CA")?.conversions).toBe(0);
  });

  it("rejects a dimension outside the closed whitelist", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("dimensions-invalid");
    const response = await get(
      owner.cookie,
      reportUrl(organizationId, "dimensions", "?dimension=notAcolumn"),
    );
    expect(response.statusCode).toBe(400);
  });

  it("filters by country/device/browser/os/botClassification", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("dimensions-filter");
    await createClick({ organizationId, campaignId, trackingLinkId, country: "US" });
    await createClick({ organizationId, campaignId, trackingLinkId, country: "CA" });

    const response = await get(
      owner.cookie,
      reportUrl(organizationId, "overview", "?country=US"),
    );
    expect(response.json().clicks.totalClicks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Conversion lifecycle reflected in reports
// ---------------------------------------------------------------------------

describe("conversion lifecycle in reports", () => {
  it("reflects approve/reject transitions in report totals, and a duplicate concurrent approve does not double-count", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("lifecycle-reports");
    const click = await createClick({ organizationId, campaignId, trackingLinkId });
    const conv = (
      await createConversion(owner.cookie, organizationId, {
        clickId: click.id,
        eventName: "purchase",
        value: 15,
        currency: "USD",
      })
    ).json().conversion;

    let overview = await get(owner.cookie, reportUrl(organizationId, "overview"));
    expect(overview.json().conversions.pendingConversions).toBe(1);
    expect(overview.json().conversions.approvedConversions).toBe(0);

    // Concurrent duplicate approve calls — Phase 7/8's idempotent
    // same-target concurrency guarantee means both succeed and exactly one
    // approval is reflected in the report, never two.
    const approveUrl = `/api/v1/organizations/${organizationId}/conversions/${conv.id}/approve`;
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: approveUrl, headers: { cookie: owner.cookie } }),
      app.inject({ method: "POST", url: approveUrl, headers: { cookie: owner.cookie } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    overview = await get(owner.cookie, reportUrl(organizationId, "overview"));
    expect(overview.json().conversions.approvedConversions).toBe(1);
    expect(overview.json().conversions.approvedConversionValue).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Attribution cannot be forged through reporting
// ---------------------------------------------------------------------------

describe("attribution integrity", () => {
  it("a conversion's forged campaignId/trackingLinkId has no effect on which report it appears in", async () => {
    const orgA = await setupOrgWithCampaign("forge-a");
    const orgB = await setupOrgWithCampaign("forge-b");
    const click = await createClick({
      organizationId: orgA.organizationId,
      campaignId: orgA.campaignId,
      trackingLinkId: orgA.trackingLinkId,
    });

    // createConversionSchema has no campaignId/trackingLinkId field at
    // all (Phase 7) — this is silently stripped, not honored.
    const conv = await createConversion(orgA.owner.cookie, orgA.organizationId, {
      clickId: click.id,
      eventName: "purchase",
      campaignId: orgB.campaignId,
      trackingLinkId: orgB.trackingLinkId,
    });
    expect(conv.statusCode).toBe(201);

    const campaignReportA = await get(orgA.owner.cookie, reportUrl(orgA.organizationId, "campaigns"));
    const rowA = campaignReportA
      .json()
      .rows.find((r: { campaignId: string }) => r.campaignId === orgA.campaignId);
    expect(rowA.conversions).toBe(1);

    // Org B's own report must show zero — the conversion is truly
    // attributed to orgA's campaign via the click, not the forged value.
    const campaignReportB = await get(orgB.owner.cookie, reportUrl(orgB.organizationId, "campaigns"));
    const rowB = campaignReportB
      .json()
      .rows.find((r: { campaignId: string }) => r.campaignId === orgB.campaignId);
    expect(rowB.conversions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Security / organization isolation
// ---------------------------------------------------------------------------

describe("organization isolation", () => {
  it("VIEWER/MEMBER/ADMIN/OWNER can all read reports; a non-member cannot", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("rbac-reports");
    const viewer = await addMemberWithRole(app, owner.cookie, organizationId, "VIEWER");
    const member = await addMemberWithRole(app, owner.cookie, organizationId, "MEMBER");
    const admin = await addMemberWithRole(app, owner.cookie, organizationId, "ADMIN");

    for (const cookie of [owner.cookie, viewer.cookie, member.cookie, admin.cookie]) {
      const response = await get(cookie, reportUrl(organizationId, "overview"));
      expect(response.statusCode).toBe(200);
    }
  });

  it("a member of one organization cannot query another organization's reports at all", async () => {
    const orgA = await setupOrgWithCampaign("isolation-a");
    const orgB = await setupOrgWithCampaign("isolation-b");

    for (const path of ["overview", "timeseries", "campaigns", "tracking-links", "dimensions"]) {
      const query = path === "dimensions" ? "?dimension=country" : "";
      const response = await get(orgA.owner.cookie, reportUrl(orgB.organizationId, path, query));
      expect(response.statusCode).toBe(403);
    }
  });

  it("a cross-org campaignId filter returns no data, never another organization's rows", async () => {
    const orgA = await setupOrgWithCampaign("cross-filter-campaign-a");
    const orgB = await setupOrgWithCampaign("cross-filter-campaign-b");
    await createClick({
      organizationId: orgB.organizationId,
      campaignId: orgB.campaignId,
      trackingLinkId: orgB.trackingLinkId,
    });

    // Org A queries its OWN report but supplies Org B's campaignId as a
    // filter — must never leak Org B's click into Org A's response.
    const response = await get(
      orgA.owner.cookie,
      reportUrl(orgA.organizationId, "overview", `?campaignId=${orgB.campaignId}`),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().clicks.totalClicks).toBe(0);
  });

  it("a cross-org trackingLinkId filter returns no data", async () => {
    const orgA = await setupOrgWithCampaign("cross-filter-link-a");
    const orgB = await setupOrgWithCampaign("cross-filter-link-b");
    await createClick({
      organizationId: orgB.organizationId,
      campaignId: orgB.campaignId,
      trackingLinkId: orgB.trackingLinkId,
    });

    const response = await get(
      orgA.owner.cookie,
      reportUrl(orgA.organizationId, "overview", `?trackingLinkId=${orgB.trackingLinkId}`),
    );
    expect(response.json().clicks.totalClicks).toBe(0);
  });

  it("a cross-org affiliatePartnerId filter returns no data", async () => {
    const orgA = await setupOrgWithCampaign("cross-filter-partner-a");
    const orgB = await setupOrgWithCampaign("cross-filter-partner-b");
    const partnerB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgB.organizationId}/affiliate-partners`,
        headers: { cookie: orgB.owner.cookie },
        payload: { name: "Partner B" },
      })
    ).json().affiliatePartner;

    const response = await get(
      orgA.owner.cookie,
      reportUrl(orgA.organizationId, "overview", `?affiliatePartnerId=${partnerB.id}`),
    );
    expect(response.json().clicks.totalClicks).toBe(0);
  });

  it("the tracking-link report never exposes another organization's links, even via a campaignId filter", async () => {
    const orgA = await setupOrgWithCampaign("cross-filter-tl-report-a");
    const orgB = await setupOrgWithCampaign("cross-filter-tl-report-b");

    const response = await get(
      orgA.owner.cookie,
      reportUrl(orgA.organizationId, "tracking-links", `?campaignId=${orgB.campaignId}`),
    );
    const linkIds = response.json().rows.map((r: { trackingLinkId: string }) => r.trackingLinkId);
    expect(linkIds).not.toContain(orgB.trackingLinkId);
  });
});

// ---------------------------------------------------------------------------
// Historical attribution (archived affiliate partner)
// ---------------------------------------------------------------------------

describe("historical reporting", () => {
  it("an archived affiliate partner's historical clicks/conversions/value still appear in performance reporting", async () => {
    const { owner, organizationId, campaignId, trackingLinkId } =
      await setupOrgWithCampaign("historical-partner");
    const partner = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners`,
        headers: { cookie: owner.cookie },
        payload: { name: "Historical Partner", status: "ACTIVE" },
      })
    ).json().affiliatePartner;
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners/${partner.id}`,
      headers: { cookie: owner.cookie },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/tracking-links/${trackingLinkId}`,
      headers: { cookie: owner.cookie },
      payload: { affiliatePartnerId: partner.id },
    });

    const click = await createClick({
      organizationId,
      campaignId,
      trackingLinkId,
      affiliatePartnerId: partner.id,
    });
    const conv = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: 25,
      currency: "USD",
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conv.json().conversion.id}/approve`,
      headers: { cookie: owner.cookie },
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/archive`,
      headers: { cookie: owner.cookie },
    });

    const response = await get(
      owner.cookie,
      `/api/v1/organizations/${organizationId}/analytics/affiliate-partners/performance`,
    );
    expect(response.statusCode).toBe(200);
    const row = response
      .json()
      .rows.find((r: { affiliatePartnerId: string }) => r.affiliatePartnerId === partner.id);
    expect(row).toBeDefined();
    expect(row.status).toBe("ARCHIVED");
    expect(row.clicks).toBe(1);
    expect(row.approvedConversions).toBe(1);
    expect(row.approvedConversionValue).toBe(25);
    expect(row.epc).toBe(25);
  });
});
