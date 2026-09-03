import type { FastifyInstance } from "fastify";
import {
  analyticsFilterSchema,
  dimensionReportQuerySchema,
  timeseriesFilterSchema,
} from "@adstrackio/validation";
import {
  getCampaignPerformance,
  getClickSummary,
  getClickTimeseries,
  getConversionSummary,
  getConversionTimeseries,
  getDimensionBreakdown,
  getTrackingLinkPerformance,
  type AnalyticsFilters,
  type ConversionTimeseriesPoint,
} from "../analytics/analytics.service.js";

/**
 * Phase 10: Attribution & Advanced Reporting — see
 * docs/architecture/attribution-reporting.md for the full design.
 *
 * This module adds NO new attribution or aggregation primitives beyond
 * what apps/api/src/modules/analytics/analytics.service.ts already
 * exports (Phase 4/7/9 plus this phase's own additions there); every
 * handler below is a thin composition over those functions —
 * organization-scoped, VIEWER-gated reads, exactly like
 * analytics.routes.ts. There is deliberately no
 * `GET .../reports/affiliate-partners` route: the pre-existing
 * `GET .../analytics/affiliate-partners/performance` endpoint (Phase 9,
 * extended this phase with value/EPC fields) already serves that report
 * in full — adding a second URL for the identical query would be exactly
 * the "unnecessary duplicate endpoint" this phase was told to avoid. The
 * dashboard's Reports page calls that existing endpoint directly.
 */
function toFilters(
  organizationId: string,
  input: {
    from: Date;
    to: Date;
    campaignId?: string;
    trackingLinkId?: string;
    trackingDomainId?: string;
    affiliatePartnerId?: string;
    country?: string;
    deviceType?: string;
    browser?: string;
    os?: string;
    botClassification?: string;
  },
): AnalyticsFilters {
  return {
    organizationId,
    from: input.from,
    to: input.to,
    campaignId: input.campaignId,
    trackingLinkId: input.trackingLinkId,
    trackingDomainId: input.trackingDomainId,
    affiliatePartnerId: input.affiliatePartnerId,
    country: input.country,
    deviceType: input.deviceType,
    browser: input.browser,
    os: input.os,
    botClassification: input.botClassification,
  };
}

function rangeOf(input: { from: Date; to: Date; timezone: string }) {
  return { from: input.from.toISOString(), to: input.to.toISOString(), timezone: input.timezone };
}

/** Merges a click-timeseries row and a conversion-timeseries row sharing
 * the same bucket key into one combined row. Both queries independently
 * date_trunc their own table's occurredAt using the identical AT TIME
 * ZONE conversion (see getConversionTimeseries's doc comment), so the
 * bucket strings align whenever both tables have data in the same bucket;
 * a bucket with clicks but no conversions (or vice versa) still appears
 * exactly once, with the missing side zeroed. */
function mergeTimeseries(
  clickPoints: { bucket: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInBucket: number }[],
  conversionPoints: ConversionTimeseriesPoint[],
) {
  const conversionsByBucket = new Map(conversionPoints.map((p) => [p.bucket, p]));
  const buckets = new Set([...clickPoints.map((p) => p.bucket), ...conversionPoints.map((p) => p.bucket)]);
  const clicksByBucket = new Map(clickPoints.map((p) => [p.bucket, p]));

  return [...buckets].sort().map((bucket) => {
    const clicks = clicksByBucket.get(bucket);
    const conversions = conversionsByBucket.get(bucket);
    return {
      bucket,
      clicks: clicks?.clicks ?? 0,
      humanClicks: clicks?.humanClicks ?? 0,
      botClicks: clicks?.botClicks ?? 0,
      uniqueClicksInBucket: clicks?.uniqueClicksInBucket ?? 0,
      conversions: conversions?.conversions ?? 0,
      approvedConversions: conversions?.approvedConversions ?? 0,
      totalConversionValue: conversions?.totalConversionValue ?? 0,
      approvedConversionValue: conversions?.approvedConversionValue ?? 0,
    };
  });
}

export async function registerReportRoutes(fastify: FastifyInstance) {
  const preHandler = [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")];

  // Combines the existing click summary and conversion summary (each
  // independently org-scoped and filtered) into the one "at a glance"
  // response a reporting overview page needs — no new aggregation query,
  // just Promise.all over two functions that already exist.
  fastify.get(
    "/organizations/:organizationId/reports/overview",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const filters = toFilters(organizationId, input);
      const [clicks, conversions] = await Promise.all([
        getClickSummary(fastify.prisma, filters),
        getConversionSummary(fastify.prisma, filters),
      ]);
      return { clicks, conversions, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/reports/timeseries",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = timeseriesFilterSchema.parse(request.query);
      const filters = toFilters(organizationId, input);
      const [clickPoints, conversionPoints] = await Promise.all([
        getClickTimeseries(fastify.prisma, filters, input.bucket, input.timezone),
        getConversionTimeseries(fastify.prisma, filters, input.bucket, input.timezone),
      ]);
      return {
        points: mergeTimeseries(clickPoints, conversionPoints),
        bucket: input.bucket,
        range: rangeOf(input),
      };
    },
  );

  fastify.get(
    "/organizations/:organizationId/reports/campaigns",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getCampaignPerformance(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/reports/tracking-links",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getTrackingLinkPerformance(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/reports/dimensions",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = dimensionReportQuerySchema.parse(request.query);
      const rows = await getDimensionBreakdown(
        fastify.prisma,
        toFilters(organizationId, input),
        input.dimension,
      );
      return { rows, dimension: input.dimension, range: rangeOf(input) };
    },
  );
}
