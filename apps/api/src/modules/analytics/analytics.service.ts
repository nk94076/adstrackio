import { Prisma, type PrismaClient } from "@adstrackio/database";
import type { ReportDimension, TimeseriesBucket } from "@adstrackio/validation";

/**
 * Click Analytics (Phase 4) — see docs/architecture/click-analytics.md for
 * the full design rationale (metric definitions, unique-click methodology,
 * timezone handling, performance strategy).
 *
 * Every query here is a single PostgreSQL aggregation statement scoped by
 * organizationId + an occurredAt range (and optional campaign/link/domain
 * filters) — nothing fetches Click rows into Node to aggregate in memory.
 * COUNT(*)/COUNT(*) FILTER/COUNT(DISTINCT ...)/date_trunc all run in
 * Postgres; see the existing indexes this relies on:
 * clicks(organizationId, occurredAt), clicks(campaignId, occurredAt),
 * clicks(trackingLinkId, occurredAt).
 */

export interface AnalyticsFilters {
  organizationId: string;
  from: Date;
  to: Date;
  campaignId?: string;
  trackingLinkId?: string;
  trackingDomainId?: string;
  /** Phase 9: Affiliate/Partner System — scopes every query in this file
   * down to one partner's attributed traffic. Clicks carry
   * affiliatePartnerId directly; conversions have no column of their own
   * (see buildConversionWhere below) and are matched by joining through
   * the click each conversion references. */
  affiliatePartnerId?: string;
  /** Phase 10: Attribution & Advanced Reporting — dimension filters over
   * the same Click columns getClicksByCountry/Device/Browser/Os already
   * group by. Like affiliatePartnerId, conversions have none of these
   * columns and are matched by joining through the click each conversion
   * references (see buildConversionWhere below). */
  country?: string;
  deviceType?: string;
  browser?: string;
  os?: string;
  botClassification?: string;
}

/** Cap on rows returned by a breakdown query (by-campaign, by-referrer,
 * etc.) — a safety valve against an organization with an unbounded number
 * of distinct referrers/links, not a pagination mechanism. */
const BREAKDOWN_ROW_LIMIT = 100;

function buildWhere(filters: AnalyticsFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`c."organizationId" = ${filters.organizationId}`,
    Prisma.sql`c."occurredAt" >= ${filters.from}`,
    Prisma.sql`c."occurredAt" < ${filters.to}`,
  ];
  if (filters.campaignId) {
    conditions.push(Prisma.sql`c."campaignId" = ${filters.campaignId}`);
  }
  if (filters.trackingLinkId) {
    conditions.push(Prisma.sql`c."trackingLinkId" = ${filters.trackingLinkId}`);
  }
  if (filters.trackingDomainId) {
    conditions.push(
      Prisma.sql`c."trackingLinkId" IN (SELECT id FROM tracking_links WHERE "trackingDomainId" = ${filters.trackingDomainId})`,
    );
  }
  if (filters.affiliatePartnerId) {
    conditions.push(Prisma.sql`c."affiliatePartnerId" = ${filters.affiliatePartnerId}`);
  }
  if (filters.country) {
    conditions.push(Prisma.sql`c.country = ${filters.country}`);
  }
  if (filters.deviceType) {
    conditions.push(Prisma.sql`c."deviceType" = ${filters.deviceType}::"DeviceType"`);
  }
  if (filters.browser) {
    conditions.push(Prisma.sql`c.browser = ${filters.browser}`);
  }
  if (filters.os) {
    conditions.push(Prisma.sql`c.os = ${filters.os}`);
  }
  if (filters.botClassification) {
    conditions.push(Prisma.sql`c."botClassification" = ${filters.botClassification}::"BotClassification"`);
  }
  return Prisma.join(conditions, " AND ");
}

/** Shared FILTER/DISTINCT fragment used by every query that reports the
 * human/bot/unique breakdown alongside a raw click count.
 *
 * `uniqueClicksInRange` is deliberately named to distinguish it from
 * `ClickTimeseriesPoint.uniqueClicksInBucket` below — both are
 * `COUNT(DISTINCT (ipHash, userAgent))`, but computed over different
 * windows (the whole requested date range here vs. one bucket there), so
 * they are NOT directly comparable or summable across a timeseries. See
 * docs/architecture/click-analytics.md#unique-click-methodology. */
const CLASSIFICATION_AGGREGATES = Prisma.sql`
  COUNT(*)::int AS clicks,
  COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
  COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
  COUNT(*) FILTER (WHERE c."botClassification" = 'SUSPICIOUS')::int AS "suspiciousClicks",
  COUNT(*) FILTER (WHERE c."botClassification" = 'UNKNOWN' OR c."botClassification" IS NULL)::int AS "unknownClicks",
  COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
`;

