"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type {
  AffiliatePartner,
  AffiliatePartnerPerformanceRow,
  AffiliatePartnerStatus,
  Campaign,
  CampaignAffiliatePartnerAssignment,
} from "@/lib/types";

const STATUS_STYLES: Record<AffiliatePartnerStatus, string> = {
  PENDING: "bg-slate-100 text-slate-600",
  ACTIVE: "bg-green-50 text-green-700",
  PAUSED: "bg-amber-50 text-amber-700",
  ARCHIVED: "bg-slate-100 text-slate-500",
};

/** Mirrors packages/shared/src/affiliate-partner-lifecycle.ts — which
 * lifecycle actions are legal from a given status. Kept in sync manually
 * since the dashboard doesn't share code with the backend; the backend
 * remains the authoritative enforcement point regardless (see
 * affiliate-partners.service.ts) — this only decides which buttons to show. */
const AVAILABLE_ACTIONS: Record<AffiliatePartnerStatus, Array<"activate" | "pause" | "archive">> = {
  PENDING: ["activate", "archive"],
  ACTIVE: ["pause", "archive"],
  PAUSED: ["activate", "archive"],
  ARCHIVED: [],
};

const ACTION_LABELS: Record<"activate" | "pause" | "archive", string> = {
  activate: "Activate",
  pause: "Pause",
  archive: "Archive",
};

