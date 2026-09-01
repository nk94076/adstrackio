import type { FastifyInstance } from "fastify";
import { createTrackingDomainSchema, updateTrackingDomainSchema } from "@adstrackio/validation";
import {
  createTrackingDomain,
  getTrackingDomain,
  listTrackingDomains,
  updateTrackingDomain,
} from "./domains.service.js";

export async function registerDomainRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/domains",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const domains = await listTrackingDomains(fastify.prisma, organizationId);
      return { domains };
    },
  );

  fastify.post(
    "/organizations/:organizationId/domains",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createTrackingDomainSchema.parse(request.body);
      const domain = await createTrackingDomain(
        fastify.prisma,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      return { domain };
    },
  );

  fastify.get(
    "/organizations/:organizationId/domains/:domainId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, domainId } = request.params as {
        organizationId: string;
        domainId: string;
      };
      const domain = await getTrackingDomain(fastify.prisma, organizationId, domainId);
      return { domain };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/domains/:domainId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request) => {
      const { organizationId, domainId } = request.params as {
        organizationId: string;
        domainId: string;
      };
      const input = updateTrackingDomainSchema.parse(request.body);
      const domain = await updateTrackingDomain(
        fastify.prisma,
        request.user!.id,
        organizationId,
        domainId,
        input,
      );
      return { domain };
    },
  );
}