export interface ClickSummary {
  totalClicks: number;
  humanClicks: number;
  botClicks: number;
  suspiciousClicks: number;
  unknownClicks: number;
  /** COUNT(DISTINCT (ipHash, userAgent)) over the ENTIRE requested date
   * range — see docs/architecture/click-analytics.md#unique-click-methodology.
   * Not comparable to ClickTimeseriesPoint.uniqueClicksInBucket, which is
   * the same computation scoped to one bucket instead. */
  uniqueClicksInRange: number;
  botPercentage: number;
}

export async function getClickSummary(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickSummary> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    {
      clicks: number;
      humanClicks: number;
      botClicks: number;
      suspiciousClicks: number;
      unknownClicks: number;
      uniqueClicksInRange: number;
    }[]
  >(Prisma.sql`
    SELECT ${CLASSIFICATION_AGGREGATES}
    FROM clicks c
    WHERE ${where}
  `);

  const row = rows[0]!;
  return {
    totalClicks: row.clicks,
    humanClicks: row.humanClicks,
    botClicks: row.botClicks,
    suspiciousClicks: row.suspiciousClicks,
    unknownClicks: row.unknownClicks,
    uniqueClicksInRange: row.uniqueClicksInRange,
    botPercentage: row.clicks > 0 ? Math.round((row.botClicks / row.clicks) * 10000) / 100 : 0,
  };
}

export interface ClickTimeseriesPoint {
  /** ISO-8601-shaped local timestamp (no "Z"/offset) — the start of this
   * bucket's wall-clock time in the request's `timezone`. See
   * docs/architecture/click-analytics.md for why this intentionally omits
   * a UTC marker. */
  bucket: string;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  /** COUNT(DISTINCT (ipHash, userAgent)) computed independently WITHIN
   * THIS BUCKET only — a visitor who clicks again in a later bucket is
   * counted again there. Deliberately named differently from
   * ClickSummary.uniqueClicksInRange (and ClickBreakdownRow's field of the
   * same name): the two are different uniqueness windows and must never
   * be summed across buckets and compared against the range-wide total —
   * see docs/architecture/click-analytics.md#unique-click-methodology. */
  uniqueClicksInBucket: number;
}

export async function getClickTimeseries(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
  bucket: TimeseriesBucket,
  timezone: string,
): Promise<ClickTimeseriesPoint[]> {
  const where = buildWhere(filters);
  // occurredAt is stored as a naive `timestamp` whose wall-clock digits
  // are always UTC (Prisma writes JS Date -> UTC digits, never localized).
  // "AT TIME ZONE 'UTC'" reinterprets it as the timestamptz it actually
  // represents; the second "AT TIME ZONE $timezone" converts that instant
  // to the requested zone's wall clock before truncating. Verified against
  // real Postgres — see docs/architecture/click-analytics.md.
  const rows = await prisma.$queryRaw<
    { bucketStart: Date; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInBucket: number }[]
  >(Prisma.sql`
    SELECT
      date_trunc(${bucket}, c."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}) AS "bucketStart",
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInBucket"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `);

  return rows.map((row) => ({
    // Postgres returns a naive timestamp already expressed in the target
    // zone's wall clock; the driver/Prisma attach a "Z" purely because JS
    // Date has no tz-less representation. Stripping it back off avoids
    // implying this is a true UTC instant.
    bucket: row.bucketStart.toISOString().slice(0, 19),
    clicks: row.clicks,
    humanClicks: row.humanClicks,
    botClicks: row.botClicks,
    uniqueClicksInBucket: row.uniqueClicksInBucket,
  }));
}

export interface ClickBreakdownRow {
  key: string;
  label: string;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  /** Same range-wide window as ClickSummary.uniqueClicksInRange, scoped to
   * this breakdown row's group — not comparable to a timeseries point's
   * uniqueClicksInBucket. See
   * docs/architecture/click-analytics.md#unique-click-methodology. */
  uniqueClicksInRange: number;
}

export async function getClicksByCampaign(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; label: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      c."campaignId" AS key,
      camp.name AS label,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    JOIN campaigns camp ON camp.id = c."campaignId"
    WHERE ${where}
    GROUP BY c."campaignId", camp.name
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows;
}

export async function getClicksByLink(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; label: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      c."trackingLinkId" AS key,
      tl.slug AS label,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    JOIN tracking_links tl ON tl.id = c."trackingLinkId"
    WHERE ${where}
    GROUP BY c."trackingLinkId", tl.slug
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows;
}

export async function getClicksByDomain(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; label: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      td.id AS key,
      td.hostname AS label,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    JOIN tracking_links tl ON tl.id = c."trackingLinkId"
    JOIN tracking_domains td ON td.id = tl."trackingDomainId"
    WHERE ${where}
    GROUP BY td.id, td.hostname
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows;
}

