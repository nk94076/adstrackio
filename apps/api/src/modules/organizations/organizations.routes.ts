import type { FastifyInstance } from "fastify";
import {
  createOrganizationSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
} from "@adstrackio/validation";
import { ApiError } from "@adstrackio/shared";
import {
  addMember,
  createOrganization,
  listOrganizationsForUser,
  removeMember,
  updateMemberRole,
} from "./organizations.service.js";

export async function registerOrganizationRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations",
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const organizations = await listOrganizationsForUser(fastify.prisma, request.user!.id);
      return { organizations };
    },
  );

  fastify.post(
    "/organizations",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const input = createOrganizationSchema.parse(request.body);
      const organization = await createOrganization(fastify.prisma, request.user!.id, input);
      reply.status(201);
      return { organization };
    },
  );

  fastify.get(
    "/organizations/:organizationId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const organization = await fastify.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      return { organization };
    },
  );

  fastify.get(
    "/organizations/:organizationId/members",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const members = await fastify.prisma.organizationMember.findMany({
        where: { organizationId },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      });
      return { members };
    },
  );

  fastify.post(
    "/organizations/:organizationId/members",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = inviteMemberSchema.parse(request.body);
      const membership = await addMember(fastify.prisma, request.user!.id, organizationId, input);
      reply.status(201);
      return { membership };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/members/:memberId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, memberId } = request.params as {
        organizationId: string;
        memberId: string;
      };
      const input = updateMemberRoleSchema.parse(request.body);
      const membership = await updateMemberRole(
        fastify.prisma,
        request.user!.id,
        organizationId,
        memberId,
        input.role,
      );
      return { membership };
    },
  );

  fastify.delete(
    "/organizations/:organizationId/members/:memberId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request, reply) => {
      const { organizationId, memberId } = request.params as {
        organizationId: string;
        memberId: string;
      };
      await removeMember(fastify.prisma, request.user!.id, organizationId, memberId);
      reply.status(204);
    },
  );

  // Sets the caller's active organization context. Kept intentionally
  // simple for Phase 1: it verifies membership, then stores the choice
  // client-side (the dashboard sends X-Organization-Id on later requests).
  // A future phase may fold this back into the session cookie if a
  // server-remembered "last active org" becomes a real requirement.
  fastify.post(
    "/organizations/:organizationId/activate",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      if (!request.membership) {
        throw ApiError.forbidden();
      }
      return { activeOrganizationId: request.membership.organizationId };
    },
  );
}
