import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyScope, OrganizationRole } from "@adstrackio/database";
import { extractApiKeyLookupPrefix, verifyApiKeySecret } from "@adstrackio/auth";
import { ApiError } from "@adstrackio/shared";
import type { ApiKeyContext } from "../types/fastify.js";

/**
 * API-key authentication for the public /api/v1 surface (Phase 11: API +
 * Integrations) — see docs/api/authentication.md.
 *
 * This is deliberately ADDITIVE to the existing session-cookie
 * `fastify.authenticate` / `fastify.requireOrganizationMember` (Phase 1):
 * neither is modified. `authenticateEither` tries Bearer-token auth first
 * (when an Authorization header is present) and falls back to the
 * existing cookie flow otherwise, so a route wired to it keeps working
 * unchanged for dashboard sessions while additionally accepting a machine
 * caller's API key. `requireOrgAccess` is the scope-aware analogue of
 * `requireOrganizationMember` used alongside it.
 *
 * Only campaigns, tracking-links, conversions, and reporting/analytics
 * routes are wired to these — see docs/api/overview.md for why the rest
 * of the dashboard's session-only surface (organization membership
 * management, domains, referral proofs, audit logs, routing rules,
 * affiliate-partner administration) is deliberately NOT exposed to API
 * keys in this phase: the brief asks for campaigns/tracking-links/
 * conversions/reports specifically, and widening every existing route to
 * accept machine credentials would be a materially larger security
 * surface than what was actually requested.
 */
export const apiKeyAuthPlugin = fp(async function apiKeyAuthPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest("apiKeyContext", null);

  /**
   * A second rate-limit bucket, on top of the global per-IP one already
   * registered in plugins/security.ts, applying ONLY to API-key-
   * authenticated requests (see requireOrgAccess below) — reusing
   * @fastify/rate-limit's own `fastify.rateLimit()` factory (its
   * documented way to apply a distinct limit to a subset of routes)
   * rather than hand-rolling a second limiter or introducing a new
   * dependency. Keyed by the API key's own id, so one organization's key
   * can never exhaust another's quota, and a compromised/misbehaving key
   * can't drown out the dashboard's session traffic (which stays on the
   * global per-IP limiter only) — see docs/api/overview.md#rate-limiting.
   * Exceeding this throws an Error with `.statusCode = 429`, which
   * plugins/error-handler.ts already maps to the same
   * `{ error: { code: "RATE_LIMITED", ... } }` shape as every other
   * error in this API.
   */
  const apiKeyRateLimit = fastify.rateLimit({
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => `apikey:${request.apiKeyContext?.id ?? request.ip}`,
  });

  async function authenticateApiKeyToken(rawToken: string): Promise<ApiKeyContext> {
    const prefix = extractApiKeyLookupPrefix(rawToken);
    // Every failure path below throws the SAME message — a malformed
    // token, a prefix that matches no row, a hash mismatch, a revoked
    // key, and an expired key are all indistinguishable to the caller.
    // Never confirm whether a given key ever existed (docs/api/authentication.md).
    const invalid = () => ApiError.unauthenticated("Invalid or expired API key");

    if (!prefix) {
      throw invalid();
    }

    const candidate = await fastify.prisma.apiKey.findUnique({ where: { keyPrefix: prefix } });
    if (!candidate) {
      throw invalid();
    }
    if (!verifyApiKeySecret(rawToken, candidate.keyHash)) {
      throw invalid();
    }
    if (candidate.revokedAt) {
      throw invalid();
    }
    if (candidate.expiresAt && candidate.expiresAt.getTime() <= Date.now()) {
      throw invalid();
    }

    // Best-effort freshness tracking — never blocks or fails the request
    // if this write races with a concurrent request or a revoke.
    fastify.prisma.apiKey
      .update({ where: { id: candidate.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return {
      id: candidate.id,
      organizationId: candidate.organizationId,
      scopes: candidate.scopes,
      createdBy: candidate.createdBy,
    };
  }

  fastify.decorate(
    "authenticateEither",
    async function authenticateEither(request: FastifyRequest, reply: FastifyReply) {
      const header = request.headers.authorization;
      const match = header ? /^Bearer\s+(.+)$/.exec(header.trim()) : null;
      if (match) {
        request.apiKeyContext = await authenticateApiKeyToken(match[1]!.trim());
        return;
      }
      return fastify.authenticate(request, reply);
    },
  );

  fastify.decorate(
    "requireOrgAccess",
    function requireOrgAccess(minimumRole: OrganizationRole, apiKeyScopes: ApiKeyScope[]) {
      const sessionPreHandler = fastify.requireOrganizationMember(minimumRole);
      return async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.apiKeyContext) {
          await apiKeyRateLimit.call(fastify, request, reply);

          const { organizationId } = request.params as { organizationId?: string };
          if (!organizationId) {
            throw ApiError.validation("organizationId is required");
          }
          // Never trust organizationId from anywhere but the
          // authenticated key itself — the URL param is only compared
          // against it, never substituted for it.
          if (request.apiKeyContext.organizationId !== organizationId) {
            throw ApiError.forbidden("This API key is not authorized for this organization");
          }
          const hasScope = apiKeyScopes.some((scope) => request.apiKeyContext!.scopes.includes(scope));
          if (!hasScope) {
            throw ApiError.forbidden(
              `This API key is missing a required scope (${apiKeyScopes.join(" or ")})`,
            );
          }
          return;
        }
        return sessionPreHandler(request, reply);
      };
    },
  );
});

/** Resolves the actor to attribute an audit-log entry / mutation to,
 * regardless of which auth mode the request came in on — a real
 * dashboard user's id, or an API key's creator as a stand-in for a
 * machine-driven action. Every route using `requireOrgAccess` must use
 * this instead of `request.user!.id`. */
export function actorIdOf(request: FastifyRequest): string {
  if (request.apiKeyContext) {
    return request.apiKeyContext.createdBy;
  }
  if (request.user) {
    return request.user.id;
  }
  throw ApiError.unauthenticated();
}
