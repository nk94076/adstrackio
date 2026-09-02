"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ClickTrendChart } from "@/components/click-trend-chart";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type {
  Campaign,
  ClickBreakdownRow,
  ClickSummary,
  ClickTimeseriesPoint,
  TimeseriesBucket,
  TrackingDomain,
  TrackingLink,
} from "@/lib/types";

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

interface AnalyticsFilters {
  from: string;
  to: string;
  campaignId: string;
  trackingLinkId: string;
  trackingDomainId: string;
  bucket: TimeseriesBucket;
}

interface Breakdowns {
  byCampaign: ClickBreakdownRow[];
  byLink: ClickBreakdownRow[];
  byDomain: ClickBreakdownRow[];
  byReferrer: ClickBreakdownRow[];
  byDevice: ClickBreakdownRow[];
  byBrowser: ClickBreakdownRow[];
  byOs: ClickBreakdownRow[];
  byCountry: ClickBreakdownRow[];
}

const EMPTY_BREAKDOWNS: Breakdowns = {
  byCampaign: [],
  byLink: [],
  byDomain: [],
  byReferrer: [],
  byDevice: [],
  byBrowser: [],
  byOs: [],
  byCountry: [],
};

const EMPTY_SUMMARY: ClickSummary = {
  totalClicks: 0,
  humanClicks: 0,
  botClicks: 0,
  suspiciousClicks: 0,
  unknownClicks: 0,
  uniqueClicks: 0,
  botPercentage: 0,
};

