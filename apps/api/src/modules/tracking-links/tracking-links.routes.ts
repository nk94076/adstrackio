import type { FastifyInstance } from "fastify";
import { createTrackingLinkSchema, updateTrackingLinkSchema } from "@adstrackio/validation";
import {
  createTrackingLink,
  getTrackingLink,
  listTrackingLinks,
  updateTrackingLink,
} from "./tracking-links.service.js";

export async function registerTrackingLinkRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/tracking-links",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const trackingLinks = await listTrackingLinks(fastify.prisma, organizationId);
      return { trackingLinks };
    },
  );

  fastify.post(
    "/organizations/:organizationId/tracking-links",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createTrackingLinkSchema.parse(request.body);
      const trackingLink = await createTrackingLink(
        fastify.prisma,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      return { trackingLink };
    },
  );

  fastify.get(
    "/organizations/:organizationId/tracking-links/:trackingLinkId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
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
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request) => {
      const { organizationId, trackingLinkId } = request.params as {
        organizationId: string;
        trackingLinkId: string;
      };
      const input = updateTrackingLinkSchema.parse(request.body);
      const trackingLink = await updateTrackingLink(
        fastify.prisma,
        request.user!.id,
        organizationId,
        trackingLinkId,
        input,
      );
      return { trackingLink };
    },
  );
}
