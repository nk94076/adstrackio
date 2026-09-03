import type { Prisma } from "@adstrackio/database";
import type { WebhookEventType } from "@adstrackio/shared";

export interface PublishEventInput {
  organizationId: string;
  type: WebhookEventType;
  aggregateType: string;
  aggregateId: string;
  /** Must already be safe to expose to a webhook consumer — no API key
   * hashes, webhook secrets, raw IPs, or other internal-only fields. See
   * docs/api/webhooks.md#payload. */
  payload: Record<string, unknown>;
}

/**
 * Writes one OutboxEvent row (Phase 11: API + Integrations) — see
 * OutboxEvent's schema doc comment for the full transactional-outbox
 * design and why this deliberately takes a `Prisma.TransactionClient`
 * rather than a `PrismaClient`: it must ALWAYS be called from inside the
 * same transaction as the business mutation it describes, on the same
 * branch that also calls `writeAuditLog` — never standalone, and never
 * on a no-op/idempotent-retry branch. See conversions.service.ts,
 * affiliate-partners.service.ts, campaigns.service.ts, and
 * tracking-links.service.ts for the call sites.
 */
export async function publishEvent(tx: Prisma.TransactionClient, input: PublishEventInput) {
  await tx.outboxEvent.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}
