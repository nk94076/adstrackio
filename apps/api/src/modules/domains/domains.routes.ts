import type { FastifyInstance } from "fastify";
import { createTrackingDomainSchema } from "@adstrackio/validation";
import {
  activateTrackingDomain,
  createTrackingDomain,
  deactivateTrackingDomain,
  getTrackingDomain,
  listTrackingDomains,
  verificationInstructions,
  verifyTrackingDomain,
} from "./domains.service.js";

// The raw verificationToken is never returned as its own field — only
// wrapped in verificationInstructions.recordValue, which is the one place a
// client actually needs it (to publish the DNS TXT record). Keeping it out
// of the top-level response body avoids the field accidentally being
// echoed somewhere (e.g. a table `id: domain.id` style dump) that wasn't
// deliberately built for it.
function serialize(domain: Awaited<ReturnType<typeof getTrackingDomain>>) {
  const { verificationToken, ...rest } = domain;
  return {
    ...rest,
    verificationInstructions: verificationInstructions(domain.hostname, verificationToken),
  };
}

export async function registerDomainRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/domains",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const domains = await listTrackingDomains(fastify.prisma, organizationId);
      return { domains: domains.map(serialize) };
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
      return { domain: serialize(domain) };
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
      return { domain: serialize(domain) };
    },
  );

  fastify.post(
    "/organizations/:organizationId/domains/:domainId/verify",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request) => {
      const { organizationId, domainId } = request.params as {
        organizationId: string;
        domainId: string;
      };
      const domain = await verifyTrackingDomain(
        fastify.prisma,
        request.user!.id,
        organizationId,
        domainId,
      );
      return { domain: serialize(domain) };
    },
  );

  fastify.post(
    "/organizations/:organizationId/domains/:domainId/activate",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, domainId } = request.params as {
        organizationId: string;
        domainId: string;
      };
      const domain = await activateTrackingDomain(
        fastify.prisma,
        request.user!.id,
        organizationId,
        domainId,
      );
      return { domain: serialize(domain) };
    },
  );

  fastify.post(
    "/organizations/:organizationId/domains/:domainId/deactivate",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, domainId } = request.params as {
        organizationId: string;
        domainId: string;
      };
      const domain = await deactivateTrackingDomain(
        fastify.prisma,
        request.user!.id,
        organizationId,
        domainId,
      );
      return { domain: serialize(domain) };
    },
  );
}
