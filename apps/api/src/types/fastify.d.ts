import "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient, OrganizationRole, ApiKeyScope } from "@adstrackio/database";

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

/**
 * Populated by apps/api/src/plugins/api-key-auth.ts when a request
 * authenticates via `Authorization: Bearer atk_live_...` instead of a
 * session cookie (Phase 11: API + Integrations). `createdBy` is the
 * ApiKey's own creator — used as the audit-log actorUserId for
 * API-key-driven mutations (see requireOrgAccess's doc comment) so every
 * write still has a real User to attribute to, without threading a
 * nullable actor through every service function's signature.
 */
export interface ApiKeyContext {
  id: string;
  organizationId: string;
  scopes: ApiKeyScope[];
  createdBy: string;
}

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    authenticate: PreHandler;
    requireOrganizationMember: (minimumRole?: OrganizationRole) => PreHandler;
    /** Accepts EITHER a valid session cookie OR a valid Bearer API key —
     * see apps/api/src/plugins/api-key-auth.ts. */
    authenticateEither: PreHandler;
    /** Organization + role/scope check that works for both auth modes:
     * a session user needs `minimumRole`; an API key needs to belong to
     * the URL's own organization AND carry at least one of
     * `apiKeyScopes`. See apps/api/src/plugins/api-key-auth.ts. */
    requireOrgAccess: (minimumRole: OrganizationRole, apiKeyScopes: ApiKeyScope[]) => PreHandler;
  }

  interface FastifyRequest {
    user: AuthenticatedUser | null;
    membership: OrganizationMembershipContext | null;
    apiKeyContext: ApiKeyContext | null;
  }
}
