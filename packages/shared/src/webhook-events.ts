/**
 * The closed set of webhook event types AdstrackIO can emit (Phase 11:
 * API + Integrations) — see docs/api/webhooks.md#events.
 *
 * Every entry maps 1:1 to a real, already-audited business-lifecycle
 * transition this codebase already performs (conversion status changes,
 * Phase 9 affiliate-partner lifecycle, campaign/tracking-link create and
 * update) — see apps/api/src/modules/webhooks/outbox.service.ts's
 * `publishEvent` call sites. Deliberately NOT exhaustive of every
 * lifecycle action that exists (e.g. campaign/tracking-link
 * activate/pause/archive are not included): only events explicitly
 * requested for this phase are implemented, per the brief's own "do not
 * create fake events" instruction — extending this list is a future
 * phase's decision, not an incidental side effect of adding a webhook
 * system.
 *
 * "webhook.test" is reserved for the test-send endpoint only (see
 * webhooks.service.ts's `sendTestWebhook`) — it is deliberately excluded
 * from `WEBHOOK_SUBSCRIBABLE_EVENT_TYPES` (an organization cannot
 * "subscribe" to test events; every active endpoint receives a test send
 * on request regardless of its subscribedEvents list) and is never
 * counted as, or mixed into, real business analytics.
 */
export const WEBHOOK_EVENT_TYPES = [
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
  "webhook.test",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_TEST_EVENT_TYPE: WebhookEventType = "webhook.test";

/** The event types an organization may actually subscribe an endpoint
 * to — everything except the reserved test-only type. */
export const WEBHOOK_SUBSCRIBABLE_EVENT_TYPES = WEBHOOK_EVENT_TYPES.filter(
  (type) => type !== WEBHOOK_TEST_EVENT_TYPE,
) as Exclude<WebhookEventType, "webhook.test">[];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}
