import { z } from "zod";

/**
 * Mirrors packages/shared/src/webhook-events.ts's WEBHOOK_SUBSCRIBABLE_EVENT_TYPES
 * — kept as a local literal list rather than an import, matching this
 * package's existing convention (see routing-rules.ts's
 * RoutingConditionField, campaigns.ts's status enums, etc.: this package
 * never imports from @adstrackio/shared, so every enum it validates is its
 * own local mirror). "webhook.test" is deliberately excluded: it is a
 * reserved, non-subscribable event type used only by the test-send
 * endpoint.
 */
export const webhookSubscribableEventTypeSchema = z.enum([
  "conversion.created",
  "conversion.approved",
  "conversion.rejected",
  "conversion.reversed",
  "affiliate_partner.created",
  "affiliate_partner.updated",
  "affiliate_partner.activated",
  "affiliate_partner.paused",
  "affiliate_partner.archived",
  "campaign.created",
  "campaign.updated",
  "tracking_link.created",
  "tracking_link.updated",
]);
export type WebhookSubscribableEventType = z.infer<typeof webhookSubscribableEventTypeSchema>;

export const createWebhookEndpointSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().trim().url().max(2048),
  subscribedEvents: z
    .array(webhookSubscribableEventTypeSchema)
    .min(1, "At least one event type is required")
    .max(webhookSubscribableEventTypeSchema.options.length),
});
export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  url: z.string().trim().url().max(2048).optional(),
  subscribedEvents: z
    .array(webhookSubscribableEventTypeSchema)
    .min(1, "At least one event type is required")
    .max(webhookSubscribableEventTypeSchema.options.length)
    .optional(),
});
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;

export const listWebhookDeliveriesQuerySchema = z.object({
  take: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().cuid().optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;

/**
 * `Idempotency-Key` request header (Phase 11) — see
 * docs/api/api-keys.md#idempotency. Bounded charset/length: this value
 * flows into a database unique-constraint key and (indirectly, via error
 * messages) back to the client, so it is validated the same way any other
 * caller-supplied identifier in this codebase is, never passed through
 * unchecked.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Idempotency-Key may only contain letters, digits, and _ . : -");
