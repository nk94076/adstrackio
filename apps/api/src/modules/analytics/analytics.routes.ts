import type { FastifyInstance } from "fastify";
import { analyticsFilterSchema, timeseriesFilterSchema } from "@adstrackio/validation";
import {
  getAffiliatePartnerPerformance,
  getClickSummary,
  getClickTimeseries,
  getClicksByBrowser,
  getClicksByCampaign,
  getClicksByCountry,
  getClicksByDevice,
  getClicksByDomain,
  getClicksByLink,
  getClicksByOs,
  getClicksByReferrer,
  getConversionSummary,
  type AnalyticsFilters,
} from "./analytics.service.js";

/**
 * All analytics endpoints are read-only and organization-scoped, gated by
 * VIEWER — the existing minimum role for read access elsewhere (domains,
 * campaigns, etc.). Phase 11 additionally accepts a public API key
 * carrying READ or REPORTS scope via `authenticateEither`/
 * `requireOrgAccess` (apps/api/src/plugins/api-key-auth.ts); a dashboard
 * session's behavior is completely unchanged.
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
  };
}

function rangeOf(input: { from: Date; to: Date; timezone: string }) {
  return { from: input.from.toISOString(), to: input.to.toISOString(), timezone: input.timezone };
}

export async function registerAnalyticsRoutes(fastify: FastifyInstance) {
  const preHandler = [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ", "REPORTS"])];

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/summary",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const summary = await getClickSummary(fastify.prisma, toFilters(organizationId, input));
      return { summary, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/timeseries",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = timeseriesFilterSchema.parse(request.query);
      const points = await getClickTimeseries(
        fastify.prisma,
        toFilters(organizationId, input),
        input.bucket,
        input.timezone,
      );
      return { points, bucket: input.bucket, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-campaign",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByCampaign(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-link",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByLink(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-domain",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByDomain(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-referrer",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByReferrer(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-device",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByDevice(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-browser",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByBrowser(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-os",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByOs(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/clicks/by-country",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getClicksByCountry(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );

  fastify.get(
    "/organizations/:organizationId/analytics/conversions/summary",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const summary = await getConversionSummary(fastify.prisma, toFilters(organizationId, input));
      return { summary, range: rangeOf(input) };
    },
  );

  // Phase 9: Affiliate/Partner System — per-partner clicks/conversions/
  // conversion-rate. Every filter above (campaignId, trackingLinkId,
  // trackingDomainId, and even affiliatePartnerId itself) still applies, so
  // a caller can e.g. scope this to one campaign's partner performance.
  fastify.get(
    "/organizations/:organizationId/analytics/affiliate-partners/performance",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = analyticsFilterSchema.parse(request.query);
      const rows = await getAffiliatePartnerPerformance(fastify.prisma, toFilters(organizationId, input));
      return { rows, range: rangeOf(input) };
    },
  );
}
