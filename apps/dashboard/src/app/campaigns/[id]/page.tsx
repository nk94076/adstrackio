"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type {
  BotTrafficPolicyAction,
  Campaign,
  CampaignStatus,
  Destination,
  TrackingDomain,
  TrackingLink,
  TrackingLinkStatus,
} from "@/lib/types";

const BOT_POLICY_OPTIONS: BotTrafficPolicyAction[] = ["TARGET", "SAFE_PAGE", "BLOCK"];

const CAMPAIGN_STATUS_STYLES: Record<CampaignStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-600",
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-amber-50 text-amber-700",
  ARCHIVED: "bg-slate-100 text-slate-500",
};

const LINK_STATUS_STYLES: Record<TrackingLinkStatus, string> = {
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-amber-50 text-amber-700",
  ARCHIVED: "bg-slate-100 text-slate-500",
};

/** Kept in sync manually with packages/shared/src/campaign-lifecycle.ts —
 * see the same note in campaigns/page.tsx. */
const CAMPAIGN_ACTIONS: Record<CampaignStatus, Array<"activate" | "pause" | "archive">> = {
  DRAFT: ["activate", "archive"],
  ACTIVE: ["pause", "archive"],
  PAUSED: ["activate", "archive"],
  ARCHIVED: [],
};

const LINK_ACTIONS: Record<TrackingLinkStatus, Array<"activate" | "pause" | "archive">> = {
  ACTIVE: ["pause", "archive"],
  PAUSED: ["activate", "archive"],
  ARCHIVED: [],
};

