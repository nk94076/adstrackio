"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ReportTrendChart } from "@/components/report-trend-chart";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type {
  AffiliatePartner,
  AffiliatePartnerPerformanceRow,
  Campaign,
  CampaignPerformanceRow,
  DimensionBreakdownRow,
  ReportDimension,
  ReportOverview,
  ReportTimeseriesPoint,
  TimeseriesBucket,
  TrackingLink,
  TrackingLinkPerformanceRow,
} from "@/lib/types";

/**
 * Phase 10: Attribution & Advanced Reporting — see
 * docs/architecture/attribution-reporting.md. Every number on this page
 * comes from apps/api's /reports/* endpoints (plus the pre-existing
 * /analytics/affiliate-partners/performance endpoint for the partner
 * table, kept as the one place that data is served rather than
 * duplicated under /reports/ too — see reports.routes.ts's own doc
 * comment). Deliberately not a BI system: one overview, one trend chart,
 * three performance tables, and one dimension breakdown selector.
 */

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

interface ReportFilters {
  from: string;
  to: string;
  bucket: TimeseriesBucket;
  campaignId: string;
  trackingLinkId: string;
  affiliatePartnerId: string;
  dimension: ReportDimension;
}

const EMPTY_OVERVIEW: ReportOverview = {
  clicks: {
    totalClicks: 0,
    humanClicks: 0,
    botClicks: 0,
    suspiciousClicks: 0,
    unknownClicks: 0,
    uniqueClicksInRange: 0,
    botPercentage: 0,
  },
  conversions: {
    totalConversions: 0,
    pendingConversions: 0,
    approvedConversions: 0,
    rejectedConversions: 0,
    reversedConversions: 0,
    totalConversionValue: 0,
    approvedConversionValue: 0,
    humanClicksInRange: 0,
    conversionRate: 0,
    approvedConversionRate: 0,
    epc: 0,
  },
};

function buildQuery(filters: ReportFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (filters.trackingLinkId) params.set("trackingLinkId", filters.trackingLinkId);
  if (filters.affiliatePartnerId) params.set("affiliatePartnerId", filters.affiliatePartnerId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function StatTile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">
        {value}
        {sub && <span className="ml-2 text-sm font-normal text-slate-500">{sub}</span>}
      </p>
    </div>
  );
}

const DIMENSION_LABELS: Record<ReportDimension, string> = {
  country: "Country",
  deviceType: "Device",
  browser: "Browser",
  os: "OS",
  botClassification: "Bot classification",
};

