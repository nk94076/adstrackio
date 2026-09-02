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
 * human/bot/unique breakdown alongside a raw click count. */
const CLASSIFICATION_AGGREGATES = Prisma.sql`
  COUNT(*)::int AS clicks,
  COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
  COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
  COUNT(*) FILTER (WHERE c."botClassification" = 'SUSPICIOUS')::int AS "suspiciousClicks",
  COUNT(*) FILTER (WHERE c."botClassification" = 'UNKNOWN' OR c."botClassification" IS NULL)::int AS "unknownClicks",
  COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
`;

export interface ClickSummary {
  totalClicks: number;
  humanClicks: number;
  botClicks: number;
  suspiciousClicks: number;
  unknownClicks: number;
  uniqueClicks: number;
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
      uniqueClicks: number;
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
    uniqueClicks: row.uniqueClicks,
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
  uniqueClicks: number;
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
    { bucketStart: Date; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      date_trunc(${bucket}, c."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}) AS "bucketStart",
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
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
    uniqueClicks: row.uniqueClicks,
  }));
}

export interface ClickBreakdownRow {
  key: string;
  label: string;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  uniqueClicks: number;
}

export async function getClicksByCampaign(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; label: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      c."campaignId" AS key,
      camp.name AS label,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
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
    { key: string; label: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      c."trackingLinkId" AS key,
      tl.slug AS label,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
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
    { key: string; label: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      td.id AS key,
      td.hostname AS label,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
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
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
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
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
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
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c."deviceType"::text, 'UNKNOWN') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
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
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c.browser, 'Unknown') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
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
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c.os, 'Unknown') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}

export async function getClicksByCountry(
  prisma: PrismaClient,
  filters: AnalyticsFilters,
): Promise<ClickBreakdownRow[]> {
  const where = buildWhere(filters);
  const rows = await prisma.$queryRaw<
    { key: string; clicks: number; humanClicks: number; botClicks: number; uniqueClicks: number }[]
  >(Prisma.sql`
    SELECT
      COALESCE(c.country, 'Unknown') AS key,
      COUNT(*)::int AS clicks,
      COUNT(*) FILTER (WHERE c."botClassification" = 'HUMAN')::int AS "humanClicks",
      COUNT(*) FILTER (WHERE c."botClassification" = 'BOT')::int AS "botClicks",
      COUNT(DISTINCT (c."ipHash", c."userAgent"))::int AS "uniqueClicks"
    FROM clicks c
    WHERE ${where}
    GROUP BY 1
    ORDER BY clicks DESC
    LIMIT ${BREAKDOWN_ROW_LIMIT}
  `);
  return rows.map((row) => ({ ...row, label: row.key }));
}
