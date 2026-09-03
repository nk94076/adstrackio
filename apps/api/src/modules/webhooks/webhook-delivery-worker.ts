import { Prisma, type PrismaClient } from "@adstrackio/database";
import type { Env } from "@adstrackio/config";
import { decryptSecret } from "@adstrackio/auth";
import { signWebhookPayload, validateWebhookUrl } from "@adstrackio/shared";
import { isRetryableWebhookFailure, sendWebhookHttpRequest } from "./webhook-http-client.js";

/**
 * Asynchronous webhook delivery (Phase 11: API + Integrations) — see
 * docs/api/webhooks.md#delivery-architecture.
 *
 * This is a minimal PostgreSQL-backed queue, not BullMQ/Redis: this
 * codebase's REDIS_URL env var exists only as Phase-1 foundation
 * (validated at startup, never actually connected to or imported by any
 * package — confirmed via a full-repo search) and no queue
 * infrastructure exists yet. Introducing Redis/BullMQ purely for this
 * phase would be exactly the "unnecessary infrastructure complexity" the
 * brief warns against; Postgres's SKIP LOCKED already gives safe
 * multi-worker dequeue semantics without a new moving part.
 *
 * NEVER called from apps/tracker or from the tracker redirect hot path —
 * this module isn't even imported there. It's invoked from apps/api's
 * own process entrypoint (index.ts) on a plain interval, entirely
 * separate from any request-handling code path.
 */

/** Attempt 1 is immediate (no delay); these are the delays before
 * attempts 2-5, in seconds — short then longer, capped well under an
 * hour, per docs/api/webhooks.md#retries. */
const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800];
const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

const REQUEST_TIMEOUT_MS = 8_000;
/** Kept deliberately small: each row in this batch is processed while
 * holding its `FOR UPDATE SKIP LOCKED` lock for the duration of a real
 * network call (see `processPendingWebhookDeliveries`'s doc comment for
 * why) — a large batch would hold that transaction open far too long. */
const DELIVERY_BATCH_SIZE = 5;
const FAN_OUT_BATCH_SIZE = 100;
/** Prisma's interactive-transaction default timeout (5s) is far too
 * short once real HTTP calls happen inside it; sized for
 * DELIVERY_BATCH_SIZE attempts at REQUEST_TIMEOUT_MS each, plus headroom. */
const DELIVERY_TRANSACTION_TIMEOUT_MS = 60_000;

interface DueDeliveryRow {
  id: string;
  webhookEndpointId: string;
  eventId: string;
  attempt: number;
}

/**
 * Fans every PENDING OutboxEvent out into one WebhookDelivery row per
 * active, subscribed WebhookEndpoint in that event's organization, then
 * marks the event PROCESSED. Safe to call repeatedly/concurrently: the
 * `@@unique([webhookEndpointId, eventId])` constraint (via
 * `skipDuplicates`) means re-fanning an already-processed event is a
 * no-op, and marking an already-PROCESSED event PROCESSED again is
 * harmless.
 */
export async function fanOutPendingOutboxEvents(prisma: PrismaClient): Promise<number> {
  const events = await prisma.outboxEvent.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: FAN_OUT_BATCH_SIZE,
  });

  let fannedOut = 0;
  for (const event of events) {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { organizationId: event.organizationId, active: true, subscribedEvents: { has: event.type } },
      select: { id: true },
    });

    if (endpoints.length > 0) {
      const created = await prisma.webhookDelivery.createMany({
        data: endpoints.map((endpoint) => ({ webhookEndpointId: endpoint.id, eventId: event.id })),
        skipDuplicates: true,
      });
      fannedOut += created.count;
    }

    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  }
  return fannedOut;
}

/**
 * Attempts delivery of exactly one WebhookDelivery row and writes its
 * outcome back. `db` may be a plain PrismaClient or an open transaction
 * client — see `processPendingWebhookDeliveries` for why the caller
 * holds a transaction (and therefore a row lock) open across this call.
 *
 * `validateUrl` defaults to the real `validateWebhookUrl` (the actual
 * SSRF gate) and is NEVER overridden by production code (index.ts,
 * webhooks.service.ts's `sendTestWebhook`) — it exists solely as a test
 * seam, mirroring `validateWebhookUrl`'s own injectable `resolveHostname`
 * option one level up, so this module's retry/signing/status-transition
 * logic can be exercised against a real local test HTTP server without
 * that test needing to defeat (or weaken) the real private-IP block —
 * which, correctly, cannot be bypassed for any address that genuinely
 * falls in a blocked range, injected resolver or not. See
 * apps/api/test/api-integrations.test.ts's webhook delivery tests.
 */
