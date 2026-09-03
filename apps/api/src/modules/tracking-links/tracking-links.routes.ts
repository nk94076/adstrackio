import type { FastifyInstance } from "fastify";
import {
  createTrackingLinkForCampaignSchema,
  createTrackingLinkSchema,
  listTrackingLinksQuerySchema,
  updateTrackingLinkSchema,
} from "@adstrackio/validation";
import { actorIdOf } from "../../plugins/api-key-auth.js";
import {
  activateTrackingLink,
  archiveTrackingLink,
  createTrackingLink,
  getTrackingLink,
  getTrackingLinkForCampaign,
  listTrackingLinks,
  listTrackingLinksForCampaign,
  pauseTrackingLink,
  updateTrackingLink,
} from "./tracking-links.service.js";

/** Dashboard sessions AND public-API keys (Phase 11) — see
 * campaigns.routes.ts's doc comment for the dual-auth convention this
 * mirrors exactly. */
export async function registerTrackingLinkRoutes(fastify: FastifyInstance) {
  // --- Flat, organization-scoped routes (Phase 1) -------------------------
  // Kept for the existing "all tracking links across the organization"
  // dashboard view; the nested routes below are the campaign-scoped
  // surface Phase 6 adds. Both resolve to the same underlying rows.
  fastify.get(
    "/organizations/:organizationId/tracking-links",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ"])] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const query = listTrackingLinksQuerySchema.parse(request.query);
      const trackingLinks = await listTrackingLinks(fastify.prisma, organizationId, query);
      return { trackingLinks };
    },
  );

  fastify.post(
    "/organizations/:organizationId/tracking-links",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("MEMBER", ["WRITE"])] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createTrackingLinkSchema.parse(request.body);
      const trackingLink = await createTrackingLink(fastify.prisma, actorIdOf(request), organizationId, input);
      reply.status(201);
      return { trackingLink };
    },
  );

  fastify.get(
    "/organizations/:organizationId/tracking-links/:trackingLinkId",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ"])] },
    async (request) => {
      const { organizationId, trackingLinkId } = request.params as {
        organizationId: string;
        trackingLinkId: string;
      };
      const trackingLink = await getTrackingLink(fastify.prisma, organizationId, trackingLinkId);
      return { trackingLink };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/tracking-links/:trackingLinkId",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("MEMBER", ["WRITE"])] },
    async (request) => {
      const { organizationId, trackingLinkId } = request.params as {
        organizationId: string;
        trackingLinkId: string;
      };
      const input = updateTrackingLinkSchema.parse(request.body);
      const trackingLink = await updateTrackingLink(
        fastify.prisma,
        actorIdOf(request),
        organizationId,
        trackingLinkId,
        input,
      );
      return { trackingLink };
    },
  );

  for (const action of [
    { path: "activate", fn: activateTrackingLink },
    { path: "pause", fn: pauseTrackingLink },
    { path: "archive", fn: archiveTrackingLink },
  ] as const) {
    fastify.post(
      `/organizations/:organizationId/tracking-links/:trackingLinkId/${action.path}`,
      { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("ADMIN", ["WRITE"])] },
      async (request) => {
        const { organizationId, trackingLinkId } = request.params as {
          organizationId: string;
          trackingLinkId: string;
        };
        const trackingLink = await action.fn(fastify.prisma, actorIdOf(request), organizationId, trackingLinkId);
        return { trackingLink };
      },
    );
  }

  // --- Nested, campaign-scoped routes (Phase 6) ---------------------------
  fastify.get(
    "/organizations/:organizationId/campaigns/:campaignId/tracking-links",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ"])] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const query = listTrackingLinksQuerySchema.parse(request.query);
      const trackingLinks = await listTrackingLinksForCampaign(
        fastify.prisma,
        organizationId,
        campaignId,
        query,
      );
      return { trackingLinks };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/tracking-links",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("MEMBER", ["WRITE"])] },
    async (request, reply) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const input = createTrackingLinkForCampaignSchema.parse(request.body);
      // campaignId comes from the URL path, never the body — there is no
      // client-supplied value here to cross-check or mistrust.
      const trackingLink = await createTrackingLink(fastify.prisma, actorIdOf(request), organizationId, {
        ...input,
        campaignId,
      });
      reply.status(201);
      return { trackingLink };
    },
  );

  fastify.get(
    "/organizations/:organizationId/campaigns/:campaignId/tracking-links/:trackingLinkId",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ"])] },
    async (request) => {
      const { organizationId, campaignId, trackingLinkId } = request.params as {
        organizationId: string;
        campaignId: string;
        trackingLinkId: string;
      };
      const trackingLink = await getTrackingLinkForCampaign(
        fastify.prisma,
        organizationId,
        campaignId,
        trackingLinkId,
      );
      return { trackingLink };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/campaigns/:campaignId/tracking-links/:trackingLinkId",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("MEMBER", ["WRITE"])] },
    async (request) => {
      const { organizationId, campaignId, trackingLinkId } = request.params as {
        organizationId: string;
        campaignId: string;
        trackingLinkId: string;
      };
      // Confirms the campaign/link relationship the URL asserts before
      // applying the update (404s otherwise) — updateTrackingLink itself
      // only re-checks organization ownership.
      await getTrackingLinkForCampaign(fastify.prisma, organizationId, campaignId, trackingLinkId);
      const input = updateTrackingLinkSchema.parse(request.body);
      const trackingLink = await updateTrackingLink(
        fastify.prisma,
        actorIdOf(request),
        organizationId,
        trackingLinkId,
        input,
      );
      return { trackingLink };
    },
  );

  for (const action of [
    { path: "activate", fn: activateTrackingLink },
    { path: "pause", fn: pauseTrackingLink },
    { path: "archive", fn: archiveTrackingLink },
  ] as const) {
    fastify.post(
      `/organizations/:organizationId/campaigns/:campaignId/tracking-links/:trackingLinkId/${action.path}`,
      { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("ADMIN", ["WRITE"])] },
      async (request) => {
        const { organizationId, campaignId, trackingLinkId } = request.params as {
          organizationId: string;
          campaignId: string;
          trackingLinkId: string;
        };
        await getTrackingLinkForCampaign(fastify.prisma, organizationId, campaignId, trackingLinkId);
        const trackingLink = await action.fn(fastify.prisma, actorIdOf(request), organizationId, trackingLinkId);
        return { trackingLink };
      },
    );
  }
}
