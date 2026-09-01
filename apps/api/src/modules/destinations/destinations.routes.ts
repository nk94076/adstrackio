import type { FastifyInstance } from "fastify";
import { createDestinationSchema, updateDestinationSchema } from "@adstrackio/validation";
import {
  createDestination,
  getDestination,
  listDestinations,
  updateDestination,
} from "./destinations.service.js";

export async function registerDestinationRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/destinations",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const destinations = await listDestinations(fastify.prisma, organizationId);
      return { destinations };
    },
  );

  fastify.post(
    "/organizations/:organizationId/destinations",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createDestinationSchema.parse(request.body);
      const destination = await createDestination(
        fastify.prisma,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      return { destination };
    },
  );

  fastify.get(
    "/organizations/:organizationId/destinations/:destinationId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, destinationId } = request.params as {
        organizationId: string;
        destinationId: string;
      };
      const destination = await getDestination(fastify.prisma, organizationId, destinationId);
      return { destination };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/destinations/:destinationId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request) => {
      const { organizationId, destinationId } = request.params as {
        organizationId: string;
        destinationId: string;
      };
      const input = updateDestinationSchema.parse(request.body);
      const destination = await updateDestination(
        fastify.prisma,
        request.user!.id,
        organizationId,
        destinationId,
        input,
      );
      return { destination };
    },
  );
}
