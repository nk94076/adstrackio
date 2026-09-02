"use client";

import React, { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { TrackingDomain } from "@/lib/types";

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700",
  VERIFIED: "bg-green-50 text-green-700",
  FAILED: "bg-red-50 text-red-700",
};

export default function DomainsPage() {
  const { activeOrganizationId } = useAuth();
  const [domains, setDomains] = useState<TrackingDomain[]>([]);
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load(organizationId: string) {
    const data = await apiFetch<{ domains: TrackingDomain[] }>(
      `/api/v1/organizations/${organizationId}/domains`,
    );
    setDomains(data.domains);
  }

  useEffect(() => {
    if (activeOrganizationId) void load(activeOrganizationId);
  }, [activeOrganizationId]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/domains`, {
        method: "POST",
        body: JSON.stringify({ hostname }),
      });
      setHostname("");
      await load(activeOrganizationId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create domain");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(domainId: string, action: "verify" | "activate" | "deactivate") {
    if (!activeOrganizationId) return;
    setError(null);
    setPendingActionId(domainId);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/domains/${domainId}/${action}`,
        { method: "POST" },
      );
      await load(activeOrganizationId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : `Failed to ${action} domain`);
    } finally {
      setPendingActionId(null);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Tracking Domains</h1>
          <p className="mt-1 text-sm text-slate-500">
            Domains start PENDING. Add a DNS TXT record to prove ownership, then Verify and
            Activate. A domain can never become active without a real, server-checked DNS
            verification — see docs/compliance/google-transparent-tracker.md for what a verified
            domain is (and isn&apos;t yet) used for.
          </p>
        </div>

        <div className="card p-6">
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="label" htmlFor="hostname">
                Hostname
              </label>
              <input
                id="hostname"
                className="input"
                placeholder="track.example.com"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={submitting || !activeOrganizationId}>
              Add domain
            </button>
          </form>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Domain</th>
                <th className="px-4 py-2 font-medium">Verification</th>
                <th className="px-4 py-2 font-medium">SSL</th>
                <th className="px-4 py-2 font-medium">Active</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {domains.map((domain) => (
                <React.Fragment key={domain.id}>
                  <tr>
                    <td className="px-4 py-3 font-medium text-slate-800">{domain.hostname}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${STATUS_STYLES[domain.verificationStatus]}`}>
                        {domain.verificationStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{domain.sslStatus}</td>
                    <td className="px-4 py-3 text-slate-500">{domain.isActive ? "Yes" : "No"}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(domain.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() =>
                            setExpandedId(expandedId === domain.id ? null : domain.id)
                          }
                        >
                          View details
                        </button>
                        {domain.verificationStatus !== "VERIFIED" && !domain.isActive && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={pendingActionId === domain.id}
                            onClick={() => handleAction(domain.id, "verify")}
                          >
                            Verify
                          </button>
                        )}
                        {!domain.isActive && domain.verificationStatus === "VERIFIED" && (
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={pendingActionId === domain.id}
                            onClick={() => handleAction(domain.id, "activate")}
                          >
                            Activate
                          </button>
                        )}
                        {domain.isActive && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={pendingActionId === domain.id}
                            onClick={() => handleAction(domain.id, "deactivate")}
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === domain.id && (
                    <tr>
                      <td colSpan={6} className="bg-slate-50 px-4 py-4">
                        {domain.verificationInstructions ? (
                          <div className="space-y-1 text-sm text-slate-600">
                            <p className="font-medium text-slate-700">
                              Create this DNS TXT record to verify ownership:
                            </p>
                            <p>
                              <span className="text-slate-500">Name: </span>
                              <code className="rounded bg-white px-1.5 py-0.5">
                                {domain.verificationInstructions.recordName}
                              </code>
                            </p>
                            <p>
                              <span className="text-slate-500">Type: </span>
                              <code className="rounded bg-white px-1.5 py-0.5">
                                {domain.verificationInstructions.recordType}
                              </code>
                            </p>
                            <p>
                              <span className="text-slate-500">Value: </span>
                              <code className="rounded bg-white px-1.5 py-0.5">
                                {domain.verificationInstructions.recordValue}
                              </code>
                            </p>
                            <p className="text-xs text-slate-400">
                              DNS changes can take time to propagate. Click Verify again after the
                              record is live.
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm text-slate-500">
                            This domain is already verified — no DNS instructions needed.
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {domains.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={6}>
                    No tracking domains yet.
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
