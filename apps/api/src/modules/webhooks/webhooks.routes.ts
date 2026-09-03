import type { FastifyInstance } from "fastify";
import type { Env } from "@adstrackio/config";
import { createWebhookEndpointSchema, listWebhookDeliveriesQuerySchema, updateWebhookEndpointSchema } from "@adstrackio/validation";
import {
  createWebhookEndpoint,
  disableWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  rotateWebhookSecret,
  sendTestWebhook,
  updateWebhookEndpoint,
} from "./webhooks.service.js";

/**
 * Webhook endpoint management (Phase 11) is dashboard-session-only, like
 * api-keys.routes.ts — no API key scope grants managing webhooks. RBAC
 * matches the brief exactly: OWNER/ADMIN create/update/rotate/disable/
 * test; MEMBER and VIEWER can read (list/get/delivery history) — the
 * existing minimum-read-role convention this codebase already uses
 * everywhere else (VIEWER).
 */
export async function registerWebhookRoutes(fastify: FastifyInstance, options: { env: Env }) {
  const readPreHandler = [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")];
  const managePreHandler = [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")];

  fastify.get(
    "/organizations/:organizationId/webhooks",
    { preHandler: readPreHandler },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const webhooks = await listWebhookEndpoints(fastify.prisma, organizationId);
      return { webhooks };
    },
  );

  fastify.post(
    "/organizations/:organizationId/webhooks",
    { preHandler: managePreHandler },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createWebhookEndpointSchema.parse(request.body);
      const { webhookEndpoint, secret } = await createWebhookEndpoint(
        fastify.prisma,
        options.env,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      // `secret` is present ONLY in this response, exactly once.
      return { webhook: { ...webhookEndpoint, secret } };
    },
  );

  fastify.get(
    "/organizations/:organizationId/webhooks/:webhookId",
    { preHandler: readPreHandler },
    async (request) => {
      const { organizationId, webhookId } = request.params as {
        organizationId: string;
        webhookId: string;
      };
      const webhook = await getWebhookEndpoint(fastify.prisma, organizationId, webhookId);
      return { webhook };
    },
  );

  fastify.patch(
    "/organizations/:organizationId/webhooks/:webhookId",
    { preHandler: managePreHandler },
    async (request) => {
      const { organizationId, webhookId } = request.params as {
        organizationId: string;
        webhookId: string;
      };
      const input = updateWebhookEndpointSchema.parse(request.body);
      const webhook = await updateWebhookEndpoint(
        fastify.prisma,
        options.env,
        request.user!.id,
        organizationId,
        webhookId,
        input,
      );
      return { webhook };
    },
  );

  fastify.post(
    "/organizations/:organizationId/webhooks/:webhookId/rotate-secret",
    { preHandler: managePreHandler },
    async (request) => {
      const { organizationId, webhookId } = request.params as {
        organizationId: string;
        webhookId: string;
      };
      const { webhookEndpoint, secret } = await rotateWebhookSecret(
        fastify.prisma,
        options.env,
        request.user!.id,
        organizationId,
        webhookId,
      );
      return { webhook: { ...webhookEndpoint, secret } };
    },
  );

  fastify.post(
    "/organizations/:organizationId/webhooks/:webhookId/disable",
    { preHandler: managePreHandler },
    async (request) => {
      const { organizationId, webhookId } = request.params as {
        organizationId: string;
        webhookId: string;
      };
      const webhook = await disableWebhookEndpoint(fastify.prisma, request.user!.id, organizationId, webhookId);
      return { webhook };
    },
  );

  fastify.post(
    "/organizations/:organizationId/webhooks/:webhookId/test",
    { preHandler: managePreHandler },
    async (request) => {
      const { organizationId, webhookId } = request.params as {
        organizationId: string;
        webhookId: string;
      };
      const delivery = await sendTestWebhook(fastify.prisma, options.env, organizationId, webhookId);
      return { delivery };
    },
  );

  fastify.get(
    "/organizations/:organizationId/webhooks/:webhookId/deliveries",
    { preHandler: readPreHandler },
    async (request) => {
      const { organizationId, webhookId } = request.params as {
        organizationId: string;
        webhookId: string;
      };
      const query = listWebhookDeliveriesQuerySchema.parse(request.query);
      const deliveries = await listWebhookDeliveries(fastify.prisma, organizationId, webhookId, query);
      return { deliveries };
    },
  );
}