export default function ReportsPage() {
  const { activeOrganizationId } = useAuth();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [trackingLinks, setTrackingLinks] = useState<TrackingLink[]>([]);
  const [affiliatePartners, setAffiliatePartners] = useState<AffiliatePartner[]>([]);

  const [filters, setFilters] = useState<ReportFilters>({
    from: isoDaysAgo(7),
    to: isoDaysAgo(0),
    bucket: "day",
    campaignId: "",
    trackingLinkId: "",
    affiliatePartnerId: "",
    dimension: "country",
  });

  const [overview, setOverview] = useState<ReportOverview>(EMPTY_OVERVIEW);
  const [points, setPoints] = useState<ReportTimeseriesPoint[]>([]);
  const [campaignRows, setCampaignRows] = useState<CampaignPerformanceRow[]>([]);
  const [linkRows, setLinkRows] = useState<TrackingLinkPerformanceRow[]>([]);
  const [partnerRows, setPartnerRows] = useState<AffiliatePartnerPerformanceRow[]>([]);
  const [dimensionRows, setDimensionRows] = useState<DimensionBreakdownRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeOrganizationId) return;
    Promise.all([
      apiFetch<{ campaigns: Campaign[] }>(`/api/v1/organizations/${activeOrganizationId}/campaigns`),
      apiFetch<{ trackingLinks: TrackingLink[] }>(
        `/api/v1/organizations/${activeOrganizationId}/tracking-links`,
      ),
      apiFetch<{ affiliatePartners: AffiliatePartner[] }>(
        `/api/v1/organizations/${activeOrganizationId}/affiliate-partners`,
      ),
    ]).then(([campaignsRes, linksRes, partnersRes]) => {
      setCampaigns(campaignsRes.campaigns);
      setTrackingLinks(linksRes.trackingLinks);
      setAffiliatePartners(partnersRes.affiliatePartners);
    });
  }, [activeOrganizationId]);

  useEffect(() => {
    if (!activeOrganizationId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const base = `/api/v1/organizations/${activeOrganizationId}/reports`;
    const query = buildQuery(filters);

    Promise.all([
      apiFetch<ReportOverview>(`${base}/overview${query}`),
      apiFetch<{ points: ReportTimeseriesPoint[] }>(
        `${base}/timeseries${buildQuery(filters, { bucket: filters.bucket })}`,
      ),
      apiFetch<{ rows: CampaignPerformanceRow[] }>(`${base}/campaigns${query}`),
      apiFetch<{ rows: TrackingLinkPerformanceRow[] }>(`${base}/tracking-links${query}`),
      apiFetch<{ rows: AffiliatePartnerPerformanceRow[] }>(
        `/api/v1/organizations/${activeOrganizationId}/analytics/affiliate-partners/performance${query}`,
      ),
      apiFetch<{ rows: DimensionBreakdownRow[] }>(
        `${base}/dimensions${buildQuery(filters, { dimension: filters.dimension })}`,
      ),
    ])
      .then(([overviewRes, timeseriesRes, campaignsRes, linksRes, partnersRes, dimensionsRes]) => {
        if (cancelled) return;
        setOverview(overviewRes);
        setPoints(timeseriesRes.points);
        setCampaignRows(campaignsRes.rows);
        setLinkRows(linksRes.rows);
        setPartnerRows(partnersRes.rows);
        setDimensionRows(dimensionsRes.rows);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiClientError ? err.message : "Failed to load reports");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrganizationId, filters]);

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Reports</h1>
          <p className="mt-1 text-sm text-slate-500">
            Attribution follows Phase 7&apos;s existing rule: every conversion is attributed to the
            Click it references (Conversion.clickId), and that click&apos;s own campaign/tracking-link/
            affiliate-partner columns are authoritative — never a client-supplied value. See
            docs/architecture/attribution-reporting.md for exact metric formulas, the unique-visitor
            definition, and known limitations (single-currency value aggregation, no multi-touch
            attribution).
          </p>
        </div>

        <div className="card p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <label className="label" htmlFor="from">
                From
              </label>
              <input
                id="from"
                type="date"
                className="input"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
              />
            </div>
            <div>
              <label className="label" htmlFor="to">
                To
              </label>
              <input
                id="to"
                type="date"
                className="input"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
              />
            </div>
            <div>
              <label className="label" htmlFor="bucket">
                Trend bucket
              </label>
              <select
                id="bucket"
                className="input"
                value={filters.bucket}
                onChange={(e) => setFilters((f) => ({ ...f, bucket: e.target.value as TimeseriesBucket }))}
              >
                <option value="hour">Hour</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="campaignId">
                Campaign
              </label>
              <select
                id="campaignId"
                className="input"
                value={filters.campaignId}
                onChange={(e) => setFilters((f) => ({ ...f, campaignId: e.target.value }))}
              >
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="trackingLinkId">
                Tracking link
              </label>
              <select
                id="trackingLinkId"
                className="input"
                value={filters.trackingLinkId}
                onChange={(e) => setFilters((f) => ({ ...f, trackingLinkId: e.target.value }))}
              >
                <option value="">All links</option>
                {trackingLinks.map((link) => (
                  <option key={link.id} value={link.id}>
                    {link.slug}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="affiliatePartnerId">
                Affiliate partner
              </label>
              <select
                id="affiliatePartnerId"
                className="input"
                value={filters.affiliatePartnerId}
                onChange={(e) => setFilters((f) => ({ ...f, affiliatePartnerId: e.target.value }))}
              >
                <option value="">All partners</option>
                {affiliatePartners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Total Clicks" value={overview.clicks.totalClicks} />
          <StatTile
            label="Unique Visitors (range)"
            value={overview.clicks.uniqueClicksInRange}
          />
          <StatTile label="Human Clicks" value={overview.clicks.humanClicks} />
          <StatTile
            label="Bot Clicks"
            value={overview.clicks.botClicks}
            sub={`(${overview.clicks.botPercentage}%)`}
          />
          <StatTile label="Conversions" value={overview.conversions.totalConversions} />
          <StatTile label="Approved Conversions" value={overview.conversions.approvedConversions} />
          <StatTile
            label="Approved Conversion Rate"
            value={`${overview.conversions.approvedConversionRate}%`}
          />
          <StatTile label="EPC" value={overview.conversions.epc.toFixed(2)} />
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-800">Clicks &amp; conversions over time</h2>
          {loading ? (
            <p className="py-12 text-center text-sm text-slate-500">Loading…</p>
          ) : (
            <ReportTrendChart points={points} />
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Campaign performance</h2>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Campaign</th>
                <th className="px-4 py-2 font-medium">Clicks</th>
                <th className="px-4 py-2 font-medium">Human</th>
                <th className="px-4 py-2 font-medium">Bot</th>
                <th className="px-4 py-2 font-medium">Approved conv.</th>
                <th className="px-4 py-2 font-medium">Approved rate</th>
                <th className="px-4 py-2 font-medium">Value</th>
                <th className="px-4 py-2 font-medium">EPC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {campaignRows.slice(0, 20).map((row) => (
                <tr key={row.campaignId}>
                  <td className="px-4 py-2 text-slate-800">{row.name}</td>
                  <td className="px-4 py-2 text-slate-600">{row.clicks}</td>
                  <td className="px-4 py-2 text-slate-600">{row.humanClicks}</td>
                  <td className="px-4 py-2 text-slate-600">{row.botClicks}</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversions}</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversionRate}%</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversionValue.toFixed(2)}</td>
                  <td className="px-4 py-2 text-slate-600">{row.epc.toFixed(2)}</td>
                </tr>
              ))}
              {campaignRows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={8}>
                    No campaigns yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Tracking-link performance</h2>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Slug</th>
                <th className="px-4 py-2 font-medium">Clicks</th>
                <th className="px-4 py-2 font-medium">Approved conv.</th>
                <th className="px-4 py-2 font-medium">Approved rate</th>
                <th className="px-4 py-2 font-medium">Value</th>
                <th className="px-4 py-2 font-medium">EPC</th>
                <th className="px-4 py-2 font-medium">Affiliate partner</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {linkRows.slice(0, 20).map((row) => (
                <tr key={row.trackingLinkId}>
                  <td className="px-4 py-2 text-slate-800">{row.slug}</td>
                  <td className="px-4 py-2 text-slate-600">{row.clicks}</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversions}</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversionRate}%</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversionValue.toFixed(2)}</td>
                  <td className="px-4 py-2 text-slate-600">{row.epc.toFixed(2)}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {row.affiliatePartnerId
                      ? (affiliatePartners.find((p) => p.id === row.affiliatePartnerId)?.name ??
                        row.affiliatePartnerId)
                      : "—"}
                  </td>
                </tr>
              ))}
              {linkRows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={7}>
                    No tracking links yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Affiliate-partner performance</h2>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Partner</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Clicks</th>
                <th className="px-4 py-2 font-medium">Approved conv.</th>
                <th className="px-4 py-2 font-medium">Approved rate</th>
                <th className="px-4 py-2 font-medium">Value</th>
                <th className="px-4 py-2 font-medium">EPC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {partnerRows.slice(0, 20).map((row) => (
                <tr key={row.affiliatePartnerId}>
                  <td className="px-4 py-2 text-slate-800">{row.name}</td>
                  <td className="px-4 py-2 text-slate-500">{row.status}</td>
                  <td className="px-4 py-2 text-slate-600">{row.clicks}</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversions}</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversionRate}%</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversionValue.toFixed(2)}</td>
                  <td className="px-4 py-2 text-slate-600">{row.epc.toFixed(2)}</td>
                </tr>
              ))}
              {partnerRows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={7}>
                    No affiliate partners yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Dimension breakdown</h2>
            <select
              className="input w-48"
              value={filters.dimension}
              onChange={(e) => setFilters((f) => ({ ...f, dimension: e.target.value as ReportDimension }))}
            >
              {(Object.keys(DIMENSION_LABELS) as ReportDimension[]).map((dim) => (
                <option key={dim} value={dim}>
                  {DIMENSION_LABELS[dim]}
                </option>
              ))}
            </select>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">{DIMENSION_LABELS[filters.dimension]}</th>
                <th className="px-4 py-2 font-medium">Clicks</th>
                <th className="px-4 py-2 font-medium">Human</th>
                <th className="px-4 py-2 font-medium">Unique (range)</th>
                <th className="px-4 py-2 font-medium">Conversions</th>
                <th className="px-4 py-2 font-medium">Approved</th>
                <th className="px-4 py-2 font-medium">Approved rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {dimensionRows.slice(0, 15).map((row) => (
                <tr key={row.key}>
                  <td className="px-4 py-2 text-slate-800">{row.key}</td>
                  <td className="px-4 py-2 text-slate-600">{row.clicks}</td>
                  <td className="px-4 py-2 text-slate-600">{row.humanClicks}</td>
                  <td className="px-4 py-2 text-slate-600">{row.uniqueClicksInRange}</td>
                  <td className="px-4 py-2 text-slate-600">{row.conversions}</td>
                  <td className="px-4 py-2 text-slate-600">{row.approvedConversions}</td>
                  <td className="px-4 py-2 text-slate-600">{row.conversionRate}%</td>
                </tr>
              ))}
              {dimensionRows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={7}>
                    No data in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