export async function attemptWebhookDelivery(
  db: PrismaClient | Prisma.TransactionClient,
  env: Env,
  delivery: DueDeliveryRow,
  validateUrl: typeof validateWebhookUrl = validateWebhookUrl,
): Promise<void> {
  const attempt = delivery.attempt + 1;

  const [endpoint, event] = await Promise.all([
    db.webhookEndpoint.findUnique({ where: { id: delivery.webhookEndpointId } }),
    db.outboxEvent.findUnique({ where: { id: delivery.eventId } }),
  ]);

  if (!endpoint || !event) {
    // Referential integrity (ON DELETE CASCADE on both FKs) means this
    // row would already be gone if either parent were deleted — fail
    // closed rather than throw if it's somehow reached anyway.
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: { attempt, status: "FAILED", responseBodySnippet: "endpoint or event no longer exists" },
    });
    return;
  }

  const envelope = {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt.toISOString(),
    organizationId: event.organizationId,
    data: event.payload,
  };
  const rawBody = JSON.stringify(envelope);
  const timestamp = String(Date.now());

  let status: number | null = null;
  let bodySnippet = "";
  let networkError = false;
  // A URL-validation/SSRF-check failure is terminal and never retried: an
  // endpoint whose destination is unsafe (or whose DNS now resolves
  // somewhere unsafe) will never become safe by simply trying again a few
  // minutes later. This is deliberately NOT folded into `networkError`
  // below (which IS retryable) — see docs/api/webhooks.md#ssrf-protection.
  let terminalFailure = false;

  // Re-validated AND re-resolved fresh, immediately before connecting —
  // this (not the one-time check at endpoint creation/update) is the
  // real SSRF security boundary, since DNS can change at any point
  // between then and now. See webhook-url.ts's doc comment.
  let validated: Awaited<ReturnType<typeof validateWebhookUrl>> | undefined;
  try {
    validated = await validateUrl(endpoint.url, { requireHttps: env.NODE_ENV === "production" });
  } catch (error) {
    terminalFailure = true;
    bodySnippet = error instanceof Error ? error.message : "Webhook URL failed validation";
  }

  if (validated) {
    try {
      const secret = decryptSecret(endpoint.secretEncrypted, env.AUTH_SECRET);
      const signature = signWebhookPayload(secret, timestamp, rawBody);

      const result = await sendWebhookHttpRequest({
        url: validated.url,
        pinnedAddress: validated.resolvedAddresses[0]!,
        headers: {
          "Content-Type": "application/json",
          "X-Adstrackio-Signature": signature,
          "X-Adstrackio-Event-Id": event.id,
          "X-Adstrackio-Timestamp": timestamp,
        },
        body: rawBody,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      status = result.status;
      bodySnippet = result.bodySnippet;
    } catch (error) {
      networkError = true;
      bodySnippet = error instanceof Error ? error.message : "Unknown webhook delivery error";
    }
  }

  const succeeded = status !== null && status >= 200 && status < 300;
  const retryable = !succeeded && !terminalFailure && isRetryableWebhookFailure(status, networkError);

  let nextStatus: "DELIVERED" | "FAILED" | "EXHAUSTED" | "PENDING";
  let nextAttemptAt = new Date();
  if (succeeded) {
    nextStatus = "DELIVERED";
  } else if (!retryable) {
    nextStatus = "FAILED";
  } else if (attempt >= MAX_ATTEMPTS) {
    nextStatus = "EXHAUSTED";
  } else {
    nextStatus = "PENDING";
    nextAttemptAt = new Date(Date.now() + RETRY_DELAYS_SECONDS[attempt - 1]! * 1000);
  }

  await db.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempt,
      status: nextStatus,
      responseStatus: status,
      responseBodySnippet: bodySnippet.slice(0, 2000),
      deliveredAt: succeeded ? new Date() : null,
      nextAttemptAt,
    },
  });
  await db.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { lastDeliveryAt: new Date() },
  });
}

/**
 * The worker's one entry point, called on a plain interval from
 * apps/api's process entrypoint (never from a request path). Fans out
 * pending events, then claims and attempts up to DELIVERY_BATCH_SIZE due
 * deliveries.
 *
 * The claim-and-attempt loop runs inside ONE transaction holding a
 * `FOR UPDATE SKIP LOCKED` lock on the claimed rows for the duration of
 * the real HTTP calls that follow — an accepted simplification for this
 * phase's scale (a handful of rows, an 8s per-request timeout, a 60s
 * transaction ceiling) that guarantees two concurrent worker intervals
 * (or, if this API is ever scaled to multiple processes, two different
 * processes) can never double-send the same delivery, without needing a
 * separate lease/heartbeat mechanism. A future phase handling much
 * higher delivery volume should split "claim" and "execute" into two
 * steps instead of holding the transaction across the network I/O.
 */
export async function processPendingWebhookDeliveries(prisma: PrismaClient, env: Env): Promise<number> {
  const fannedOut = await fanOutPendingOutboxEvents(prisma);

  const attempted = await prisma.$transaction(
    async (tx) => {
      const due = await tx.$queryRaw<DueDeliveryRow[]>`
        SELECT id, "webhookEndpointId", "eventId", attempt FROM webhook_deliveries
        WHERE status = 'PENDING' AND "nextAttemptAt" <= NOW()
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${DELIVERY_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;
      for (const delivery of due) {
        await attemptWebhookDelivery(tx, env, delivery);
      }
      return due.length;
    },
    { timeout: DELIVERY_TRANSACTION_TIMEOUT_MS },
  );

  return fannedOut + attempted;
}
