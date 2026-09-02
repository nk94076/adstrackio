import type { FastifyInstance } from "fastify";
import { createRoutingRuleSchema, updateRoutingRuleSchema } from "@adstrackio/validation";
import {
  activateRoutingRule,
  createRoutingRule,
  deactivateRoutingRule,
  deleteRoutingRule,
  getRoutingRule,
  listRoutingRulesForCampaign,
  updateRoutingRule,
} from "./routing-rules.service.js";

/**
 * Campaign-scoped-only surface (Phase 8: Rules & Routing Engine) — unlike
 * tracking-links, there is no flat /organizations/:organizationId/rules
 * listing: a routing rule only ever makes sense in the context of the one
 * campaign it targets, so every route is nested under
 * /campaigns/:campaignId/rules.
 *
 * RBAC mirrors the rest of the campaign-manager surface: VIEWER can read,
 * MEMBER can create/update/delete, ADMIN is required for the explicit
 * activate/deactivate lifecycle actions — the same "bigger blast radius
 * needs a higher bar" reasoning campaigns.routes.ts documents for its own
 * activate/pause/archive endpoints.
 */
export async function registerRoutingRuleRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/campaigns/:campaignId/rules",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const rules = await listRoutingRulesForCampaign(fastify.prisma, organizationId, campaignId);
      return { rules };
    },
  );

  fastify.post(
    "/organizations/:organizationId/campaigns/:campaignId/rules",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId, campaignId } = request.params as {
        organizationId: string;
        campaignId: string;
      };
      const input = createRoutingRuleSchema.parse(request.body);
      const rule = await createRoutingRule(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
        input,
      );
      reply.status(201);
      return { rule };
    },
  );

  fastify.get(
    "/organizations/:organizationId/campaigns/:campaignId/rules/:ruleId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, campaignId, ruleId } = request.params as {
        organizationId: string;
        campaignId: string;
        ruleId: string;
      };
      const rule = await getRoutingRule(fastify.prisma, organizationId, campaignId, ruleId);
      return { rule };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/campaigns/:campaignId/rules/:ruleId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request) => {
      const { organizationId, campaignId, ruleId } = request.params as {
        organizationId: string;
        campaignId: string;
        ruleId: string;
      };
      const input = updateRoutingRuleSchema.parse(request.body);
      const rule = await updateRoutingRule(
        fastify.prisma,
        request.user!.id,
        organizationId,
        campaignId,
        ruleId,
        input,
      );
      return { rule };
    },
  );

  fastify.delete(
    "/organizations/:organizationId/campaigns/:campaignId/rules/:ruleId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId, campaignId, ruleId } = request.params as {
        organizationId: string;
        campaignId: string;
        ruleId: string;
      };
      await deleteRoutingRule(fastify.prisma, request.user!.id, organizationId, campaignId, ruleId);
      reply.status(204);
    },
  );

  for (const action of [
    { path: "activate", fn: activateRoutingRule },
    { path: "deactivate", fn: deactivateRoutingRule },
  ] as const) {
    fastify.post(
      `/organizations/:organizationId/campaigns/:campaignId/rules/:ruleId/${action.path}`,
      { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
      async (request) => {
        const { organizationId, campaignId, ruleId } = request.params as {
          organizationId: string;
          campaignId: string;
          ruleId: string;
        };
        const rule = await action.fn(fastify.prisma, request.user!.id, organizationId, campaignId, ruleId);
        return { rule };
      },
    );
  }
}
