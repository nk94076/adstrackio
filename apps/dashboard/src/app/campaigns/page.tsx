"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type {
  BotTrafficPolicyAction,
  Campaign,
  CampaignStatus,
  Destination,
  TrackingDomain,
} from "@/lib/types";

const BOT_POLICY_OPTIONS: BotTrafficPolicyAction[] = ["TARGET", "SAFE_PAGE", "BLOCK"];

const STATUS_STYLES: Record<CampaignStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-600",
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-amber-50 text-amber-700",
  ARCHIVED: "bg-slate-100 text-slate-500",
};

/** Mirrors packages/shared/src/campaign-lifecycle.ts — which lifecycle
 * actions are legal from a given status. Kept in sync manually since the
 * dashboard doesn't share code with the backend; the backend is the
 * authoritative enforcement point regardless (see campaigns.service.ts) —
 * this only decides which buttons to show. */
const AVAILABLE_ACTIONS: Record<CampaignStatus, Array<"activate" | "pause" | "archive">> = {
  DRAFT: ["activate", "archive"],
  ACTIVE: ["pause", "archive"],
  PAUSED: ["activate", "archive"],
  ARCHIVED: [],
};

const ACTION_LABELS: Record<"activate" | "pause" | "archive", string> = {
  activate: "Activate",
  pause: "Pause",
  archive: "Archive",
};

export default function CampaignsPage() {
  const { activeOrganizationId, memberships } = useAuth();
  const currentRole = useMemo(
    () => memberships.find((m) => m.organization.id === activeOrganizationId)?.role ?? null,
    [memberships, activeOrganizationId],
  );
  const canManage = currentRole === "OWNER" || currentRole === "ADMIN" || currentRole === "MEMBER";
  const canRunLifecycle = currentRole === "OWNER" || currentRole === "ADMIN";

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [domains, setDomains] = useState<TrackingDomain[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);

  const [campaignName, setCampaignName] = useState("");
  const [trackingDomainId, setTrackingDomainId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [safePageUrl, setSafePageUrl] = useState("");
  const [suspiciousTrafficPolicy, setSuspiciousTrafficPolicy] =
    useState<BotTrafficPolicyAction>("TARGET");
  const [unknownTrafficPolicy, setUnknownTrafficPolicy] = useState<BotTrafficPolicyAction>("TARGET");
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const [destinationName, setDestinationName] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [destinationError, setDestinationError] = useState<string | null>(null);

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
          safePageUrl: safePageUrl || undefined,
          suspiciousTrafficPolicy,
          unknownTrafficPolicy,
        }),
      });
      setCampaignName("");
      setTrackingDomainId("");
      setDestinationId("");
      setSafePageUrl("");
      setSuspiciousTrafficPolicy("TARGET");
      setUnknownTrafficPolicy("TARGET");
      await loadAll(activeOrganizationId);
    } catch (err) {
      setCampaignError(err instanceof ApiClientError ? err.message : "Failed to create campaign");
    }
  }

  async function handleLifecycleAction(
    campaignId: string,
    action: "activate" | "pause" | "archive",
  ) {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingActionId(campaignId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaignId}/${action}`,
        { method: "POST" },
      );
      await loadAll(activeOrganizationId);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : `Failed to ${action} campaign`);
    } finally {
      setPendingActionId(null);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Campaigns</h1>
          <p className="mt-1 text-sm text-slate-500">
            A campaign moves through DRAFT -&gt; ACTIVE -&gt; PAUSED -&gt; ACTIVE -&gt; ARCHIVED.
            ARCHIVED is final — an archived campaign can never be reactivated. Manage a campaign&apos;s
            tracking links from its detail page.
          </p>
        </div>

        {!canManage && (
          <div className="card p-4 text-sm text-slate-600">
            You have read-only (VIEWER) access to this organization&apos;s campaigns.
          </div>
        )}

        {canManage && (
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
        )}

        {canManage && (
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-slate-800">Create campaign</h2>
            <p className="mt-1 text-xs text-slate-500">
              A tracking domain must be verified and active before it can be assigned here — see the
              Domains page. Safe Page and bot-traffic policy control where the tracker (Phase 3/5)
              routes automated/ambiguous traffic. BOT always goes to the Safe Page (or a controlled
              block if none is set); HUMAN always goes to the real destination — only SUSPICIOUS and
              UNKNOWN verdicts are configurable. See docs/architecture/bot-detection.md.
            </p>
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
                    {domain.verificationStatus !== "VERIFIED" || !domain.isActive
                      ? " (not usable yet)"
                      : ""}
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
              <input
                className="input sm:col-span-3"
                placeholder="Safe Page URL (where BOT-classified traffic is sent, optional)"
                value={safePageUrl}
                onChange={(e) => setSafePageUrl(e.target.value)}
              />
              <div>
                <label className="label" htmlFor="suspiciousTrafficPolicy">
                  SUSPICIOUS traffic policy
                </label>
                <select
                  id="suspiciousTrafficPolicy"
                  className="input"
                  value={suspiciousTrafficPolicy}
                  onChange={(e) => setSuspiciousTrafficPolicy(e.target.value as BotTrafficPolicyAction)}
                >
                  {BOT_POLICY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="unknownTrafficPolicy">
                  UNKNOWN traffic policy
                </label>
                <select
                  id="unknownTrafficPolicy"
                  className="input"
                  value={unknownTrafficPolicy}
                  onChange={(e) => setUnknownTrafficPolicy(e.target.value as BotTrafficPolicyAction)}
                >
                  {BOT_POLICY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn-primary sm:col-span-3" disabled={!activeOrganizationId}>
                Create campaign
              </button>
            </form>
            {campaignError && <p className="mt-2 text-sm text-red-600">{campaignError}</p>}
          </div>
        )}

        {actionError && <p className="text-sm text-red-600">{actionError}</p>}

        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Safe Page</th>
                <th className="px-4 py-2 font-medium">Bot policy (SUS / UNK)</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Actions</th>
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
                    {campaign.safePageUrl ? (
                      <span className="truncate">{campaign.safePageUrl}</span>
                    ) : (
                      <span className="text-slate-400">Not configured</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {campaign.suspiciousTrafficPolicy} / {campaign.unknownTrafficPolicy}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(campaign.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/campaigns/${campaign.id}`} className="btn-secondary">
                        Manage
                      </Link>
                      {canRunLifecycle &&
                        AVAILABLE_ACTIONS[campaign.status].map((action) => (
                          <button
                            key={action}
                            type="button"
                            className={action === "archive" ? "btn-secondary" : "btn-primary"}
                            disabled={pendingActionId === campaign.id}
                            onClick={() => handleLifecycleAction(campaign.id, action)}
                          >
                            {ACTION_LABELS[action]}
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
              {campaigns.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={6}>
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
