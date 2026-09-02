import { Prisma, type PrismaClient } from "@adstrackio/database";
import type { TimeseriesBucket } from "@adstrackio/validation";

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

  return {
    totalConversions: row.total,
    pendingConversions: row.pending,
    approvedConversions: row.approved,
    rejectedConversions: row.rejected,
    reversedConversions: row.reversed,
    totalConversionValue: Number(row.totalValue ?? 0),
    approvedConversionValue: Number(row.approvedValue ?? 0),
    humanClicksInRange: humanClicks,
    conversionRate:
      humanClicks > 0 ? Math.round((row.approved / humanClicks) * 10000) / 100 : 0,
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