// Extracts a bare hostname from an absolute URL string, falling back to
// "(direct)" for a missing referrer or one that isn't a well-formed
// hostname-bearing URL. Deliberately conflates "no referrer sent" and
// "referrer present but unparseable" into one bucket — see
// docs/architecture/click-analytics.md for that tradeoff.
const REFERRER_HOST_PATTERN = "^(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?(?:[^/@]+@)?([^/:?#]+).*$";
const HOSTNAME_CHARSET_PATTERN = "^[a-zA-Z0-9.-]+$";

export async function getClicksByReferrer(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      CASE
        WHEN c.referrer IS NULL OR c.referrer = '' THEN '(direct)'
        WHEN regexp_replace(c.referrer, ${REFERRER_HOST_PATTERN}, '\\1') ~ ${HOSTNAME_CHARSET_PATTERN}
          THEN lower(regexp_replace(c.referrer, ${REFERRER_HOST_PATTERN}, '\\1'))
        ELSE '(direct)'
      END AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}

export async function getClicksByDevice(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c."deviceType"::text, 'UNKNOWN') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}

export async function getClicksByBrowser(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c.browser, 'Unknown') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}

export async function getClicksByOs(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c.os, 'Unknown') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}

/** Phase 10: Attribution & Advanced Reporting — the one click breakdown
 * dimension Phase 4 never added (bot classification), following the exact
 * same shape as getClicksByDevice/getClicksByOs. Also the click-side half
 * of getDimensionBreakdown's "botClassification" dimension below, but kept
 * as its own exported function for the same reason getClicksByCountry
 * etc. are: a stable, independently-callable breakdown a caller can use
 * without the conversion join getDimensionBreakdown always performs. */
export async function getClicksByBotClassification(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c."botClassification"::text, 'UNKNOWN') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}

// ---------------------------------------------------------------------------
// Conversion analytics (Phase 7) — see
// docs/architecture/conversion-tracking.md#analytics for full definitions.
// ---------------------------------------------------------------------------

function buildConversionWhere(filters: AnalyticsFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`cv."organizationId" = ${filters.organizationId}`,
    Prisma.sql`cv."occurredAt" >= ${filters.from}`,
    Prisma.sql`cv."occurredAt" < ${filters.to}`,
  ];
  if (filters.campaignId) {
    conditions.push(Prisma.sql`cv."campaignId" = ${filters.campaignId}`);
  }
  if (filters.trackingLinkId) {
    conditions.push(Prisma.sql`cv."trackingLinkId" = ${filters.trackingLinkId}`);
  }
  if (filters.trackingDomainId) {
    conditions.push(
      Prisma.sql`cv."trackingLinkId" IN (SELECT id FROM tracking_links WHERE "trackingDomainId" = ${filters.trackingDomainId})`,
    );
  }
  if (filters.affiliatePartnerId) {
    // Conversion carries no affiliatePartnerId column of its own (Phase 9
    // deliberately avoids duplicating attribution data there — see
    // docs/architecture/affiliate-partners.md#conversion-attribution);
    // partner scoping is derived by joining through the click each
    // conversion references, same subquery style as trackingDomainId above.
    conditions.push(
      Prisma.sql`cv."clickId" IN (SELECT id FROM clicks WHERE "affiliatePartnerId" = ${filters.affiliatePartnerId})`,
    );
  }
  // Phase 10: country/deviceType/browser/os/botClassification are Click-only
  // columns (see AnalyticsFilters above) — matched the same way
  // affiliatePartnerId already is, by joining through the click each
  // conversion references.
  if (filters.country) {
    conditions.push(
      Prisma.sql`cv."clickId" IN (SELECT id FROM clicks WHERE country = ${filters.country})`,
    );
  }
  if (filters.deviceType) {
    conditions.push(
      Prisma.sql`cv."clickId" IN (SELECT id FROM clicks WHERE "deviceType" = ${filters.deviceType}::"DeviceType")`,
    );
  }
  if (filters.browser) {
    conditions.push(
      Prisma.sql`cv."clickId" IN (SELECT id FROM clicks WHERE browser = ${filters.browser})`,
    );
  }
  if (filters.os) {
    conditions.push(Prisma.sql`cv."clickId" IN (SELECT id FROM clicks WHERE os = ${filters.os})`);
  }
  if (filters.botClassification) {
    conditions.push(
      Prisma.sql`cv."clickId" IN (SELECT id FROM clicks WHERE "botClassification" = ${filters.botClassification}::"BotClassification")`,
    );
  }
  return Prisma.join(conditions, " AND ");
}

