import { z } from "zod";

/**
 * Default and maximum reporting window for the Click Analytics API
 * (Phase 4). Documented in docs/architecture/click-analytics.md — kept
 * here as the single source of truth both docs and code refer back to.
 */
export const DEFAULT_ANALYTICS_RANGE_DAYS = 7;
export const MAX_ANALYTICS_RANGE_DAYS = 366;

/**
 * Validates via Intl.DateTimeFormat rather than
 * Intl.supportedValuesOf("timeZone"): the latter enumerates the IANA tz
 * database's canonical names, which does NOT include "UTC" itself (a
 * separate ECMA-402 alias) even though it's a perfectly valid value for
 * `timeZone` everywhere else — including "UTC" would otherwise reject the
 * one value this API defaults to.
 */
function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, {
    message: 'timezone must be a valid IANA time zone name (e.g. "America/New_York", "UTC")',
  })
  .default("UTC");

const baseAnalyticsFilterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  timezone: timezoneSchema,
  campaignId: z.string().cuid().optional(),
  trackingLinkId: z.string().cuid().optional(),
  trackingDomainId: z.string().cuid().optional(),
});

/**
 * Resolves the explicit/default from-to window and validates it.
 * - Neither provided: last DEFAULT_ANALYTICS_RANGE_DAYS days ending now.
 * - Only one provided: the other is derived using the default window
 *   width, anchored on whichever bound was given.
 * - `from` must not be after `to`.
 * - The resolved range must not exceed MAX_ANALYTICS_RANGE_DAYS — a
 *   reporting window that wide is almost certainly a mistake, and an
 *   unbounded one would let a single request force a full-table
 *   aggregation scan.
 */
function resolveRange(
  input: { from?: Date; to?: Date },
  ctx: z.RefinementCtx,
): { from: Date; to: Date } {
  const defaultWindowMs = DEFAULT_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000;
  const now = new Date();

  const to = input.to ?? (input.from ? new Date(input.from.getTime() + defaultWindowMs) : now);
  const from = input.from ?? new Date(to.getTime() - defaultWindowMs);

  if (from > to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "from must not be after to",
      path: ["from"],
    });
  }

  if (to.getTime() - from.getTime() > MAX_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `date range must not exceed ${MAX_ANALYTICS_RANGE_DAYS} days`,
      path: ["to"],
    });
  }

  return { from, to };
}

export const analyticsFilterSchema = baseAnalyticsFilterSchema.transform((input, ctx) => {
  const { from, to } = resolveRange(input, ctx);
  return { ...input, from, to };
});
export type AnalyticsFilterInput = z.infer<typeof analyticsFilterSchema>;

export const timeseriesBucketSchema = z.enum(["hour", "day", "week"]);
export type TimeseriesBucket = z.infer<typeof timeseriesBucketSchema>;

export const timeseriesFilterSchema = baseAnalyticsFilterSchema
  .extend({
    bucket: timeseriesBucketSchema.default("day"),
  })
  .transform((input, ctx) => {
    const { from, to } = resolveRange(input, ctx);
    return { ...input, from, to };
  });
export type TimeseriesFilterInput = z.infer<typeof timeseriesFilterSchema>;
