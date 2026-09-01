import "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient, OrganizationRole } from "@adstrackio/database";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

export interface OrganizationMembershipContext {
  id: string;
  organizationId: string;
  role: OrganizationRole;
}

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    authenticate: PreHandler;
    requireOrganizationMember: (minimumRole?: OrganizationRole) => PreHandler;
  }

  interface FastifyRequest {
    user: AuthenticatedUser | null;
    membership: OrganizationMembershipContext | null;
  }
}