export interface ConversionSummary {
  totalConversions: number;
  pendingConversions: number;
  approvedConversions: number;
  rejectedConversions: number;
  reversedConversions: number;
  /** Sum of `value` across every conversion in range, regardless of
   * status — a raw total, not a "trust this number" figure (a PENDING or
   * REJECTED conversion's reported value counts here too). */
  totalConversionValue: number;
  /** Sum of `value` across only APPROVED conversions in range — the
   * figure an advertiser would actually treat as attributed revenue. */
  approvedConversionValue: number;
  /** The clicks-side denominator conversionRate divides into — see its
   * own doc comment for why this is HUMAN clicks, not all clicks. */
  humanClicksInRange: number;
  /**
   * approvedConversions / humanClicksInRange, expressed as a percentage
   * (0-100, not a 0-1 ratio) — same convention as ClickSummary.botPercentage.
   * Denominator is HUMAN clicks specifically, not all clicks and not
   * unique clicks: bot/suspicious traffic can never convert legitimately,
   * so including it would dilute the rate with clicks that were never
   * going to convert, understating real performance. 0 when
   * humanClicksInRange is 0 (never divides by zero).
   *
   * This is a period-over-period ratio, not a cohort conversion rate: both
   * humanClicksInRange and the conversion counts above are independently
   * filtered to the same [from, to) window by their OWN occurredAt, not
   * "clicks in this window that eventually converted, whenever that
   * happened." A click on day 1 whose conversion is approved on day 5
   * contributes to day 1's click count and day 5's conversion count
   * separately — this is a deliberate simplification (see "Do not build a
   * complete attribution engine yet" in
   * docs/architecture/conversion-tracking.md), not a bug.
   */
  conversionRate: number;
  /** Phase 10: Attribution & Advanced Reporting — identical value and
   * formula to `conversionRate` above (approvedConversions /
   * humanClicksInRange), added under the clearer Phase 10 name. The
   * pre-existing `conversionRate` field is kept byte-for-byte unchanged
   * for backward compatibility with Phase 7's own public API — see
   * docs/architecture/attribution-reporting.md#metric-formulas. */
  approvedConversionRate: number;
  /** Phase 10: EPC ("earnings per click") = approvedConversionValue /
   * humanClicksInRange. A currency-per-click figure, not a percentage —
   * unlike the rate fields above, never multiplied by 100. 0 when
   * humanClicksInRange is 0. See "Revenue/value" in
   * docs/architecture/attribution-reporting.md for why this is a raw
   * number with no currency conversion or mixing assumption. */
  epc: number;
}

export async function getConversionSummary(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ConversionSummary> {
  const clicksWhere = buildWhere(filters);
  const conversionsWhere = buildConversionWhere(filters);

  const [clickRows, conversionRows] = await Promise.all([
    prisma.$queryRaw<{ humanClicks: number }[]>(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks"
      FROM clicks c
      WHERE ${clicksWhere}
    `),
    prisma.$queryRaw<
      {
        total: number;
        pending: number;
        approved: number;
        rejected: number;
        reversed: number;
        totalValue: string | null;
        approvedValue: string | null;
      }[]
    >(Prisma.sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE cv.status = 'PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE cv.status = 'APPROVED')::int AS approved,
        COUNT(*) FILTER (WHERE cv.status = 'REJECTED')::int AS rejected,
        COUNT(*) FILTER (WHERE cv.status = 'REVERSED')::int AS reversed,
        COALESCE(SUM(cv.value), 0)::text AS "totalValue",
        COALESCE(SUM(cv.value) FILTER (WHERE cv.status = 'APPROVED'), 0)::text AS "approvedValue"
      FROM conversions cv
      WHERE ${conversionsWhere}
    `),
  ]);

  const humanClicks = clickRows[0]?.humanClicks ?? 0;
  const row = conversionRows[0]!;
  const approvedConversionValue = Number(row.approvedValue ?? 0);
  const approvedRate = humanClicks > 0 ? Math.round((row.approved / humanClicks) * 10000) / 100 : 0;

  return {
    totalConversions: row.total,
    pendingConversions: row.pending,
    approvedConversions: row.approved,
    rejectedConversions: row.rejected,
    reversedConversions: row.reversed,
    totalConversionValue: Number(row.totalValue ?? 0),
    approvedConversionValue,
    humanClicksInRange: humanClicks,
    conversionRate: approvedRate,
    approvedConversionRate: approvedRate,
    epc: humanClicks > 0 ? Math.round((approvedConversionValue / humanClicks) * 100) / 100 : 0,
  };
}

export async function getClicksByCountry(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c.country, 'Unknown') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}