const ACTION_LABELS: Record<"activate" | "pause" | "archive", string> = {
  activate: "Activate",
  pause: "Pause",
  archive: "Archive",
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;
  const { activeOrganizationId, memberships } = useAuth();
  const currentRole = useMemo(
    () => memberships.find((m) => m.organization.id === activeOrganizationId)?.role ?? null,
    [memberships, activeOrganizationId],
  );
  const canManage = currentRole === "OWNER" || currentRole === "ADMIN" || currentRole === "MEMBER";
  const canRunLifecycle = currentRole === "OWNER" || currentRole === "ADMIN";

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [domains, setDomains] = useState<TrackingDomain[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [trackingLinks, setTrackingLinks] = useState<TrackingLink[]>([]);
  const [notFound, setNotFound] = useState(false);

  const [form, setForm] = useState({
    name: "",
    trackingDomainId: "",
    destinationId: "",
    safePageUrl: "",
    suspiciousTrafficPolicy: "TARGET" as BotTrafficPolicyAction,
    unknownTrafficPolicy: "TARGET" as BotTrafficPolicyAction,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [linkTrackingDomainId, setLinkTrackingDomainId] = useState("");
  const [linkDestinationId, setLinkDestinationId] = useState("");
  const [linkSlug, setLinkSlug] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrganizationId || !campaignId) return;
    try {
      const [campaignRes, domainsRes, destinationsRes, linksRes] = await Promise.all([
        apiFetch<{ campaign: Campaign }>(
          `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaignId}`,
        ),
        apiFetch<{ domains: TrackingDomain[] }>(
          `/api/v1/organizations/${activeOrganizationId}/domains`,
        ),
        apiFetch<{ destinations: Destination[] }>(
          `/api/v1/organizations/${activeOrganizationId}/destinations`,
        ),
        apiFetch<{ trackingLinks: TrackingLink[] }>(
          `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaignId}/tracking-links`,
        ),
      ]);
      setCampaign(campaignRes.campaign);
      setDomains(domainsRes.domains);
      setDestinations(destinationsRes.destinations);
      setTrackingLinks(linksRes.trackingLinks);
      setForm({
        name: campaignRes.campaign.name,
        trackingDomainId: campaignRes.campaign.trackingDomainId ?? "",
        destinationId: campaignRes.campaign.destinationId ?? "",
        safePageUrl: campaignRes.campaign.safePageUrl ?? "",
        suspiciousTrafficPolicy: campaignRes.campaign.suspiciousTrafficPolicy,
        unknownTrafficPolicy: campaignRes.campaign.unknownTrafficPolicy,
      });
    } catch (err) {
      if (err instanceof ApiClientError && err.statusCode === 404) {
        setNotFound(true);
        return;
      }
      throw err;
    }
  }, [activeOrganizationId, campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId || !campaign) return;
    setFormError(null);
    setSaving(true);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/campaigns/${campaign.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          trackingDomainId: form.trackingDomainId || null,
          destinationId: form.destinationId || null,
          safePageUrl: form.safePageUrl || null,
          suspiciousTrafficPolicy: form.suspiciousTrafficPolicy,
          unknownTrafficPolicy: form.unknownTrafficPolicy,
        }),
      });
      await load();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to update campaign");
    } finally {
      setSaving(false);
    }
  }

  async function handleCampaignAction(action: "activate" | "pause" | "archive") {
    if (!activeOrganizationId || !campaign) return;
    setActionError(null);
    setPendingActionId(campaign.id);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaign.id}/${action}`,
        { method: "POST" },
      );
      await load();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : `Failed to ${action} campaign`);
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleCreateLink(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId || !campaign) return;
    setLinkError(null);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaign.id}/tracking-links`,
        {
          method: "POST",
          body: JSON.stringify({
            trackingDomainId: linkTrackingDomainId,
            destinationId: linkDestinationId,
            slug: linkSlug,
          }),
        },
      );
      setLinkSlug("");
      await load();
    } catch (err) {
      setLinkError(err instanceof ApiClientError ? err.message : "Failed to create tracking link");
    }
  }

  async function handleLinkAction(linkId: string, action: "activate" | "pause" | "archive") {
    if (!activeOrganizationId || !campaign) return;
    setActionError(null);
    setPendingActionId(linkId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaign.id}/tracking-links/${linkId}/${action}`,
        { method: "POST" },
      );
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : `Failed to ${action} tracking link`,
      );
    } finally {
      setPendingActionId(null);
    }
  }

  function hostnameFor(id: string) {
    return domains.find((d) => d.id === id)?.hostname ?? id;
  }

  if (notFound) {
    return (
      <AppShell>
        <div className="mx-auto max-w-4xl">
          <p className="text-sm text-slate-500">
            Campaign not found.{" "}
            <Link href="/campaigns" className="text-brand-600 hover:text-brand-700">
              Back to campaigns
            </Link>
          </p>
        </div>
      </AppShell>
    );
  }

  if (!campaign) {
    return (
      <AppShell>
        <div className="mx-auto max-w-4xl text-sm text-slate-500">Loading…</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <Link href="/campaigns" className="text-sm text-brand-600 hover:text-brand-700">
            &larr; Back to campaigns
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-900">{campaign.name}</h1>
            <span className={`badge ${CAMPAIGN_STATUS_STYLES[campaign.status]}`}>
              {campaign.status}
            </span>
          </div>
        </div>

        {actionError && <p className="text-sm text-red-600">{actionError}</p>}

        {canRunLifecycle && CAMPAIGN_ACTIONS[campaign.status].length > 0 && (
          <div className="flex flex-wrap gap-2">
            {CAMPAIGN_ACTIONS[campaign.status].map((action) => (
              <button
                key={action}
                type="button"
                className={action === "archive" ? "btn-secondary" : "btn-primary"}
                disabled={pendingActionId === campaign.id}
                onClick={() => handleCampaignAction(action)}
              >
                {ACTION_LABELS[action]}
              </button>
            ))}
          </div>
        )}
        {campaign.status === "ARCHIVED" && (
          <p className="text-sm text-slate-500">
            This campaign is archived and can never be reactivated.
          </p>
        )}

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Configuration</h2>
          {campaign.status === "ACTIVE" && (
            <p className="mt-1 text-xs text-slate-500">
              The tracking domain cannot be changed while this campaign is ACTIVE — pause it first.
            </p>
          )}
          <form onSubmit={handleSave} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="name">
                Name
              </label>
              <input
                id="name"
                className="input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                disabled={!canManage}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="trackingDomainId">
                Tracking domain
              </label>
              <select
                id="trackingDomainId"
                className="input"
                value={form.trackingDomainId}
                onChange={(e) => setForm((f) => ({ ...f, trackingDomainId: e.target.value }))}
                disabled={!canManage || campaign.status === "ACTIVE"}
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
            </div>
            <div>
              <label className="label" htmlFor="destinationId">
                Destination
              </label>
              <select
                id="destinationId"
                className="input"
                value={form.destinationId}
                onChange={(e) => setForm((f) => ({ ...f, destinationId: e.target.value }))}
                disabled={!canManage}
              >
                <option value="">No destination</option>
                {destinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="safePageUrl">
                Safe Page URL
              </label>
              <input
                id="safePageUrl"
                className="input"
                placeholder="Where BOT-classified traffic is sent (optional)"
                value={form.safePageUrl}
                onChange={(e) => setForm((f) => ({ ...f, safePageUrl: e.target.value }))}
                disabled={!canManage}
              />
            </div>
            <div>
              <label className="label" htmlFor="suspiciousTrafficPolicy">
                SUSPICIOUS traffic policy
              </label>
              <select
                id="suspiciousTrafficPolicy"
                className="input"
                value={form.suspiciousTrafficPolicy}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    suspiciousTrafficPolicy: e.target.value as BotTrafficPolicyAction,
                  }))
                }
                disabled={!canManage}
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
                value={form.unknownTrafficPolicy}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    unknownTrafficPolicy: e.target.value as BotTrafficPolicyAction,
                  }))
                }
                disabled={!canManage}
              >
                {BOT_POLICY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            {canManage && (
              <button type="submit" className="btn-primary sm:col-span-2" disabled={saving}>
                Save changes
              </button>
            )}
          </form>
          {formError && <p className="mt-2 text-sm text-red-600">{formError}</p>}
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Tracking links</h2>
          <p className="mt-1 text-xs text-slate-500">
            A tracking link belongs to exactly this campaign. Pausing or archiving a link stops it
            from serving traffic independently of the campaign&apos;s own status.
          </p>

          {canManage && (
            <form onSubmit={handleCreateLink} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
              <select
                className="input"
                value={linkTrackingDomainId}
                onChange={(e) => setLinkTrackingDomainId(e.target.value)}
                required
              >
                <option value="">Select tracking domain</option>
                {domains.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.hostname}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={linkDestinationId}
                onChange={(e) => setLinkDestinationId(e.target.value)}
                required
              >
                <option value="">Select destination</option>
                {destinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="slug (e.g. spring-sale)"
                value={linkSlug}
                onChange={(e) => setLinkSlug(e.target.value)}
                required
              />
              <button type="submit" className="btn-primary">
                Add link
              </button>
            </form>
          )}
          {linkError && <p className="mt-2 text-sm text-red-600">{linkError}</p>}

          <table className="mt-4 w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Link</th>
                <th className="px-4 py-2 font-medium">Status</th>
                {canRunLifecycle && <th className="px-4 py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {trackingLinks.map((link) => (
                <tr key={link.id}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-800">
                    {hostnameFor(link.trackingDomainId)}/{link.slug}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${LINK_STATUS_STYLES[link.status]}`}>{link.status}</span>
                  </td>
                  {canRunLifecycle && (
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {LINK_ACTIONS[link.status].map((action) => (
                          <button
                            key={action}
                            type="button"
                            className={action === "archive" ? "btn-secondary" : "btn-primary"}
                            disabled={pendingActionId === link.id}
                            onClick={() => handleLinkAction(link.id, action)}
                          >
                            {ACTION_LABELS[action]}
                          </button>
                        ))}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {trackingLinks.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={canRunLifecycle ? 3 : 2}>
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
