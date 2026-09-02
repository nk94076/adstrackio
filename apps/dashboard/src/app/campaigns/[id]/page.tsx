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
  RoutingCondition,
  RoutingConditionField,
  RoutingConditionOperator,
  RoutingRule,
  RoutingRuleAction,
  TrackingDomain,
  TrackingLink,
  TrackingLinkStatus,
} from "@/lib/types";

const BOT_POLICY_OPTIONS: BotTrafficPolicyAction[] = ["TARGET", "SAFE_PAGE", "BLOCK"];

const ROUTING_ACTION_OPTIONS: RoutingRuleAction[] = ["TARGET", "SAFE_PAGE", "BLOCK"];
const ROUTING_FIELD_OPTIONS: RoutingConditionField[] = [
  "BOT_CLASSIFICATION",
  "COUNTRY",
  "DEVICE_TYPE",
  "BROWSER",
  "OS",
  "REFERRER_HOST",
];
const ROUTING_OPERATOR_OPTIONS: RoutingConditionOperator[] = ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"];

const ROUTING_RULE_STATUS_STYLES: Record<RoutingRule["status"], string> = {
  ACTIVE: "bg-green-50 text-green-700",
  INACTIVE: "bg-slate-100 text-slate-500",
};

function describeCondition(condition: RoutingCondition): string {
  const value = Array.isArray(condition.value) ? condition.value.join(", ") : condition.value;
  const operatorLabel: Record<RoutingConditionOperator, string> = {
    EQUALS: "=",
    NOT_EQUALS: "≠",
    IN: "in",
    NOT_IN: "not in",
  };
  return `${condition.field} ${operatorLabel[condition.operator]} ${value}`;
}

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
  const [routingRules, setRoutingRules] = useState<RoutingRule[]>([]);
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

  const [ruleName, setRuleName] = useState("");
  const [rulePriority, setRulePriority] = useState("");
  const [ruleAction, setRuleAction] = useState<RoutingRuleAction>("BLOCK");
  const [draftConditions, setDraftConditions] = useState<RoutingCondition[]>([]);
  const [conditionField, setConditionField] = useState<RoutingConditionField>("COUNTRY");
  const [conditionOperator, setConditionOperator] = useState<RoutingConditionOperator>("EQUALS");
  const [conditionValue, setConditionValue] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrganizationId || !campaignId) return;
    try {
      const [campaignRes, domainsRes, destinationsRes, linksRes, rulesRes] = await Promise.all([
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
        apiFetch<{ rules: RoutingRule[] }>(
          `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaignId}/rules`,
        ),
      ]);
      setCampaign(campaignRes.campaign);
      setDomains(domainsRes.domains);
      setDestinations(destinationsRes.destinations);
      setTrackingLinks(linksRes.trackingLinks);
      setRoutingRules(rulesRes.rules);
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

  function handleAddCondition() {
    if (!conditionValue.trim()) return;
    const value: string | string[] =
      conditionOperator === "IN" || conditionOperator === "NOT_IN"
        ? conditionValue
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
        : conditionValue.trim();
    setDraftConditions((prev) => [...prev, { field: conditionField, operator: conditionOperator, value }]);
    setConditionValue("");
  }

  function handleRemoveCondition(index: number) {
    setDraftConditions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleCreateRule(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId || !campaign) return;
    setRuleError(null);
    if (draftConditions.length === 0) {
      setRuleError("Add at least one condition before creating a rule");
      return;
    }
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaign.id}/rules`,
        {
          method: "POST",
          body: JSON.stringify({
            name: ruleName,
            priority: Number(rulePriority),
            action: ruleAction,
            conditions: draftConditions,
          }),
        },
      );
      setRuleName("");
      setRulePriority("");
      setRuleAction("BLOCK");
      setDraftConditions([]);
      await load();
    } catch (err) {
      setRuleError(err instanceof ApiClientError ? err.message : "Failed to create routing rule");
    }
  }

  async function handleRuleAction(ruleId: string, action: "activate" | "deactivate") {
    if (!activeOrganizationId || !campaign) return;
    setActionError(null);
    setPendingActionId(ruleId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaign.id}/rules/${ruleId}/${action}`,
        { method: "POST" },
      );
      await load();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : `Failed to ${action} rule`);
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    if (!activeOrganizationId || !campaign) return;
    setActionError(null);
    setPendingActionId(ruleId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/campaigns/${campaign.id}/rules/${ruleId}`,
        { method: "DELETE" },
      );
      await load();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Failed to delete rule");
    } finally {
      setPendingActionId(null);
    }
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

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Routing rules</h2>
          <p className="mt-1 text-xs text-slate-500">
            Rules are evaluated in ascending priority order (lower number first); the first rule whose
            conditions all match decides the action. A BOT-classified visitor always goes to the Safe
            Page regardless of any rule. A visitor with no matching rule falls back to this
            campaign&apos;s SUSPICIOUS/UNKNOWN traffic policy above (HUMAN traffic with no matching rule
            always goes to the transparent destination).
          </p>

          {canManage && (
            <form onSubmit={handleCreateRule} className="mt-4 space-y-3 rounded-md border border-slate-200 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <input
                  className="input"
                  placeholder="Rule name"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  required
                />
                <input
                  className="input"
                  type="number"
                  min={1}
                  placeholder="Priority (lower = first)"
                  value={rulePriority}
                  onChange={(e) => setRulePriority(e.target.value)}
                  required
                />
                <select
                  className="input"
                  value={ruleAction}
                  onChange={(e) => setRuleAction(e.target.value as RoutingRuleAction)}
                >
                  {ROUTING_ACTION_OPTIONS.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <p className="label">Conditions (all must match)</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                  <select
                    className="input"
                    value={conditionField}
                    onChange={(e) => setConditionField(e.target.value as RoutingConditionField)}
                  >
                    {ROUTING_FIELD_OPTIONS.map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input"
                    value={conditionOperator}
                    onChange={(e) => setConditionOperator(e.target.value as RoutingConditionOperator)}
                  >
                    {ROUTING_OPERATOR_OPTIONS.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    placeholder={
                      conditionOperator === "IN" || conditionOperator === "NOT_IN"
                        ? "Comma-separated values, e.g. US, GB"
                        : "Value, e.g. US"
                    }
                    value={conditionValue}
                    onChange={(e) => setConditionValue(e.target.value)}
                  />
                  <button type="button" className="btn-secondary" onClick={handleAddCondition}>
                    Add condition
                  </button>
                </div>
                {draftConditions.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {draftConditions.map((condition, index) => (
                      <li
                        key={index}
                        className="flex items-center justify-between rounded bg-slate-50 px-3 py-1.5 text-xs text-slate-700"
                      >
                        <span className="font-mono">{describeCondition(condition)}</span>
                        <button
                          type="button"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => handleRemoveCondition(index)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <button type="submit" className="btn-primary">
                Create rule
              </button>
            </form>
          )}
          {ruleError && <p className="mt-2 text-sm text-red-600">{ruleError}</p>}

          <table className="mt-4 w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Priority</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Conditions</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Status</th>
                {(canRunLifecycle || canManage) && <th className="px-4 py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {routingRules.map((rule) => (
                <tr key={rule.id}>
                  <td className="px-4 py-3 text-slate-800">{rule.priority}</td>
                  <td className="px-4 py-3 text-slate-800">{rule.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {rule.conditions.map(describeCondition).join(" AND ") || "(always matches)"}
                  </td>
                  <td className="px-4 py-3 text-slate-800">{rule.action}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${ROUTING_RULE_STATUS_STYLES[rule.status]}`}>
                      {rule.status}
                    </span>
                  </td>
                  {(canRunLifecycle || canManage) && (
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {canRunLifecycle && rule.status === "ACTIVE" && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={pendingActionId === rule.id}
                            onClick={() => handleRuleAction(rule.id, "deactivate")}
                          >
                            Deactivate
                          </button>
                        )}
                        {canRunLifecycle && rule.status === "INACTIVE" && (
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={pendingActionId === rule.id}
                            onClick={() => handleRuleAction(rule.id, "activate")}
                          >
                            Activate
                          </button>
                        )}
                        {canManage && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={pendingActionId === rule.id}
                            onClick={() => handleDeleteRule(rule.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {routingRules.length === 0 && (
                <tr>
                  <td
                    className="px-4 py-6 text-center text-slate-500"
                    colSpan={canRunLifecycle || canManage ? 6 : 5}
                  >
                    No routing rules yet.
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