function buildQuery(filters: AnalyticsFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (filters.trackingLinkId) params.set("trackingLinkId", filters.trackingLinkId);
  if (filters.trackingDomainId) params.set("trackingDomainId", filters.trackingDomainId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function BreakdownTable({ title, rows }: { title: string; rows: ClickBreakdownRow[] }) {
  const total = Math.max(
    1,
    rows.reduce((sum, row) => sum + row.clicks, 0),
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Clicks</th>
            <th className="px-4 py-2 font-medium">Human</th>
            <th className="px-4 py-2 font-medium">Bot</th>
            <th className="px-4 py-2 font-medium">Unique</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.slice(0, 10).map((row) => (
            <tr key={row.key}>
              <td className="px-4 py-2 text-slate-800">
                <div className="flex items-center gap-2">
                  <span className="truncate">{row.label}</span>
                  <span className="text-xs text-slate-400">
                    {Math.round((row.clicks / total) * 100)}%
                  </span>
                </div>
              </td>
              <td className="px-4 py-2 text-slate-600">{row.clicks}</td>
              <td className="px-4 py-2 text-slate-600">{row.humanClicks}</td>
              <td className="px-4 py-2 text-slate-600">{row.botClicks}</td>
              <td className="px-4 py-2 text-slate-600">{row.uniqueClicks}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="px-4 py-6 text-center text-slate-500" colSpan={5}>
                No data in this range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function AnalyticsPage() {
  const { activeOrganizationId } = useAuth();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [domains, setDomains] = useState<TrackingDomain[]>([]);
  const [trackingLinks, setTrackingLinks] = useState<TrackingLink[]>([]);

  const [filters, setFilters] = useState<AnalyticsFilters>({
    from: isoDaysAgo(7),
    to: isoDaysAgo(0),
    campaignId: "",
    trackingLinkId: "",
    trackingDomainId: "",
    bucket: "day",
  });

  const [summary, setSummary] = useState<ClickSummary>(EMPTY_SUMMARY);
  const [points, setPoints] = useState<ClickTimeseriesPoint[]>([]);
  const [breakdowns, setBreakdowns] = useState<Breakdowns>(EMPTY_BREAKDOWNS);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeOrganizationId) return;
    Promise.all([
      apiFetch<{ campaigns: Campaign[] }>(
        `/api/v1/organizations/${activeOrganizationId}/campaigns`,
      ),
      apiFetch<{ domains: TrackingDomain[] }>(
        `/api/v1/organizations/${activeOrganizationId}/domains`,
      ),
      apiFetch<{ trackingLinks: TrackingLink[] }>(
        `/api/v1/organizations/${activeOrganizationId}/tracking-links`,
      ),
    ]).then(([campaignsRes, domainsRes, linksRes]) => {
      setCampaigns(campaignsRes.campaigns);
      setDomains(domainsRes.domains);
      setTrackingLinks(linksRes.trackingLinks);
    });
  }, [activeOrganizationId]);

  useEffect(() => {
    if (!activeOrganizationId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const summaryQuery = buildQuery(filters);
    const timeseriesQuery = buildQuery(filters, { bucket: filters.bucket });
    const base = `/api/v1/organizations/${activeOrganizationId}/analytics/clicks`;

    Promise.all([
      apiFetch<{ summary: ClickSummary }>(`${base}/summary${summaryQuery}`),
      apiFetch<{ points: ClickTimeseriesPoint[] }>(`${base}/timeseries${timeseriesQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-campaign${summaryQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-link${summaryQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-domain${summaryQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-referrer${summaryQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-device${summaryQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-browser${summaryQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-os${summaryQuery}`),
      apiFetch<{ rows: ClickBreakdownRow[] }>(`${base}/by-country${summaryQuery}`),
    ])
      .then(
        ([
          summaryRes,
          timeseriesRes,
          byCampaign,
          byLink,
          byDomain,
          byReferrer,
          byDevice,
          byBrowser,
          byOs,
          byCountry,
        ]) => {
          if (cancelled) return;
          setSummary(summaryRes.summary);
          setPoints(timeseriesRes.points);
          setBreakdowns({
            byCampaign: byCampaign.rows,
            byLink: byLink.rows,
            byDomain: byDomain.rows,
            byReferrer: byReferrer.rows,
            byDevice: byDevice.rows,
            byBrowser: byBrowser.rows,
            byOs: byOs.rows,
            byCountry: byCountry.rows,
          });
        },
      )
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiClientError ? err.message : "Failed to load analytics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrganizationId, filters]);

  const linksForDomain = useMemo(
    () =>
      filters.trackingDomainId
        ? trackingLinks.filter((link) => link.trackingDomainId === filters.trackingDomainId)
        : trackingLinks,
    [trackingLinks, filters.trackingDomainId],
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Click Analytics</h1>
          <p className="mt-1 text-sm text-slate-500">
            Aggregate click activity for this organization. &ldquo;Unique clicks&rdquo; is an
            organization-scoped estimate based on a privacy-safe hash of IP and user agent within
            the selected range — not a guarantee of distinct visitors. See
            docs/architecture/click-analytics.md for the full methodology.
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
                onChange={(e) =>
                  setFilters((f) => ({ ...f, bucket: e.target.value as TimeseriesBucket }))
                }
              >
                <option value="hour">Hour</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
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
              <label className="label" htmlFor="trackingDomainId">
                Domain
              </label>
              <select
                id="trackingDomainId"
                className="input"
                value={filters.trackingDomainId}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, trackingDomainId: e.target.value, trackingLinkId: "" }))
                }
              >
                <option value="">All domains</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname}
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
                {linksForDomain.map((link) => (
                  <option key={link.id} value={link.id}>
                    {link.slug}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Total Clicks
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.totalClicks}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Unique Clicks
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.uniqueClicks}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Human Clicks
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.humanClicks}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Bot Clicks
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {summary.botClicks}
              <span className="ml-2 text-sm font-normal text-slate-500">
                ({summary.botPercentage}%)
              </span>
            </p>
          </div>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-semibold text-slate-800">Clicks over time</h2>
          {loading ? (
            <p className="py-12 text-center text-sm text-slate-500">Loading…</p>
          ) : (
            <ClickTrendChart points={points} />
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BreakdownTable title="By campaign" rows={breakdowns.byCampaign} />
          <BreakdownTable title="By tracking link" rows={breakdowns.byLink} />
          <BreakdownTable title="By domain" rows={breakdowns.byDomain} />
          <BreakdownTable title="By referrer" rows={breakdowns.byReferrer} />
          <BreakdownTable title="By device" rows={breakdowns.byDevice} />
          <BreakdownTable title="By browser" rows={breakdowns.byBrowser} />
          <BreakdownTable title="By OS" rows={breakdowns.byOs} />
          <BreakdownTable title="By country" rows={breakdowns.byCountry} />
        </div>
      </div>
    </AppShell>
  );
}
