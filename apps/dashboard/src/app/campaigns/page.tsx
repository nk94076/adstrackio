"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { Campaign, CampaignStatus, Destination, TrackingDomain } from "@/lib/types";

const STATUS_STYLES: Record<CampaignStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-600",
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-amber-50 text-amber-700",
  ARCHIVED: "bg-slate-100 text-slate-500",
};

export default function CampaignsPage() {
  const { activeOrganizationId } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [domains, setDomains] = useState<TrackingDomain[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);

  const [campaignName, setCampaignName] = useState("");
  const [trackingDomainId, setTrackingDomainId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const [destinationName, setDestinationName] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [destinationError, setDestinationError] = useState<string | null>(null);

  async function loadAll(organizationId: string) {
    const [campaignsRes, domainsRes, destinationsRes] = await Promise.all([
      apiFetch<{ campaigns: Campaign[] }>(`/api/v1/organizations/${organizationId}/campaigns`),
      apiFetch<{ domains: TrackingDomain[] }>(`/api/v1/organizations/${organizationId}/domains`),
      apiFetch<{ destinations: Destination[] }>(
        `/api/v1/organizations/${organizationId}/destinations`,
      ),
    ]);
    setCampaigns(campaignsRes.campaigns);
    setDomains(domainsRes.domains);
    setDestinations(destinationsRes.destinations);
  }

  useEffect(() => {
    if (activeOrganizationId) void loadAll(activeOrganizationId);
  }, [activeOrganizationId]);

  async function handleCreateDestination(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    setDestinationError(null);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/destinations`, {
        method: "POST",
        body: JSON.stringify({ name: destinationName, url: destinationUrl }),
      });
      setDestinationName("");
      setDestinationUrl("");
      await loadAll(activeOrganizationId);
    } catch (err) {
      setDestinationError(
        err instanceof ApiClientError ? err.message : "Failed to create destination",
      );
    }
  }

  async function handleCreateCampaign(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    setCampaignError(null);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/campaigns`, {
        method: "POST",
        body: JSON.stringify({
          name: campaignName,
          trackingDomainId: trackingDomainId || undefined,
          destinationId: destinationId || undefined,
        }),
      });
      setCampaignName("");
      setTrackingDomainId("");
      setDestinationId("");
      await loadAll(activeOrganizationId);
    } catch (err) {
      setCampaignError(err instanceof ApiClientError ? err.message : "Failed to create campaign");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Campaigns</h1>
          <p className="mt-1 text-sm text-slate-500">
            Campaigns are the foundation for future routing rules and reporting. Advanced routing
            is not implemented yet.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Destinations</h2>
          <p className="mt-1 text-xs text-slate-500">
            The business URL a campaign or tracking link ultimately points to.
          </p>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {destinations.map((destination) => (
              <li key={destination.id} className="flex justify-between py-2">
                <span className="font-medium text-slate-800">{destination.name}</span>
                <span className="truncate text-slate-500">{destination.url}</span>
              </li>
            ))}
            {destinations.length === 0 && (
              <li className="py-2 text-slate-500">No destinations yet.</li>
            )}
          </ul>
          <form onSubmit={handleCreateDestination} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input
              className="input"
              placeholder="Name"
              value={destinationName}
              onChange={(e) => setDestinationName(e.target.value)}
              required
            />
            <input
              className="input"
              placeholder="https://offer.example.com"
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              required
            />
            <button type="submit" className="btn-secondary" disabled={!activeOrganizationId}>
              Add destination
            </button>
          </form>
          {destinationError && <p className="mt-2 text-sm text-red-600">{destinationError}</p>}
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Create campaign</h2>
          <form onSubmit={handleCreateCampaign} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input
              className="input"
              placeholder="Campaign name"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              required
            />
            <select
              className="input"
              value={trackingDomainId}
              onChange={(e) => setTrackingDomainId(e.target.value)}
            >
              <option value="">No tracking domain</option>
              {domains.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.hostname}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
            >
              <option value="">No destination</option>
              {destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-primary sm:col-span-3" disabled={!activeOrganizationId}>
              Create campaign
            </button>
          </form>
          {campaignError && <p className="mt-2 text-sm text-red-600">{campaignError}</p>}
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td className="px-4 py-3 font-medium text-slate-800">{campaign.name}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${STATUS_STYLES[campaign.status]}`}>
                      {campaign.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(campaign.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {campaigns.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={3}>
                    No campaigns yet.
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
