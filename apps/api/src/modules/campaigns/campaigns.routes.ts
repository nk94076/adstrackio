import type { FastifyInstance } from "fastify";
import { createCampaignSchema, updateCampaignSchema } from "@adstrackio/validation";
import {
  activateCampaign,
  archiveCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  updateCampaign,
} from "./campaigns.service.js";

export async function registerCampaignRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/campaigns",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const campaigns = await listCampaigns(fastify.prisma, organizationId);
      return { campaigns };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createCampaignSchema.parse(request.body);
      const campaign = await createCampaign(
        fastify.prisma,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      return { campaign };
    },
  );

  fastify.get(
    "/organizations/:organizationId/campaigns/:campaignId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const campaign = await getCampaign(fastify.prisma, organizationId, campaignId);
      return { campaign };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/campaigns/:campaignId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const input = updateCampaignSchema.parse(request.body);
      const campaign = await updateCampaign(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
        input,
      );
      return { campaign };
    },
  );

  // Explicit lifecycle operations, gated at ADMIN — the same minimum role
  // Phase 2's domain activate/deactivate uses — rather than MEMBER (which
  // create/update use): starting, stopping, or permanently retiring a
  // campaign's live traffic is a bigger blast radius than editing its
  // configuration. Each accepts no request body: the target status is
  // implied by the endpoint, never read from the payload, so there is
  // nothing here for a client to forge (see InvalidCampaignStatusTransitionError
  // for what happens when the current status doesn't allow it).
  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/activate",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const campaign = await activateCampaign(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
      );
      return { campaign };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/pause",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const campaign = await pauseCampaign(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
      );
      return { campaign };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/archive",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const campaign = await archiveCampaign(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
      );
      return { campaign };
    },
  );
}
