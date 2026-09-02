"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { Campaign, Conversion, ConversionStatus, ConversionSummary, TrackingLink } from "@/lib/types";

const STATUS_STYLES: Record<ConversionStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-green-50 text-green-700",
  REJECTED: "bg-red-50 text-red-700",
  REVERSED: "bg-slate-100 text-slate-500",
};

/** Mirrors packages/shared/src/conversion-lifecycle.ts — which status
 * actions are legal from a given status. Display-only: the backend
 * re-validates every transition regardless of what buttons are shown. */
const AVAILABLE_ACTIONS: Record<ConversionStatus, Array<"approve" | "reject" | "reverse">> = {
  PENDING: ["approve", "reject"],
  APPROVED: ["reverse"],
  REJECTED: [],
  REVERSED: [],
};

const ACTION_LABELS: Record<"approve" | "reject" | "reverse", string> = {
  approve: "Approve",
  reject: "Reject",
  reverse: "Reverse",
};

export default function ConversionsPage() {
  const { activeOrganizationId, memberships } = useAuth();
  const currentRole = useMemo(
    () => memberships.find((m) => m.organization.id === activeOrganizationId)?.role ?? null,
    [memberships, activeOrganizationId],
  );
  const canRunStatusActions = currentRole === "OWNER" || currentRole === "ADMIN";

  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [summary, setSummary] = useState<ConversionSummary | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [trackingLinks, setTrackingLinks] = useState<TrackingLink[]>([]);
  const [statusFilter, setStatusFilter] = useState<ConversionStatus | "">("");

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load(organizationId: string, status: ConversionStatus | "") {
    const query = status ? `?status=${status}` : "";
    const [conversionsRes, summaryRes, campaignsRes, linksRes] = await Promise.all([
      apiFetch<{ conversions: Conversion[] }>(
        `/api/v1/organizations/${organizationId}/conversions${query}`,
      ),
      apiFetch<{ summary: ConversionSummary }>(
        `/api/v1/organizations/${organizationId}/analytics/conversions/summary`,
      ),
      apiFetch<{ campaigns: Campaign[] }>(`/api/v1/organizations/${organizationId}/campaigns`),
      apiFetch<{ trackingLinks: TrackingLink[] }>(
        `/api/v1/organizations/${organizationId}/tracking-links`,
      ),
    ]);
    setConversions(conversionsRes.conversions);
    setSummary(summaryRes.summary);
    setCampaigns(campaignsRes.campaigns);
    setTrackingLinks(linksRes.trackingLinks);
  }

  useEffect(() => {
    if (activeOrganizationId) void load(activeOrganizationId, statusFilter);
  }, [activeOrganizationId, statusFilter]);

  async function handleAction(conversionId: string, action: "approve" | "reject" | "reverse") {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingActionId(conversionId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/conversions/${conversionId}/${action}`,
        { method: "POST" },
      );
      await load(activeOrganizationId, statusFilter);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : `Failed to ${action} conversion`);
    } finally {
      setPendingActionId(null);
    }
  }

  function campaignName(id: string) {
    return campaigns.find((c) => c.id === id)?.name ?? id;
  }
  function trackingLinkSlug(id: string) {
    return trackingLinks.find((l) => l.id === id)?.slug ?? id;
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Conversions</h1>
          <p className="mt-1 text-sm text-slate-500">
            A conversion is always attributed through the click it reports against — campaign and
            tracking link are derived from that click, never client-supplied. See
            docs/architecture/conversion-tracking.md.
          </p>
        </div>

        {summary && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: "Pending", value: summary.pendingConversions },
              { label: "Approved", value: summary.approvedConversions },
              { label: "Approved value", value: summary.approvedConversionValue.toFixed(2) },
              { label: "Conversion rate", value: `${summary.conversionRate}%` },
            ].map((stat) => (
              <div key={stat.label} className="card p-4">
                <p className="text-xs text-slate-500">{stat.label}</p>
                <p className="mt-1 text-lg font-semibold text-slate-800">{stat.value}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <label className="label" htmlFor="statusFilter">
            Status
          </label>
          <select
            id="statusFilter"
            className="input w-48"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ConversionStatus | "")}
          >
            <option value="">All</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="REVERSED">Reversed</option>
          </select>
        </div>

        {actionError && <p className="text-sm text-red-600">{actionError}</p>}

        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Event</th>
                <th className="px-4 py-2 font-medium">Campaign</th>
                <th className="px-4 py-2 font-medium">Tracking link</th>
                <th className="px-4 py-2 font-medium">Click</th>
                <th className="px-4 py-2 font-medium">Value</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Occurred</th>
                {canRunStatusActions && <th className="px-4 py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {conversions.map((conversion) => (
                <tr key={conversion.id}>
                  <td className="px-4 py-3 font-medium text-slate-800">{conversion.eventName}</td>
                  <td className="px-4 py-3 text-slate-600">{campaignName(conversion.campaignId)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {trackingLinkSlug(conversion.trackingLinkId)}
                  </td>
                  <td className="px-4 py-3 truncate font-mono text-xs text-slate-400" title={conversion.clickId}>
                    {conversion.clickId.slice(0, 8)}&hellip;
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {conversion.value ? `${conversion.value} ${conversion.currency}` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${STATUS_STYLES[conversion.status]}`}>
                      {conversion.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(conversion.occurredAt).toLocaleString()}
                  </td>
                  {canRunStatusActions && (
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {AVAILABLE_ACTIONS[conversion.status].map((action) => (
                          <button
                            key={action}
                            type="button"
                            className={action === "reject" ? "btn-secondary" : "btn-primary"}
                            disabled={pendingActionId === conversion.id}
                            onClick={() => handleAction(conversion.id, action)}
                          >
                            {ACTION_LABELS[action]}
                          </button>
                        ))}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {conversions.length === 0 && (
                <tr>
                  <td
                    className="px-4 py-6 text-center text-slate-500"
                    colSpan={canRunStatusActions ? 8 : 7}
                  >
                    No conversions yet.
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
