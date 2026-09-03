import type { FastifyInstance } from "fastify";
import { createApiKeySchema, listApiKeysQuerySchema } from "@adstrackio/validation";
import { createApiKey, getApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "./api-keys.service.js";

/**
 * API key management (Phase 11) is dashboard-session-only — gated at
 * ADMIN for every operation, including reads. Unlike most other
 * resources in this codebase, "list your organization's API keys" is
 * itself part of "managing" them (the brief's own framing: "OWNER/ADMIN
 * can manage API keys; MEMBER/VIEWER cannot manage unless existing RBAC
 * explicitly allows it" — no such explicit allowance exists here, unlike
 * webhooks' read access for MEMBER/VIEWER). An API key can never be used
 * to manage other API keys (no scope grants that); this module is
 * intentionally unreachable via `fastify.requireOrgAccess` / Bearer auth.
 */
export async function registerApiKeyRoutes(fastify: FastifyInstance) {
  const preHandler = [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")];

  fastify.get(
    "/organizations/:organizationId/api-keys",
    { preHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const query = listApiKeysQuerySchema.parse(request.query);
      const apiKeys = await listApiKeys(fastify.prisma, organizationId, query);
      return { apiKeys };
    },
  );

  fastify.post(
    "/organizations/:organizationId/api-keys",
    { preHandler },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createApiKeySchema.parse(request.body);
      const { apiKey, rawKey } = await createApiKey(fastify.prisma, request.user!.id, organizationId, input);
      reply.status(201);
      // `key` is present ONLY in this response, exactly once. No other
      // endpoint in this module ever returns it again.
      return { apiKey: { ...apiKey, key: rawKey } };
    },
  );

  fastify.get(
    "/organizations/:organizationId/api-keys/:apiKeyId",
    { preHandler },
    async (request) => {
      const { organizationId, apiKeyId } = request.params as {
        organizationId: string;
        apiKeyId: string;
      };
      const apiKey = await getApiKey(fastify.prisma, organizationId, apiKeyId);
      return { apiKey };
    },
  );

  fastify.post(
    "/organizations/:organizationId/api-keys/:apiKeyId/rotate",
    { preHandler },
    async (request) => {
      const { organizationId, apiKeyId } = request.params as {
        organizationId: string;
        apiKeyId: string;
      };
      const { apiKey, rawKey } = await rotateApiKey(fastify.prisma, request.user!.id, organizationId, apiKeyId);
      return { apiKey: { ...apiKey, key: rawKey } };
    },
  );

  fastify.post(
    "/organizations/:organizationId/api-keys/:apiKeyId/revoke",
    { preHandler },
    async (request) => {
      const { organizationId, apiKeyId } = request.params as {
        organizationId: string;
        apiKeyId: string;
      };
      const apiKey = await revokeApiKey(fastify.prisma, request.user!.id, organizationId, apiKeyId);
      return { apiKey };
    },
  );
}