export default function AffiliatePartnersPage() {
  const { activeOrganizationId, memberships } = useAuth();
  const currentRole = useMemo(
    () => memberships.find((m) => m.organization.id === activeOrganizationId)?.role ?? null,
    [memberships, activeOrganizationId],
  );
  const canManage = currentRole === "OWNER" || currentRole === "ADMIN" || currentRole === "MEMBER";
  const canRunLifecycle = currentRole === "OWNER" || currentRole === "ADMIN";

  const [partners, setPartners] = useState<AffiliatePartner[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [performance, setPerformance] = useState<AffiliatePartnerPerformanceRow[]>([]);

  const [name, setName] = useState("");
  const [externalId, setExternalId] = useState("");
  const [email, setEmail] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", externalId: "", email: "" });
  const [editError, setEditError] = useState<string | null>(null);

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [assignments, setAssignments] = useState<CampaignAffiliatePartnerAssignment[]>([]);
  const [assignPartnerId, setAssignPartnerId] = useState("");
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [pendingAssignmentId, setPendingAssignmentId] = useState<string | null>(null);

  const loadAll = useCallback(async (organizationId: string) => {
    const [partnersRes, campaignsRes, performanceRes] = await Promise.all([
      apiFetch<{ affiliatePartners: AffiliatePartner[] }>(
        `/api/v1/organizations/${organizationId}/affiliate-partners`,
      ),
      apiFetch<{ campaigns: Campaign[] }>(`/api/v1/organizations/${organizationId}/campaigns`),
      apiFetch<{ rows: AffiliatePartnerPerformanceRow[] }>(
        `/api/v1/organizations/${organizationId}/analytics/affiliate-partners/performance`,
      ),
    ]);
    setPartners(partnersRes.affiliatePartners);
    setCampaigns(campaignsRes.campaigns);
    setPerformance(performanceRes.rows);
  }, []);

  useEffect(() => {
    if (activeOrganizationId) void loadAll(activeOrganizationId);
  }, [activeOrganizationId, loadAll]);

  const loadAssignments = useCallback(async (organizationId: string, campaignId: string) => {
    if (!campaignId) {
      setAssignments([]);
      return;
    }
    const res = await apiFetch<{ assignments: CampaignAffiliatePartnerAssignment[] }>(
      `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners`,
    );
    setAssignments(res.assignments);
  }, []);

  useEffect(() => {
    if (activeOrganizationId) void loadAssignments(activeOrganizationId, selectedCampaignId);
  }, [activeOrganizationId, selectedCampaignId, loadAssignments]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    setCreateError(null);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/affiliate-partners`, {
        method: "POST",
        body: JSON.stringify({
          name,
          externalId: externalId || undefined,
          email: email || undefined,
        }),
      });
      setName("");
      setExternalId("");
      setEmail("");
      await loadAll(activeOrganizationId);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create affiliate partner");
    }
  }

  function startEdit(partner: AffiliatePartner) {
    setEditingId(partner.id);
    setEditError(null);
    setEditForm({
      name: partner.name,
      externalId: partner.externalId ?? "",
      email: partner.email ?? "",
    });
  }

  async function handleSaveEdit(partnerId: string) {
    if (!activeOrganizationId) return;
    setEditError(null);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/affiliate-partners/${partnerId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editForm.name,
          externalId: editForm.externalId || null,
          email: editForm.email || null,
        }),
      });
      setEditingId(null);
      await loadAll(activeOrganizationId);
    } catch (err) {
      setEditError(err instanceof ApiClientError ? err.message : "Failed to update affiliate partner");
    }
  }

  async function handleLifecycleAction(partnerId: string, action: "activate" | "pause" | "archive") {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingActionId(partnerId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/affiliate-partners/${partnerId}/${action}`,
        { method: "POST" },
      );
      await loadAll(activeOrganizationId);
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : `Failed to ${action} affiliate partner`,
      );
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleAssign(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId || !selectedCampaignId || !assignPartnerId) return;
    setAssignmentError(null);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${selectedCampaignId}/affiliate-partners/${assignPartnerId}`,
        { method: "POST" },
      );
      setAssignPartnerId("");
      await loadAssignments(activeOrganizationId, selectedCampaignId);
    } catch (err) {
      setAssignmentError(err instanceof ApiClientError ? err.message : "Failed to assign partner");
    }
  }

  async function handleUnassign(partnerId: string) {
    if (!activeOrganizationId || !selectedCampaignId) return;
    setAssignmentError(null);
    setPendingAssignmentId(partnerId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${selectedCampaignId}/affiliate-partners/${partnerId}`,
        { method: "DELETE" },
      );
      await loadAssignments(activeOrganizationId, selectedCampaignId);
    } catch (err) {
      setAssignmentError(err instanceof ApiClientError ? err.message : "Failed to unassign partner");
    } finally {
      setPendingAssignmentId(null);
    }
  }

  const assignablePartners = partners.filter(
    (p) => p.status !== "ARCHIVED" && !assignments.some((a) => a.affiliatePartnerId === p.id),
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Affiliate Partners</h1>
          <p className="mt-1 text-sm text-slate-500">
            A partner moves through PENDING -&gt; ACTIVE -&gt; PAUSED -&gt; ACTIVE -&gt; ARCHIVED.
            ARCHIVED is final and cannot receive new campaign assignments, but its historical clicks
            and conversions remain attributed to it. Attribution is deterministic per tracking link —
            payouts and payment processing are not part of this phase.
          </p>
        </div>

        {!canManage && (
          <div className="card p-4 text-sm text-slate-600">
            You have read-only (VIEWER) access to this organization&apos;s affiliate partners.
          </div>
        )}

        {canManage && (
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-slate-800">Add affiliate partner</h2>
            <form onSubmit={handleCreate} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input
                className="input"
                placeholder="Partner name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <input
                className="input"
                placeholder="External ID (optional)"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
              />
              <input
                className="input"
                type="email"
                placeholder="Contact email (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" className="btn-primary sm:col-span-3" disabled={!activeOrganizationId}>
                Add partner
              </button>
            </form>
            {createError && <p className="mt-2 text-sm text-red-600">{createError}</p>}
          </div>
        )}

        {actionError && <p className="text-sm text-red-600">{actionError}</p>}

        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">External ID</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {partners.map((partner) => (
                <tr key={partner.id}>
                  {editingId === partner.id ? (
                    <>
                      <td className="px-4 py-3">
                        <input
                          className="input"
                          value={editForm.name}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          className="input"
                          value={editForm.externalId}
                          onChange={(e) => setEditForm((f) => ({ ...f, externalId: e.target.value }))}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          className="input"
                          value={editForm.email}
                          onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span className={`badge ${STATUS_STYLES[partner.status]}`}>{partner.status}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleSaveEdit(partner.id)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 font-medium text-slate-800">{partner.name}</td>
                      <td className="px-4 py-3 text-slate-500">{partner.externalId ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-500">{partner.email ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`badge ${STATUS_STYLES[partner.status]}`}>{partner.status}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {canManage && (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => startEdit(partner)}
                            >
                              Edit
                            </button>
                          )}
                          {canRunLifecycle &&
                            AVAILABLE_ACTIONS[partner.status].map((action) => (
                              <button
                                key={action}
                                type="button"
                                className={action === "archive" ? "btn-secondary" : "btn-primary"}
                                disabled={pendingActionId === partner.id}
                                onClick={() => handleLifecycleAction(partner.id, action)}
                              >
                                {ACTION_LABELS[action]}
                              </button>
                            ))}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {partners.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={5}>
                    No affiliate partners yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {editError && <p className="text-sm text-red-600">{editError}</p>}

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Campaign assignments</h2>
          <p className="mt-1 text-xs text-slate-500">
            A partner must be on a campaign&apos;s roster before it can be attributed to that
            campaign&apos;s tracking links. Archived partners cannot be newly assigned; existing
            assignments and historical attribution are never removed by archival.
          </p>
          <div className="mt-3">
            <label className="label" htmlFor="campaignSelect">
              Campaign
            </label>
            <select
              id="campaignSelect"
              className="input"
              value={selectedCampaignId}
              onChange={(e) => setSelectedCampaignId(e.target.value)}
            >
              <option value="">Select a campaign…</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </div>

          {selectedCampaignId && (
            <div className="mt-4 space-y-4">
              {canManage && (
                <form onSubmit={handleAssign} className="flex flex-wrap items-end gap-3">
                  <div className="flex-1">
                    <label className="label" htmlFor="assignPartnerSelect">
                      Assign partner
                    </label>
                    <select
                      id="assignPartnerSelect"
                      className="input"
                      value={assignPartnerId}
                      onChange={(e) => setAssignPartnerId(e.target.value)}
                    >
                      <option value="">Select a partner…</option>
                      {assignablePartners.map((partner) => (
                        <option key={partner.id} value={partner.id}>
                          {partner.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" className="btn-primary" disabled={!assignPartnerId}>
                    Assign
                  </button>
                </form>
              )}
              {assignmentError && <p className="text-sm text-red-600">{assignmentError}</p>}

              <ul className="divide-y divide-slate-100 text-sm">
                {assignments.map((assignment) => (
                  <li key={assignment.id} className="flex items-center justify-between py-2">
                    <div>
                      <span className="font-medium text-slate-800">
                        {assignment.affiliatePartner.name}
                      </span>
                      <span
                        className={`badge ml-2 ${STATUS_STYLES[assignment.affiliatePartner.status]}`}
                      >
                        {assignment.affiliatePartner.status}
                      </span>
                    </div>
                    {canManage && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={pendingAssignmentId === assignment.affiliatePartnerId}
                        onClick={() => handleUnassign(assignment.affiliatePartnerId)}
                      >
                        Unassign
                      </button>
                    )}
                  </li>
                ))}
                {assignments.length === 0 && (
                  <li className="py-2 text-slate-500">No partners assigned to this campaign yet.</li>
                )}
              </ul>
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 p-4">
            <h2 className="text-sm font-semibold text-slate-800">Performance</h2>
            <p className="mt-1 text-xs text-slate-500">
              Clicks and conversions attributed to each partner over the default reporting window.
            </p>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Partner</th>
                <th className="px-4 py-2 font-medium">Clicks</th>
                <th className="px-4 py-2 font-medium">Human clicks</th>
                <th className="px-4 py-2 font-medium">Conversions</th>
                <th className="px-4 py-2 font-medium">Approved</th>
                <th className="px-4 py-2 font-medium">Conv. rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {performance.map((row) => (
                <tr key={row.affiliatePartnerId}>
                  <td className="px-4 py-3 font-medium text-slate-800">{row.name}</td>
                  <td className="px-4 py-3 text-slate-600">{row.clicks}</td>
                  <td className="px-4 py-3 text-slate-600">{row.humanClicks}</td>
                  <td className="px-4 py-3 text-slate-600">{row.conversions}</td>
                  <td className="px-4 py-3 text-slate-600">{row.approvedConversions}</td>
                  <td className="px-4 py-3 text-slate-600">{row.conversionRate}%</td>
                </tr>
              ))}
              {performance.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={6}>
                    No partner activity in the current reporting window.
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
