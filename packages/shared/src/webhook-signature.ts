import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook payload signing (Phase 11: API + Integrations) — see
 * docs/api/webhooks.md#signatures.
 *
 * The signing input is `${timestamp}.${rawBody}` — the EXACT bytes
 * transmitted on the wire, never a re-serialization of a parsed object
 * (re-serializing can silently reorder keys or change number/whitespace
 * formatting, producing a signature a receiver's independent
 * `JSON.stringify` could never reproduce). Callers must sign the same
 * string they are about to write to the request body, not an object they
 * later pass to JSON.stringify a second time.
 */
export function buildWebhookSigningInput(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(buildWebhookSigningInput(timestamp, rawBody)).digest("hex");
}

/**
 * Verifies a received webhook signature. Intended as the reference
 * implementation documented for webhook consumers (docs/api/webhooks.md),
 * and reused server-side by the test-send path to self-check before
 * delivery. Constant-time comparison; never a plain string `===`.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = signWebhookPayload(secret, timestamp, rawBody);
  const expectedBuffer = Buffer.from(expected, "hex");
  let actualBuffer: Buffer;
  try {
    actualBuffer = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Maximum age (ms) a receiver should accept for `X-Adstrackio-Timestamp`
 * — replay-attack protection. Documented for webhook consumers; also used
 * by this codebase's own webhook test-send self-check. */
export const WEBHOOK_MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export function isWebhookTimestampFresh(timestamp: string, now: number = Date.now()): boolean {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return Math.abs(now - parsed) <= WEBHOOK_MAX_TIMESTAMP_SKEW_MS;
}
