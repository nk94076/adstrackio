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

/** Same closed enum Click.deviceType/BotClassification already use
 * (packages/database/prisma/schema.prisma) — reused verbatim rather than
 * re-declared, matching the exact validation
 * packages/validation/src/routing-rules.ts already applies to its
 * DEVICE_TYPE/BOT_CLASSIFICATION routing-rule condition values. */
export const deviceTypeFilterSchema = z.enum(["UNKNOWN", "DESKTOP", "MOBILE", "TABLET", "BOT", "OTHER"]);
export const botClassificationFilterSchema = z.enum(["UNKNOWN", "HUMAN", "SUSPICIOUS", "BOT"]);

/** Loose 2-letter-alpha shape, not a closed list of real ISO country
 * codes — the same tradeoff routing-rules.ts's COUNTRY condition already
 * documents (catches an obvious typo without maintaining a country list
 * this codebase would need to keep in sync with reality). Normalizes to
 * uppercase so "us"/"US" both match the uppercase values Click.country
 * actually stores (see packages/shared/src/routing-signals.ts). */
const countryFilterSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "country must be a 2-letter code")
  .transform((value) => value.toUpperCase());

/** browser/os have no closed enum on Click (free-text, UA-parser-derived)
 * — same "not validated against a closed list" precedent
 * docs/architecture/rules-routing.md documents for RoutingRule's own
 * BROWSER/OS condition values. Bounded only to reject pathological input. */
const freeTextDimensionFilterSchema = z.string().trim().min(1).max(100);

const baseAnalyticsFilterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  timezone: timezoneSchema,
  campaignId: z.string().cuid().optional(),
  trackingLinkId: z.string().cuid().optional(),
  trackingDomainId: z.string().cuid().optional(),
  /** Phase 9: Affiliate/Partner System — scopes a query down to one
   * partner's attributed traffic. Optional and additive; every existing
   * analytics endpoint accepts it without changing behavior when omitted. */
  affiliatePartnerId: z.string().cuid().optional(),
  /** Phase 10: Attribution & Advanced Reporting — dimension filters over
   * the same columns getClicksByCountry/Device/Browser/Os already group
   * by. Optional and additive; every existing analytics endpoint accepts
   * these without changing behavior when omitted. */
  country: countryFilterSchema.optional(),
  deviceType: deviceTypeFilterSchema.optional(),
  browser: freeTextDimensionFilterSchema.optional(),
  os: freeTextDimensionFilterSchema.optional(),
  botClassification: botClassificationFilterSchema.optional(),
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

/** "month" added in Phase 10 (Attribution & Advanced Reporting) — Postgres's
 * own `date_trunc` already accepts "month" natively, so
 * getClickTimeseries/getConversionTimeseries needed no code change beyond
 * this schema accepting the value; hour/day/week are unchanged from
 * Phase 4. */
export const timeseriesBucketSchema = z.enum(["hour", "day", "week", "month"]);
export type TimeseriesBucket = z.infer<typeof timeseriesBucketSchema>;

/** Phase 10: the closed set of breakdown dimensions
 * GET .../reports/dimensions accepts — only columns Click actually
 * stores, per the brief's "do not invent missing data" instruction. */
export const reportDimensionSchema = z.enum(["country", "deviceType", "browser", "os", "botClassification"]);
export type ReportDimension = z.infer<typeof reportDimensionSchema>;

export const dimensionReportQuerySchema = baseAnalyticsFilterSchema
  .extend({ dimension: reportDimensionSchema })
  .transform((input, ctx) => {
    const { from, to } = resolveRange(input, ctx);
    return { ...input, from, to };
  });
export type DimensionReportQueryInput = z.infer<typeof dimensionReportQuerySchema>;

export const timeseriesFilterSchema = baseAnalyticsFilterSchema
  .extend({
    bucket: timeseriesBucketSchema.default("day"),
  })
  .transform((input, ctx) => {
    const { from, to } = resolveRange(input, ctx);
    return { ...input, from, to };
  });
export type TimeseriesFilterInput = z.infer<typeof timeseriesFilterSchema>;