// ---------------------------------------------------------------------------
// Affiliate partner performance (Phase 9) — see
// docs/architecture/affiliate-partners.md#analytics for full definitions.
//
// This is deliberately the ONLY new analytics function Phase 9 adds: rather
// than a getClicksByAffiliatePartner *and* a separate conversions-by-partner
// breakdown (a second and third parallel query pattern), one function
// returns clicks + conversions + conversion rate per partner in a single
// call, reusing buildWhere/buildConversionWhere exactly as
// getConversionSummary already does (two parallel raw queries, joined in
// JS) — see that function's own doc comment for the same shape.
// ---------------------------------------------------------------------------

export interface AffiliatePartnerPerformanceRow {
  affiliatePartnerId: string;
  name: string;
  status: string;
  clicks: number;
  humanClicks: number;
  conversions: number;
  approvedConversions: number;
  /** approvedConversions / humanClicks as a percentage — same convention
   * and same "independently filtered by each row's own occurredAt, not a
   * cohort rate" caveat as ConversionSummary.conversionRate. 0 when
   * humanClicks is 0. */
  conversionRate: number;
  /** Phase 10: identical value to `conversionRate` above, added under the
   * clearer Phase 10 name — see ConversionSummary.approvedConversionRate. */
  approvedConversionRate: number;
  /** Phase 10: sum of `value` across every conversion attributed to this
   * partner, regardless of status — same "raw total, not a trust-this
   * number figure" caveat as ConversionSummary.totalConversionValue. */
  totalConversionValue: number;
  /** Phase 10: sum of `value` across only this partner's APPROVED
   * conversions — the figure this partner would actually be paid against. */
  approvedConversionValue: number;
  /** Phase 10: approvedConversionValue / humanClicks — see
   * ConversionSummary.epc for the same formula and currency caveat. */
  epc: number;
}

