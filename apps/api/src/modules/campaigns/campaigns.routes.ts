import type { FastifyInstance } from "fastify";
import { createCampaignSchema, listCampaignsQuerySchema, updateCampaignSchema } from "@adstrackio/validation";
import { actorIdOf } from "../../plugins/api-key-auth.js";
import {
  activateCampaign,
  archiveCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  updateCampaign,
} from "./campaigns.service.js";

/**
 * Dashboard sessions AND public-API keys both reach these routes (Phase
 * 11: API + Integrations) via `authenticateEither`/`requireOrgAccess` —
 * see apps/api/src/plugins/api-key-auth.ts. Session behavior is
 * unchanged: `requireOrgAccess` falls through to the exact same
 * `requireOrganizationMember` check as before whenever there is no
 * Bearer token. READ scope covers GET; WRITE covers everything else,
 * matching docs/api/api-keys.md#scopes.
 */
export async function registerCampaignRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/campaigns",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ"])] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const query = listCampaignsQuerySchema.parse(request.query);
      const campaigns = await listCampaigns(fastify.prisma, organizationId, query);
      return { campaigns };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("MEMBER", ["WRITE"])] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createCampaignSchema.parse(request.body);
      const campaign = await createCampaign(fastify.prisma, actorIdOf(request), organizationId, input);
      reply.status(201);
      return { campaign };
    },
  );

  fastify.get(
    "/organizations/:organizationId/campaigns/:campaignId",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ"])] },
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
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("MEMBER", ["WRITE"])] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const input = updateCampaignSchema.parse(request.body);
      const campaign = await updateCampaign(
        fastify.prisma,
        actorIdOf(request),
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
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("ADMIN", ["WRITE"])] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const campaign = await activateCampaign(fastify.prisma, actorIdOf(request), organizationId, campaignId);
      return { campaign };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/pause",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("ADMIN", ["WRITE"])] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const campaign = await pauseCampaign(fastify.prisma, actorIdOf(request), organizationId, campaignId);
      return { campaign };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/archive",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("ADMIN", ["WRITE"])] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const campaign = await archiveCampaign(fastify.prisma, actorIdOf(request), organizationId, campaignId);
      return { campaign };
    },
  );
}
