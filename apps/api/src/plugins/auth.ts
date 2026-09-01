import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifySessionToken, SESSION_COOKIE_NAME, type OrganizationRole } from "@adstrackio/auth";
import { hasMinimumRole } from "@adstrackio/auth";
import { ApiError } from "@adstrackio/shared";
import type { Env } from "@adstrackio/config";

export const authPlugin = fp(async function authPlugin(fastify: FastifyInstance, opts: { env: Env }) {
  fastify.decorateRequest("user", null);
  fastify.decorateRequest("membership", null);

  fastify.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) {
      throw ApiError.unauthenticated();
    }

    let sessionPayload;
    try {
      sessionPayload = await verifySessionToken(token, opts.env.AUTH_SECRET);
    } catch {
      throw ApiError.unauthenticated("Session is invalid or has expired");
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: sessionPayload.userId },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      throw ApiError.unauthenticated("Session refers to a user that no longer exists");
    }

    request.user = user;
  });

  fastify.decorate("requireOrganizationMember", function requireOrganizationMember(
    minimumRole: OrganizationRole = "VIEWER",
  ) {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      if (!request.user) {
        throw ApiError.unauthenticated();
      }

      const { organizationId } = request.params as { organizationId?: string };
      if (!organizationId) {
        throw ApiError.validation("organizationId is required");
      }

      const membership = await fastify.prisma.organizationMember.findUnique({
        where: {
          userId_organizationId: { userId: request.user.id, organizationId },
        },
      });

      if (!membership) {
        throw ApiError.forbidden("You are not a member of this organization");
      }

      if (!hasMinimumRole(membership.role, minimumRole)) {
        throw ApiError.forbidden(`This action requires the ${minimumRole} role or higher`);
      }

      request.membership = {
        id: membership.id,
        organizationId: membership.organizationId,
        role: membership.role,
      };
    };
  });
});
