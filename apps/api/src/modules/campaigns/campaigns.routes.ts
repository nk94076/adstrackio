import type { FastifyInstance } from "fastify";
import { createCampaignSchema, updateCampaignSchema } from "@adstrackio/validation";
import { createCampaign, getCampaign, listCampaigns, updateCampaign } from "./campaigns.service.js";

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
}
