"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { Campaign, Destination, TrackingDomain, TrackingLink } from "@/lib/types";

export default function TrackingLinksPage() {
  const { activeOrganizationId } = useAuth();
  const [trackingLinks, setTrackingLinks] = useState<TrackingLink[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [domains, setDomains] = useState<TrackingDomain[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);

  const [campaignId, setCampaignId] = useState("");
  const [trackingDomainId, setTrackingDomainId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function loadAll(organizationId: string) {
    const [linksRes, campaignsRes, domainsRes, destinationsRes] = await Promise.all([
      apiFetch<{ trackingLinks: TrackingLink[] }>(
        `/api/v1/organizations/${organizationId}/tracking-links`,
      ),
      apiFetch<{ campaigns: Campaign[] }>(`/api/v1/organizations/${organizationId}/campaigns`),
      apiFetch<{ domains: TrackingDomain[] }>(`/api/v1/organizations/${organizationId}/domains`),
      apiFetch<{ destinations: Destination[] }>(
        `/api/v1/organizations/${organizationId}/destinations`,
      ),
    ]);
    setTrackingLinks(linksRes.trackingLinks);
    setCampaigns(campaignsRes.campaigns);
    setDomains(domainsRes.domains);
    setDestinations(destinationsRes.destinations);
  }

  useEffect(() => {
    if (activeOrganizationId) void loadAll(activeOrganizationId);
  }, [activeOrganizationId]);

  function hostnameFor(id: string) {
    return domains.find((d) => d.id === id)?.hostname ?? "";
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/tracking-links`, {
        method: "POST",
        body: JSON.stringify({ campaignId, trackingDomainId, destinationId, slug }),
      });
      setSlug("");
      await loadAll(activeOrganizationId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create tracking link");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Tracking Links</h1>
          <p className="mt-1 text-sm text-slate-500">
            A tracking link is a routing identifier — it does not yet resolve to a live redirect.
            The Transparent Click Tracker (Phase 3) implements actual click resolution.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Create tracking link</h2>
          <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} required>
              <option value="">Select campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={trackingDomainId}
              onChange={(e) => setTrackingDomainId(e.target.value)}
              required
            >
              <option value="">Select tracking domain</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              required
            >
              <option value="">Select destination</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              className="input"
              placeholder="slug (e.g. spring-sale)"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
            />
            <button type="submit" className="btn-primary sm:col-span-2" disabled={!activeOrganizationId}>
              Create tracking link
            </button>
          </form>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Link</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {trackingLinks.map((link) => (
                <tr key={link.id}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-800">
                    {hostnameFor(link.trackingDomainId)}/{link.slug}
                  </td>
                  <td className="px-4 py-3">
                    <span className="badge bg-slate-100 text-slate-600">{link.status}</span>
                  </td>
                </tr>
              ))}
              {trackingLinks.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={2}>
                    No tracking links yet.
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
