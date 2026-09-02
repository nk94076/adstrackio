import type { FastifyInstance } from "fastify";
import { createAffiliatePartnerSchema, updateAffiliatePartnerSchema } from "@adstrackio/validation";
import {
  activateAffiliatePartner,
  archiveAffiliatePartner,
  createAffiliatePartner,
  getAffiliatePartner,
  listAffiliatePartners,
  pauseAffiliatePartner,
  updateAffiliatePartner,
} from "./affiliate-partners.service.js";
import {
  assignAffiliatePartnerToCampaign,
  listAffiliatePartnersForCampaign,
  unassignAffiliatePartnerFromCampaign,
} from "./campaign-affiliate-partners.service.js";

/**
 * RBAC (Phase 9: Affiliate/Partner System) mirrors the rest of the
 * campaign-manager surface: VIEWER reads; MEMBER creates/updates/assigns/
 * unassigns; ADMIN is required for the explicit activate/pause/archive
 * lifecycle actions — the same "bigger blast radius needs a higher bar"
 * reasoning campaigns.routes.ts documents for its own
 * activate/pause/archive endpoints.
 */
export async function registerAffiliatePartnerRoutes(fastify: FastifyInstance) {
  // --- Partner CRUD (organization-scoped) ----------------------------------
  fastify.get(
    "/organizations/:organizationId/affiliate-partners",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const affiliatePartners = await listAffiliatePartners(fastify.prisma, organizationId);
      return { affiliatePartners };
    },
  );

  fastify.post(
    "/organizations/:organizationId/affiliate-partners",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createAffiliatePartnerSchema.parse(request.body);
      const affiliatePartner = await createAffiliatePartner(
        fastify.prisma,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      return { affiliatePartner };
    },
  );

  fastify.get(
    "/organizations/:organizationId/affiliate-partners/:partnerId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, partnerId } = request.params as {
        organizationId: string;
        partnerId: string;
      };
      const affiliatePartner = await getAffiliatePartner(fastify.prisma, organizationId, partnerId);
      return { affiliatePartner };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/affiliate-partners/:partnerId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request) => {
      const { organizationId, partnerId } = request.params as {
        organizationId: string;
        partnerId: string;
      };
      const input = updateAffiliatePartnerSchema.parse(request.body);
      const affiliatePartner = await updateAffiliatePartner(
        fastify.prisma,
        request.user!.id,
        organizationId,
        partnerId,
        input,
      );
      return { affiliatePartner };
    },
  );

  for (const action of [
    { path: "activate", fn: activateAffiliatePartner },
    { path: "pause", fn: pauseAffiliatePartner },
    { path: "archive", fn: archiveAffiliatePartner },
  ] as const) {
    fastify.post(
      `/organizations/:organizationId/affiliate-partners/:partnerId/${action.path}`,
      { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
      async (request) => {
        const { organizationId, partnerId } = request.params as {
          organizationId: string;
          partnerId: string;
        };
        const affiliatePartner = await action.fn(
          fastify.prisma,
          request.user!.id,
          organizationId,
          partnerId,
        );
        return { affiliatePartner };
      },
    );
  }

  // --- Campaign-scoped roster/assignment ------------------------------------
  fastify.get(
    "/organizations/:organizationId/campaigns/:campaignId/affiliate-partners",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const assignments = await listAffiliatePartnersForCampaign(
        fastify.prisma,
        organizationId,
        campaignId,
      );
      return { assignments };
    },
  );

  // No request body: the campaign and partner are both fully identified by
  // the URL path, and assignment carries no configuration of its own — the
  // same "nothing here for a client to forge" reasoning the lifecycle
  // action endpoints elsewhere in this codebase rely on.
  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/affiliate-partners/:partnerId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId, campaignId, partnerId } = request.params as {
        organizationId: string;
        campaignId: string;
        partnerId: string;
      };
      const assignment = await assignAffiliatePartnerToCampaign(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
        partnerId,
      );
      reply.status(201);
      return { assignment };
    },
  );

  fastify.delete(
    "/organizations/:organizationId/campaigns/:campaignId/affiliate-partners/:partnerId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId, campaignId, partnerId } = request.params as {
        organizationId: string;
        campaignId: string;
        partnerId: string;
      };
      await unassignAffiliatePartnerFromCampaign(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
        partnerId,
      );
      reply.status(204);
    },
  );
}
