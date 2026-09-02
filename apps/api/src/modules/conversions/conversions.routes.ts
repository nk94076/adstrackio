import type { FastifyInstance } from "fastify";
import { createConversionSchema, listConversionsQuerySchema } from "@adstrackio/validation";
import {
  approveConversion,
  createConversion,
  getConversion,
  listConversions,
  rejectConversion,
  reverseConversion,
} from "./conversions.service.js";

/**
 * Conversion ingestion (POST) is gated at MEMBER — the same minimum role
 * campaign/tracking-link creation uses — matching this codebase's existing
 * event-ingestion model (a human dashboard user reporting a conversion
 * today; the service functions this route calls are the same boundary
 * Phase 11's API/integrations layer would reuse for machine callers).
 * Status decisions (approve/reject/reverse) are gated at ADMIN, one tier
 * above ingestion — same reasoning Phase 6 applied to campaign/
 * tracking-link lifecycle actions: approving revenue-bearing state is a
 * bigger blast radius than reporting an event happened.
 */
export async function registerConversionRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/conversions",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const query = listConversionsQuerySchema.parse(request.query);
      const conversions = await listConversions(fastify.prisma, organizationId, query);
      return { conversions };
    },
  );

  fastify.post(
    "/organizations/:organizationId/conversions",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createConversionSchema.parse(request.body);
      const conversion = await createConversion(
        fastify.prisma,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      return { conversion };
    },
  );

  fastify.get(
    "/organizations/:organizationId/conversions/:conversionId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, conversionId } = request.params as {
        organizationId: string;
        conversionId: string;
      };
      const conversion = await getConversion(fastify.prisma, organizationId, conversionId);
      return { conversion };
    },
  );

  for (const action of [
    { path: "approve", fn: approveConversion },
    { path: "reject", fn: rejectConversion },
    { path: "reverse", fn: reverseConversion },
  ] as const) {
    fastify.post(
      `/organizations/:organizationId/conversions/:conversionId/${action.path}`,
      { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
      async (request) => {
        const { organizationId, conversionId } = request.params as {
          organizationId: string;
          conversionId: string;
        };
        const conversion = await action.fn(
          fastify.prisma,
          request.user!.id,
          organizationId,
          conversionId,
        );
        return { conversion };
      },
    );
  }
}
