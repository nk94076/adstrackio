import type { PrismaClient } from "@adstrackio/database";
import type { Env } from "@adstrackio/config";
import { encryptSecret, generateWebhookSecret } from "@adstrackio/auth";
import { ApiError, UnsafeWebhookUrlError, WEBHOOK_TEST_EVENT_TYPE, validateWebhookUrl } from "@adstrackio/shared";
import type { CreateWebhookEndpointInput, UpdateWebhookEndpointInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";
import { attemptWebhookDelivery } from "./webhook-delivery-worker.js";

/**
 * Webhook endpoint control plane (Phase 11: API + Integrations) — see
 * docs/api/webhooks.md.
 *
 * organizationId is never taken from the request body — only from the
 * authenticated, membership-checked URL path, the same IDOR boundary
 * every other organization-scoped module in this codebase already
 * enforces. The raw signing secret is generated here and returned
 * exactly once (creation/rotation); every other read of a
 * WebhookEndpoint omits it entirely.
 */

const PUBLIC_FIELDS = {
  id: true,
  organizationId: true,
  name: true,
  url: true,
  active: true,
  subscribedEvents: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  lastDeliveryAt: true,
} as const;

async function validateUrlOrThrow(url: string, env: Env): Promise<string> {
  try {
    const validated = await validateWebhookUrl(url, { requireHttps: env.NODE_ENV === "production" });
    return validated.url;
  } catch (error) {
    if (error instanceof UnsafeWebhookUrlError) {
      throw ApiError.validation(error.message);
    }
    throw error;
  }
}

export async function createWebhookEndpoint(
  prisma: PrismaClient,
  env: Env,
  actorUserId: string,
  organizationId: string,
  input: CreateWebhookEndpointInput,
) {
  const url = await validateUrlOrThrow(input.url, env);
  const secret = generateWebhookSecret();

  const endpoint = await prisma.$transaction(async (tx) => {
    const created = await tx.webhookEndpoint.create({
      data: {
        organizationId,
        name: input.name,
        url,
        secretEncrypted: encryptSecret(secret, env.AUTH_SECRET),
        subscribedEvents: input.subscribedEvents,
        createdBy: actorUserId,
      },
      select: PUBLIC_FIELDS,
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "webhook.created",
      entityType: "WebhookEndpoint",
      entityId: created.id,
      metadata: { name: created.name, subscribedEvents: created.subscribedEvents },
    });

    return created;
  });

  return { webhookEndpoint: endpoint, secret };
}

export async function listWebhookEndpoints(prisma: PrismaClient, organizationId: string) {
  return prisma.webhookEndpoint.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: PUBLIC_FIELDS,
  });
}

export async function getWebhookEndpoint(
  prisma: PrismaClient,
  organizationId: string,
  webhookEndpointId: string,
) {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: webhookEndpointId, organizationId },
    select: PUBLIC_FIELDS,
  });
  if (!endpoint) {
    throw ApiError.notFound("Webhook endpoint not found");
  }
  return endpoint;
}

export async function updateWebhookEndpoint(
  prisma: PrismaClient,
  env: Env,
  actorUserId: string,
  organizationId: string,
  webhookEndpointId: string,
  input: UpdateWebhookEndpointInput,
) {
  await getWebhookEndpoint(prisma, organizationId, webhookEndpointId);
  const url = input.url !== undefined ? await validateUrlOrThrow(input.url, env) : undefined;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.webhookEndpoint.update({
      where: { id: webhookEndpointId },
      data: { name: input.name, url, subscribedEvents: input.subscribedEvents },
      select: PUBLIC_FIELDS,
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "webhook.updated",
      entityType: "WebhookEndpoint",
      entityId: updated.id,
    });

    return updated;
  });
}

export async function rotateWebhookSecret(
  prisma: PrismaClient,
  env: Env,
  actorUserId: string,
  organizationId: string,
  webhookEndpointId: string,
) {
  await getWebhookEndpoint(prisma, organizationId, webhookEndpointId);
  const secret = generateWebhookSecret();

  const webhookEndpoint = await prisma.$transaction(async (tx) => {
    const updated = await tx.webhookEndpoint.update({
      where: { id: webhookEndpointId },
      data: { secretEncrypted: encryptSecret(secret, env.AUTH_SECRET) },
      select: PUBLIC_FIELDS,
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "webhook.secret_rotated",
      entityType: "WebhookEndpoint",
      entityId: updated.id,
    });

    return updated;
  });

  return { webhookEndpoint, secret };
}

/**
 * Disabling is one-directional from this endpoint (re-enable happens via
 * PATCH, not a separate route) and idempotent — a conditional updateMany
 * guarded on `active: true` is sufficient race-safety, mirroring
 * api-keys.service.ts's revokeApiKey.
 */
export async function disableWebhookEndpoint(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  webhookEndpointId: string,
) {
  const existing = await getWebhookEndpoint(prisma, organizationId, webhookEndpointId);
  if (!existing.active) {
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.webhookEndpoint.updateMany({
      where: { id: webhookEndpointId, organizationId, active: true },
      data: { active: false },
    });

    const updated = await tx.webhookEndpoint.findUniqueOrThrow({
      where: { id: webhookEndpointId },
      select: PUBLIC_FIELDS,
    });

    if (count > 0) {
      await writeAuditLog(tx, {
        organizationId,
        actorUserId,
        action: "webhook.disabled",
        entityType: "WebhookEndpoint",
        entityId: webhookEndpointId,
        metadata: { name: updated.name },
      });
    }

    return updated;
  });
}

/**
 * Sends one clearly-marked test event ("webhook.test") to a single
 * endpoint, bypassing its `subscribedEvents`/`active` filter (a test
 * targets exactly the endpoint the caller named, regardless of what it's
 * otherwise configured for) and reusing the EXACT same signing/delivery
 * code path as a real event, for a realistic result. Never creates any
 * Conversion/Campaign/etc. business row, and the synthetic OutboxEvent it
 * writes is typed distinctly from every real business event — see
 * packages/shared/src/webhook-events.ts's WEBHOOK_TEST_EVENT_TYPE doc
 * comment. Not audit-logged: this is observability (the returned
 * WebhookDelivery row IS the record), not an audit-worthy configuration
 * change.
 */
export async function sendTestWebhook(
  prisma: PrismaClient,
  env: Env,
  organizationId: string,
  webhookEndpointId: string,
) {
  await getWebhookEndpoint(prisma, organizationId, webhookEndpointId);

  const delivery = await prisma.$transaction(async (tx) => {
    const event = await tx.outboxEvent.create({
      data: {
        organizationId,
        type: WEBHOOK_TEST_EVENT_TYPE,
        aggregateType: "WebhookEndpoint",
        aggregateId: webhookEndpointId,
        payload: { message: "This is a test event from AdstrackIO.", webhookEndpointId },
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
    return tx.webhookDelivery.create({
      data: { webhookEndpointId, eventId: event.id },
    });
  });

  await attemptWebhookDelivery(prisma, env, delivery);
  return prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
}

export async function listWebhookDeliveries(
  prisma: PrismaClient,
  organizationId: string,
  webhookEndpointId: string,
  query: { take: number; cursor?: string },
) {
  await getWebhookEndpoint(prisma, organizationId, webhookEndpointId);
  return prisma.webhookDelivery.findMany({
    where: { webhookEndpointId },
    orderBy: { createdAt: "desc" },
    take: query.take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
  });
}
