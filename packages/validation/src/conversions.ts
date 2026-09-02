import { z } from "zod";

/**
 * A caller-supplied clock is never authoritative, but rejecting every
 * timestamp that's even slightly ahead of the server's own clock would
 * bounce legitimate requests over ordinary clock drift between the
 * caller and this server. Five minutes is generous enough to absorb that
 * drift while still catching "absurd dates far in the future" — see
 * docs/architecture/conversion-tracking.md#timestamps.
 */
export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Metadata size/depth limits (Phase 7) — Campaign/Destination/TrackingLink
 * metadata fields have no such limit today, but a conversion is the first
 * write path in this codebase callable by an external, potentially
 * automated/machine caller (an advertiser's own conversion-reporting
 * integration) rather than only a human filling out a dashboard form, so
 * an unbounded JSON blob here is a more credible abuse vector. Kept local
 * to this module rather than generalized, since no other model has asked
 * for this yet.
 */
const METADATA_MAX_SERIALIZED_BYTES = 10_000;
const METADATA_MAX_DEPTH = 5;

function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") {
    return depth;
  }
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  if (children.length === 0) {
    return depth + 1;
  }
  // No early exit once depth exceeds the limit: the caller needs the true
  // depth (however far past the limit it goes) to reject correctly — a
  // capped return value here would make "depth > limit" indistinguishable
  // from "depth == limit" and silently accept anything deeper. Bounded
  // recursion is safe regardless, since METADATA_MAX_SERIALIZED_BYTES
  // already caps how large (and therefore how deep) the input can be.
  return Math.max(...children.map((child) => jsonDepth(child, depth + 1)));
}

export const boundedMetadataSchema = z
  .record(z.unknown())
  .optional()
  .refine(
    (value) => value === undefined || JSON.stringify(value).length <= METADATA_MAX_SERIALIZED_BYTES,
    { message: `metadata must not exceed ${METADATA_MAX_SERIALIZED_BYTES} bytes when serialized` },
  )
  .refine((value) => value === undefined || jsonDepth(value) <= METADATA_MAX_DEPTH, {
    message: `metadata must not be nested deeper than ${METADATA_MAX_DEPTH} levels`,
  });

/**
 * The Click primary key (apps/tracker/src/modules/tracker/click-id.ts),
 * generated via crypto.randomUUID() — NOT a Prisma cuid() like every other
 * ID in this API. A conversion's clickId must be validated against the
 * format it's actually stored in, not copy-pasted from the .cuid()
 * validators used elsewhere in this package.
 */
export const clickIdSchema = z.string().uuid("clickId must be a valid click identifier");

export const createConversionSchema = z
  .object({
    clickId: clickIdSchema,
    eventName: z.string().trim().min(1).max(120),
    // Decimal(12,2) in the database allows up to 10 integer digits; capped
    // here so an out-of-range value fails validation with a clear 400
    // instead of a raw database error. finite() rejects NaN/Infinity.
    value: z.number().finite().nonnegative().max(9_999_999_999.99).optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .length(3, "Currency must be a 3-letter ISO code")
      .optional(),
    externalConversionId: z.string().trim().min(1).max(255).optional(),
    occurredAt: z.coerce.date().optional(),
    metadata: boundedMetadataSchema,
  })
  .refine((data) => (data.value === undefined) === (data.currency === undefined), {
    message: "value and currency must be provided together",
    path: ["currency"],
  })
  .refine(
    (data) => !data.occurredAt || data.occurredAt.getTime() <= Date.now() + MAX_FUTURE_CLOCK_SKEW_MS,
    { message: "occurredAt cannot be in the future", path: ["occurredAt"] },
  );
export type CreateConversionInput = z.infer<typeof createConversionSchema>;

export const conversionStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "REVERSED"]);

/** Optional filters for GET .../conversions — mirrors the cursor-based
 * pagination shape audit-logs.routes.ts already uses (take default/cap,
 * opaque id cursor), rather than inventing a second pagination style. */
export const listConversionsQuerySchema = z.object({
  status: conversionStatusSchema.optional(),
  campaignId: z.string().cuid().optional(),
  trackingLinkId: z.string().cuid().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().cuid().optional(),
});
export type ListConversionsQuery = z.infer<typeof listConversionsQuerySchema>;
