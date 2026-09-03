"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { WebhookDelivery, WebhookEndpoint, WebhookEventType } from "@/lib/types";

const ALL_EVENT_TYPES: WebhookEventType[] = [
  "conversion.created",
  "conversion.approved",
  "conversion.rejected",
  "conversion.reversed",
  "affiliate_partner.created",
  "affiliate_partner.updated",
  "affiliate_partner.activated",
  "affiliate_partner.paused",
  "affiliate_partner.archived",
  "campaign.created",
  "campaign.updated",
  "tracking_link.created",
  "tracking_link.updated",
];

const DELIVERY_STATUS_STYLES: Record<string, string> = {
  DELIVERED: "bg-green-50 text-green-700",
  PENDING: "bg-amber-50 text-amber-700",
  FAILED: "bg-red-50 text-red-700",
  EXHAUSTED: "bg-red-50 text-red-700",
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * Webhook endpoint management (Phase 11) — read access for
 * MEMBER/VIEWER+, manage (create/update/rotate/disable/test) for
 * ADMIN/OWNER, matching apps/api/src/modules/webhooks/webhooks.routes.ts.
 */
export default function WebhooksPage() {
  const { activeOrganizationId, memberships } = useAuth();
  const currentRole = useMemo(
    () => memberships.find((m) => m.organization.id === activeOrganizationId)?.role ?? null,
    [memberships, activeOrganizationId],
  );
  const canManage = currentRole === "OWNER" || currentRole === "ADMIN";

  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<WebhookEventType[]>(["conversion.created"]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ name: string; secret: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});

  const load = useCallback(async (organizationId: string) => {
    const res = await apiFetch<{ webhooks: WebhookEndpoint[] }>(
      `/api/v1/organizations/${organizationId}/webhooks`,
    );
    setWebhooks(res.webhooks);
  }, []);

  useEffect(() => {
    if (activeOrganizationId) void load(activeOrganizationId);
  }, [activeOrganizationId, load]);

  function toggleEvent(eventType: WebhookEventType) {
    setSelectedEvents((current) =>
      current.includes(eventType) ? current.filter((e) => e !== eventType) : [...current, eventType],
    );
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId || selectedEvents.length === 0) return;
    setCreateError(null);
    try {
      const res = await apiFetch<{ webhook: WebhookEndpoint }>(
        `/api/v1/organizations/${activeOrganizationId}/webhooks`,
        { method: "POST", body: JSON.stringify({ name, url, subscribedEvents: selectedEvents }) },
      );
      setRevealedSecret({ name: res.webhook.name, secret: res.webhook.secret! });
      setName("");
      setUrl("");
      setSelectedEvents(["conversion.created"]);
      await load(activeOrganizationId);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create webhook endpoint");
    }
  }

  async function handleRotateSecret(webhookId: string) {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingId(webhookId);
    try {
      const res = await apiFetch<{ webhook: WebhookEndpoint }>(
        `/api/v1/organizations/${activeOrganizationId}/webhooks/${webhookId}/rotate-secret`,
        { method: "POST" },
      );
      setRevealedSecret({ name: res.webhook.name, secret: res.webhook.secret! });
      await load(activeOrganizationId);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Failed to rotate webhook secret");
    } finally {
      setPendingId(null);
    }
  }

  async function handleDisable(webhookId: string) {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingId(webhookId);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/webhooks/${webhookId}/disable`, {
        method: "POST",
      });
      await load(activeOrganizationId);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Failed to disable webhook");
    } finally {
      setPendingId(null);
    }
  }

  async function handleTest(webhookId: string) {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingId(webhookId);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/webhooks/${webhookId}/test`, {
        method: "POST",
      });
      await loadDeliveries(webhookId);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Failed to send test webhook");
    } finally {
      setPendingId(null);
    }
  }

  async function loadDeliveries(webhookId: string) {
    if (!activeOrganizationId) return;
    const res = await apiFetch<{ deliveries: WebhookDelivery[] }>(
      `/api/v1/organizations/${activeOrganizationId}/webhooks/${webhookId}/deliveries`,
    );
    setDeliveries((current) => ({ ...current, [webhookId]: res.deliveries }));
  }

  async function toggleExpanded(webhookId: string) {
    if (expandedId === webhookId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(webhookId);
    await loadDeliveries(webhookId);
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Webhooks</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every delivery is signed with HMAC-SHA256 over <code>timestamp + &quot;.&quot; + rawBody</code> and
            carries <code>X-Adstrackio-Signature</code>/<code>X-Adstrackio-Event-Id</code>/
            <code>X-Adstrackio-Timestamp</code> headers. Delivery happens asynchronously and never blocks
            any AdstrackIO request — see <code>docs/api/webhooks.md</code>.
          </p>
        </div>

        {revealedSecret && (
          <div className="card border-2 border-amber-300 bg-amber-50 p-6">
            <h2 className="text-sm font-semibold text-amber-900">
              Copy this signing secret now — &quot;{revealedSecret.name}&quot;
            </h2>
            <p className="mt-1 text-xs text-amber-800">
              This is the only time this secret will ever be shown. Use it to verify incoming webhook
              signatures.
            </p>
            <code className="mt-3 block break-all rounded-lg bg-white px-3 py-2 text-sm text-slate-800">
              {revealedSecret.secret}
            </code>
            <button type="button" className="btn-secondary mt-3" onClick={() => setRevealedSecret(null)}>
              I&apos;ve copied it — dismiss
            </button>
          </div>
        )}

        {!canManage && (
          <div className="card p-4 text-sm text-slate-600">
            You have read-only access to this organization&apos;s webhooks. Only OWNER/ADMIN members can
            create, update, rotate, disable, or test-send them.
          </div>
        )}

        {canManage && (
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-slate-800">Add webhook endpoint</h2>
            <form onSubmit={handleCreate} className="mt-3 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  className="input"
                  placeholder="Endpoint name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
                <input
                  className="input"
                  type="url"
                  placeholder="https://your-server.example.com/webhooks/adstrackio"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                />
              </div>
              <p className="text-xs text-slate-500">
                HTTPS is required in production. Localhost, private/internal, and cloud metadata
                addresses are always rejected.
              </p>
              <div>
                <label className="label">Subscribed events</label>
                <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {ALL_EVENT_TYPES.map((eventType) => (
                    <label key={eventType} className="flex items-center gap-1.5 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        checked={selectedEvents.includes(eventType)}
                        onChange={() => toggleEvent(eventType)}
                      />
                      {eventType}
                    </label>
                  ))}
                </div>
              </div>
              <button type="submit" className="btn-primary" disabled={selectedEvents.length === 0}>
                Add endpoint
              </button>
            </form>
            {createError && <p className="mt-2 text-sm text-red-600">{createError}</p>}
          </div>
        )}

        {actionError && <p className="text-sm text-red-600">{actionError}</p>}

        <div className="space-y-4">
          {webhooks.map((webhook) => (
            <div key={webhook.id} className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-800">{webhook.name}</span>
                    <span
                      className={`badge ${webhook.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"}`}
                    >
                      {webhook.active ? "Active" : "Disabled"}
                    </span>
                  </div>
                  <p className="mt-1 break-all text-xs text-slate-500">{webhook.url}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {webhook.subscribedEvents.join(", ")} · last delivery: {formatDate(webhook.lastDeliveryAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary" onClick={() => toggleExpanded(webhook.id)}>
                    {expandedId === webhook.id ? "Hide deliveries" : "View deliveries"}
                  </button>
                  {canManage && (
                    <>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={pendingId === webhook.id}
                        onClick={() => handleTest(webhook.id)}
                      >
                        Send test
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={pendingId === webhook.id}
                        onClick={() => handleRotateSecret(webhook.id)}
                      >
                        Rotate secret
                      </button>
                      {webhook.active && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={pendingId === webhook.id}
                          onClick={() => handleDisable(webhook.id)}
                        >
                          Disable
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {expandedId === webhook.id && (
                <div className="border-t border-slate-100">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Attempt</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">Response</th>
                        <th className="px-4 py-2 font-medium">Delivered</th>
                        <th className="px-4 py-2 font-medium">Next attempt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(deliveries[webhook.id] ?? []).map((delivery) => (
                        <tr key={delivery.id}>
                          <td className="px-4 py-2 text-slate-600">{delivery.attempt}</td>
                          <td className="px-4 py-2">
                            <span className={`badge ${DELIVERY_STATUS_STYLES[delivery.status] ?? ""}`}>
                              {delivery.status}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-slate-600">
                            {delivery.responseStatus ?? "—"}
                            {delivery.responseBodySnippet && (
                              <span className="ml-2 text-xs text-slate-400">
                                {delivery.responseBodySnippet.slice(0, 60)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-slate-500">{formatDate(delivery.deliveredAt)}</td>
                          <td className="px-4 py-2 text-slate-500">
                            {delivery.status === "PENDING" ? formatDate(delivery.nextAttemptAt) : "—"}
                          </td>
                        </tr>
                      ))}
                      {(deliveries[webhook.id] ?? []).length === 0 && (
                        <tr>
                          <td className="px-4 py-4 text-center text-slate-500" colSpan={5}>
                            No deliveries yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          {webhooks.length === 0 && (
            <div className="card p-6 text-center text-sm text-slate-500">No webhook endpoints yet.</div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
