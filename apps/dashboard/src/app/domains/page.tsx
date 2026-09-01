"use client";

import { useEffect, useState } from "react";
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

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Tracking Domains</h1>
          <p className="mt-1 text-sm text-slate-500">
            Domains start in PENDING verification. Automated DNS verification is a later phase —
            for now this records the domain and its intended status.
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
                <th className="px-4 py-2 font-medium">Hostname</th>
                <th className="px-4 py-2 font-medium">Verification</th>
                <th className="px-4 py-2 font-medium">SSL</th>
                <th className="px-4 py-2 font-medium">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {domains.map((domain) => (
                <tr key={domain.id}>
                  <td className="px-4 py-3 font-medium text-slate-800">{domain.hostname}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${STATUS_STYLES[domain.verificationStatus]}`}>
                      {domain.verificationStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{domain.sslStatus}</td>
                  <td className="px-4 py-3 text-slate-500">{domain.isActive ? "Yes" : "No"}</td>
                </tr>
              ))}
              {domains.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={4}>
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