export async function getAffiliatePartnerPerformance(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<AffiliatePartnerPerformanceRow[]> {
  const clicksWhere = buildWhere(filters);
  const conversionsWhere = buildConversionWhere(filters);

  const [partners, clickRows, conversionRows] = await Promise.all([
    prisma.affiliatePartner.findMany({
      where: { organizationId: filters.organizationId },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: "desc" },
      take: BREAKDOWN_ROW_LIMIT,
    }),
    prisma.$queryRaw<{ affiliatePartnerId: string; clicks: number; humanClicks: number }[]>(Prisma.sql`
      SELECT
        c."affiliatePartnerId" AS "affiliatePartnerId",
        COUNT(*)::int AS clicks,
        COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks"
      FROM clicks c
      WHERE ${clicksWhere} AND c."affiliatePartnerId" IS NOT NULL
      GROUP BY c."affiliatePartnerId"
    `),
    prisma.$queryRaw<
      {
        affiliatePartnerId: string;
        conversions: number;
        approvedConversions: number;
        totalValue: string | null;
        approvedValue: string | null;
      }[]
    >(Prisma.sql`
      SELECT
        c."affiliatePartnerId" AS "affiliatePartnerId",
        COUNT(*)::int AS conversions,
        COUNT(*) FILTER (WHERE cv.status = 'APPROVED')::int AS "approvedConversions",
        COALESCE(SUM(cv.value), 0)::text AS "totalValue",
        COALESCE(SUM(cv.value) FILTER (WHERE cv.status = 'APPROVED'), 0)::text AS "approvedValue"
      FROM conversions cv
      JOIN clicks c ON c.id = cv."clickId"
      WHERE ${conversionsWhere} AND c."affiliatePartnerId" IS NOT NULL
      GROUP BY c."affiliatePartnerId"
    `),
  ]);

  const clicksByPartner = new Map(clickRows.map((row) => [row.affiliatePartnerId, row]));
  const conversionsByPartner = new Map(conversionRows.map((row) => [row.affiliatePartnerId, row]));

  return partners.map((partner) => {
    const clicks = clicksByPartner.get(partner.id);
    const conversions = conversionsByPartner.get(partner.id);
    const humanClicks = clicks?.humanClicks ?? 0;
    const approvedConversions = conversions?.approvedConversions ?? 0;
    const approvedConversionValue = Number(conversions?.approvedValue ?? 0);
    const approvedRate =
      humanClicks > 0 ? Math.round((approvedConversions / humanClicks) * 10000) / 100 : 0;
    return {
      affiliatePartnerId: partner.id,
      name: partner.name,
      status: partner.status,
      clicks: clicks?.clicks ?? 0,
      humanClicks,
      conversions: conversions?.conversions ?? 0,
      approvedConversions,
      conversionRate: approvedRate,
      approvedConversionRate: approvedRate,
      totalConversionValue: Number(conversions?.totalValue ?? 0),
      approvedConversionValue,
      epc: humanClicks > 0 ? Math.round((approvedConversionValue / humanClicks) * 100) / 100 : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 10: Attribution & Advanced Reporting — see
// docs/architecture/attribution-reporting.md for the full design. Every
// function below reuses buildWhere/buildConversionWhere exactly as the
// Phase 4/7/9 functions above already do; nothing here re-derives
// attribution or re-implements click/conversion filtering from scratch.
// ---------------------------------------------------------------------------

export interface ConversionTimeseriesPoint {
  /** Same local-wall-clock-string convention as
   * ClickTimeseriesPoint.bucket — see that field's doc comment for why
   * this intentionally carries no "Z"/UTC marker. A conversion's bucket is
   * derived from its OWN occurredAt, independent of its click's
   * occurredAt — see ConversionSummary's own "not a cohort rate" caveat,
   * which applies here identically. */
  bucket: string;
  conversions: number;
  approvedConversions: number;
  totalConversionValue: number;
  approvedConversionValue: number;
}

/**
 * The conversion-side counterpart to getClickTimeseries, added so
 * GET .../reports/timeseries can show conversions alongside clicks in one
 * chart without either query needing to know about the other — the route
 * handler merges both by bucket key (a plain JS Map, the same
 * merge-by-key shape getAffiliatePartnerPerformance already uses for
 * clicks+conversions). Uses the identical AT TIME ZONE double-conversion
 * getClickTimeseries verified against real Postgres, applied to
 * `cv."occurredAt"` instead of `c."occurredAt"`.
 */
export async function getConversionTimeseries(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
  bucket: TimeseriesBucket,
  timezone: string,
): Promise<ConversionTimeseriesPoint[]> {
  const where = buildConversionWhere(filters);
  const rows = await prisma.$queryRaw<
    {
      bucketStart: Date;
      conversions: number;
      approvedConversions: number;
      totalValue: string | null;
      approvedValue: string | null;
    }[]
  >(Prisma.sql`
    SELECT
      date_trunc(${bucket}, cv."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}) AS "bucketStart",
      COUNT(*)::int AS conversions,
      COUNT(*) FILTER (WHERE cv.status = 'APPROVED')::int AS "approvedConversions",
      COALESCE(SUM(cv.value), 0)::text AS "totalValue",
      COALESCE(SUM(cv.value) FILTER (WHERE cv.status = 'APPROVED'), 0)::text AS "approvedValue"
    FROM conversions cv
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `);

  return rows.map((row) => ({
    bucket: row.bucketStart.toISOString().slice(0, 19),
    conversions: row.conversions,
    approvedConversions: row.approvedConversions,
    totalConversionValue: Number(row.totalValue ?? 0),
    approvedConversionValue: Number(row.approvedValue ?? 0),
  }));
}

export interface CampaignPerformanceRow {
  campaignId: string;
  name: string;
  status: string;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  uniqueClicksInRange: number;
  conversions: number;
  approvedConversions: number;
  totalConversionValue: number;
  approvedConversionValue: number;
  conversionRate: number;
  approvedConversionRate: number;
  epc: number;
}

/**
 * Per-campaign performance table (GET .../reports/campaigns). Same
 * two-parallel-queries-plus-JS-merge shape as
 * getAffiliatePartnerPerformance, simpler in one respect: Conversion
 * already carries its own `campaignId` column (Phase 7), so the
 * conversion-side query groups directly on `cv."campaignId"` with no join
 * through `clicks` needed (unlike affiliatePartnerId, which Conversion
 * deliberately does not duplicate).
 */
export async function getCampaignPerformance(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<CampaignPerformanceRow[]> {
  const clicksWhere = buildWhere(filters);
  const conversionsWhere = buildConversionWhere(filters);

  const [campaigns, clickRows, conversionRows] = await Promise.all([
    prisma.campaign.findMany({
      where: {
        organizationId: filters.organizationId,
        ...(filters.campaignId ? { id: filters.campaignId } : {}),
      },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: "desc" },
      take: BREAKDOWN_ROW_LIMIT,
    }),
    prisma.$queryRaw<
      { campaignId: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicksInRange: number }[]
    >(Prisma.sql`
      SELECT
        c."campaignId" AS "campaignId",
        COUNT(*)::int AS clicks,
        COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
        COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
        COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
      FROM clicks c
      WHERE ${clicksWhere}
      GROUP BY c."campaignId"
    `),
    prisma.$queryRaw<
      {
        campaignId: string;
        conversions: number;
        approvedConversions: number;
        totalValue: string | null;
        approvedValue: string | null;
      }[]
    >(Prisma.sql`
      SELECT
        cv."campaignId" AS "campaignId",
        COUNT(*)::int AS conversions,
        COUNT(*) FILTER (WHERE cv.status = 'APPROVED')::int AS "approvedConversions",
        COALESCE(SUM(cv.value), 0)::text AS "totalValue",
        COALESCE(SUM(cv.value) FILTER (WHERE cv.status = 'APPROVED'), 0)::text AS "approvedValue"
      FROM conversions cv
      WHERE ${conversionsWhere}
      GROUP BY cv."campaignId"
    `),
  ]);

  const clicksByCampaign = new Map(clickRows.map((row) => [row.campaignId, row]));
  const conversionsByCampaign = new Map(conversionRows.map((row) => [row.campaignId, row]));

  return campaigns.map((campaign) => {
    const clicks = clicksByCampaign.get(campaign.id);
    const conversions = conversionsByCampaign.get(campaign.id);
    const humanClicks = clicks?.humanClicks ?? 0;
    const approvedConversions = conversions?.approvedConversions ?? 0;
    const approvedConversionValue = Number(conversions?.approvedValue ?? 0);
    const approvedRate =
      humanClicks > 0 ? Math.round((approvedConversions / humanClicks) * 10000) / 100 : 0;
    return {
      campaignId: campaign.id,
      name: campaign.name,
      status: campaign.status,
      clicks: clicks?.clicks ?? 0,
      humanClicks,
      botClicks: clicks?.botClicks ?? 0,
      uniqueClicksInRange: clicks?.uniqueClicksInRange ?? 0,
      conversions: conversions?.conversions ?? 0,
      approvedConversions,
      totalConversionValue: Number(conversions?.totalValue ?? 0),
      approvedConversionValue,
      conversionRate: approvedRate,
      approvedConversionRate: approvedRate,
      epc: humanClicks > 0 ? Math.round((approvedConversionValue / humanClicks) * 100) / 100 : 0,
    };
  });
}

export interface TrackingLinkPerformanceRow {
  trackingLinkId: string;
  slug: string;
  campaignId: string;
  affiliatePartnerId: string | null;
  status: string;
  clicks: number;
  humanClicks: number;
  uniqueClicksInRange: number;
  conversions: number;
  approvedConversions: number;
  totalConversionValue: number;
  approvedConversionValue: number;
  conversionRate: number;
  approvedConversionRate: number;
  epc: number;
}

/**
 * Per-tracking-link performance table (GET .../reports/tracking-links).
 * Same shape as getCampaignPerformance; Conversion already carries its own
 * `trackingLinkId` column (Phase 7), so — like the campaign case — no join
 * through `clicks` is needed for the conversion-side query.
 */
export async function getTrackingLinkPerformance(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<TrackingLinkPerformanceRow[]> {
  const clicksWhere = buildWhere(filters);
  const conversionsWhere = buildConversionWhere(filters);

  const [links, clickRows, conversionRows] = await Promise.all([
    prisma.trackingLink.findMany({
      where: {
        campaign: { organizationId: filters.organizationId },
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(filters.trackingLinkId ? { id: filters.trackingLinkId } : {}),
        ...(filters.affiliatePartnerId ? { affiliatePartnerId: filters.affiliatePartnerId } : {}),
      },
      select: { id: true, slug: true, campaignId: true, affiliatePartnerId: true, status: true },
      orderBy: { createdAt: "desc" },
      take: BREAKDOWN_ROW_LIMIT,
    }),
    prisma.$queryRaw<
      { trackingLinkId: string; clicks: number; humanClicks: number; uniqueClicksInRange: number }[]
    >(Prisma.sql`
      SELECT
        c."trackingLinkId" AS "trackingLinkId",
        COUNT(*)::int AS clicks,
        COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
        COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
      FROM clicks c
      WHERE ${clicksWhere}
      GROUP BY c."trackingLinkId"
    `),
    prisma.$queryRaw<
      {
        trackingLinkId: string;
        conversions: number;
        approvedConversions: number;
        totalValue: string | null;
        approvedValue: string | null;
      }[]
    >(Prisma.sql`
      SELECT
        cv."trackingLinkId" AS "trackingLinkId",
        COUNT(*)::int AS conversions,
        COUNT(*) FILTER (WHERE cv.status = 'APPROVED')::int AS "approvedConversions",
        COALESCE(SUM(cv.value), 0)::text AS "totalValue",
        COALESCE(SUM(cv.value) FILTER (WHERE cv.status = 'APPROVED'), 0)::text AS "approvedValue"
      FROM conversions cv
      WHERE ${conversionsWhere}
      GROUP BY cv."trackingLinkId"
    `),
  ]);

  const clicksByLink = new Map(clickRows.map((row) => [row.trackingLinkId, row]));
  const conversionsByLink = new Map(conversionRows.map((row) => [row.trackingLinkId, row]));

  return links.map((link) => {
    const clicks = clicksByLink.get(link.id);
    const conversions = conversionsByLink.get(link.id);
    const humanClicks = clicks?.humanClicks ?? 0;
    const approvedConversions = conversions?.approvedConversions ?? 0;
    const approvedConversionValue = Number(conversions?.approvedValue ?? 0);
    const approvedRate =
      humanClicks > 0 ? Math.round((approvedConversions / humanClicks) * 10000) / 100 : 0;
    return {
      trackingLinkId: link.id,
      slug: link.slug,
      campaignId: link.campaignId,
      affiliatePartnerId: link.affiliatePartnerId,
      status: link.status,
      clicks: clicks?.clicks ?? 0,
      humanClicks,
      uniqueClicksInRange: clicks?.uniqueClicksInRange ?? 0,
      conversions: conversions?.conversions ?? 0,
      approvedConversions,
      totalConversionValue: Number(conversions?.totalValue ?? 0),
      approvedConversionValue,
      conversionRate: approvedRate,
      approvedConversionRate: approvedRate,
      epc: humanClicks > 0 ? Math.round((approvedConversionValue / humanClicks) * 100) / 100 : 0,
    };
  });
}

export interface DimensionBreakdownRow {
  key: string;
  clicks: number;
  humanClicks: number;
  uniqueClicksInRange: number;
  conversions: number;
  approvedConversions: number;
  conversionRate: number;
}

/** Whitelisted column reference per dimension — never string-interpolate
 * the caller-supplied `dimension` value directly into SQL. Each fragment
 * is a `Prisma.Sql` value produced by the same `Prisma.sql` tag every
 * other query in this file already uses, so composing it into a larger
 * query is exactly as safe as any other `buildWhere`-style fragment. */
const DIMENSION_COLUMNS: Record<ReportDimension, Prisma.Sql> = {
  country: Prisma.sql`COALESCE(c.country, 'Unknown')`,
  deviceType: Prisma.sql`COALESCE(c."deviceType"::text, 'UNKNOWN')`,
  browser: Prisma.sql`COALESCE(c.browser, 'Unknown')`,
  os: Prisma.sql`COALESCE(c.os, 'Unknown')`,
  botClassification: Prisma.sql`COALESCE(c."botClassification"::text, 'UNKNOWN')`,
};

/**
 * GET .../reports/dimensions — one parameterized function instead of five
 * near-identical getXByDimension functions (Country/Device/Browser/Os
 * already exist as their own stable Phase 4 exports; this is the
 * dimension-plus-conversions superset the reporting layer needs, and the
 * only place a botClassification breakdown exists at all — see
 * getClicksByBotClassification above for the click-only equivalent, kept
 * separate because it needs no conversion join).
 *
 * Only the five dimensions actually present on `Click`
 * (country/deviceType/browser/os/botClassification) are ever accepted —
 * `dimension` is validated against `reportDimensionSchema`
 * (packages/validation/src/analytics.ts) before this function is ever
 * called, and `DIMENSION_COLUMNS` above is a closed lookup, so there is no
 * code path where an arbitrary column name reaches raw SQL.
 */
export async function getDimensionBreakdown(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
  dimension: ReportDimension,
): Promise<DimensionBreakdownRow[]> {
  const column = DIMENSION_COLUMNS[dimension];
  const clicksWhere = buildWhere(filters);
  const conversionsWhere = buildConversionWhere(filters);

  const [clickRows, conversionRows] = await Promise.all([
    prisma.$queryRaw<{ key: string; clicks: number; humanClicks: number; uniqueClicksInRange: number }[]>(
      Prisma.sql`
        SELECT
          ${column} AS key,
          COUNT(*)::int AS clicks,
          COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
          COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicksInRange"
        FROM clicks c
        WHERE ${clicksWhere}
        GROUP BY 1
        ORDER BY clicks DESC
        LIMIT ${BREAKDOWN_ROW_LIMIT}
      `,
    ),
    prisma.$queryRaw<{ key: string; conversions: number; approvedConversions: number }[]>(Prisma.sql`
      SELECT
        ${column} AS key,
        COUNT(*)::int AS conversions,
        COUNT(*) FILTER (WHERE cv.status = 'APPROVED')::int AS "approvedConversions"
      FROM conversions cv
      JOIN clicks c ON c.id = cv."clickId"
      WHERE ${conversionsWhere}
      GROUP BY 1
    `),
  ]);

  const conversionsByKey = new Map(conversionRows.map((row) => [row.key, row]));

  return clickRows.map((row) => {
    const conversions = conversionsByKey.get(row.key);
    const approvedConversions = conversions?.approvedConversions ?? 0;
    return {
      key: row.key,
      clicks: row.clicks,
      humanClicks: row.humanClicks,
      uniqueClicksInRange: row.uniqueClicksInRange,
      conversions: conversions?.conversions ?? 0,
      approvedConversions,
      conversionRate:
        row.humanClicks > 0 ? Math.round((approvedConversions / row.humanClicks) * 10000) / 100 : 0,
    };
  });
}
