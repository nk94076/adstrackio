"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { ReferralConfiguration, ReferralConfigurationType } from "@/lib/types";

const TYPE_LABELS: Record<ReferralConfigurationType, string> = {
  NORMAL: "Normal",
  HIDE: "Hide",
  CUSTOM_PARTNER_ATTRIBUTION: "Custom Partner Attribution",
};

export default function ReferralsPage() {
  const { activeOrganizationId, memberships } = useAuth();
  const [configurations, setConfigurations] = useState<ReferralConfiguration[]>([]);
  const [type, setType] = useState<ReferralConfigurationType>("NORMAL");
  const [customReferrerValue, setCustomReferrerValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [evidenceUrl, setEvidenceUrl] = useState<Record<string, string>>({});
  const [rejectionReason, setRejectionReason] = useState<Record<string, string>>({});

  const isAdmin =
    memberships.find((m) => m.organization.id === activeOrganizationId)?.role === "OWNER" ||
    memberships.find((m) => m.organization.id === activeOrganizationId)?.role === "ADMIN";

  async function load(organizationId: string) {
    const data = await apiFetch<{ referralConfigurations: ReferralConfiguration[] }>(
      `/api/v1/organizations/${organizationId}/referral-configurations`,
    );
    setConfigurations(data.referralConfigurations);
  }

  useEffect(() => {
    if (activeOrganizationId) void load(activeOrganizationId);
  }, [activeOrganizationId]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/referral-configurations`, {
        method: "POST",
        body: JSON.stringify({
          type,
          customReferrerValue:
            type === "CUSTOM_PARTNER_ATTRIBUTION" ? customReferrerValue : undefined,
        }),
      });
      setCustomReferrerValue("");
      await load(activeOrganizationId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create configuration");
    }
  }

  async function handleActivate(configurationId: string) {
    if (!activeOrganizationId) return;
    setError(null);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/referral-configurations/${configurationId}/activate`,
        { method: "POST" },
      );
      await load(activeOrganizationId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to activate configuration");
    }
  }

  async function handleSubmitProof(configurationId: string) {
    if (!activeOrganizationId) return;
    setError(null);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/referral-configurations/${configurationId}/proofs`,
        {
          method: "POST",
          body: JSON.stringify({ evidenceUrl: evidenceUrl[configurationId] }),
        },
      );
      setEvidenceUrl((prev) => ({ ...prev, [configurationId]: "" }));
      await load(activeOrganizationId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to submit proof");
    }
  }

  async function handleReview(
    configurationId: string,
    proofId: string,
    decision: "APPROVED" | "REJECTED",
  ) {
    if (!activeOrganizationId) return;
    setError(null);
    try {
      await apiFetch(
        `/api/v1/organizations/${activeOrganizationId}/referral-configurations/${configurationId}/proofs/${proofId}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            rejectionReason: decision === "REJECTED" ? rejectionReason[proofId] : undefined,
          }),
        },
      );
      await load(activeOrganizationId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to review proof");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Referral Configurations</h1>
          <p className="mt-1 text-sm text-slate-500">
            Controls how AdstrackIO&apos;s internal attribution pipeline labels traffic. A Custom
            Partner Attribution configuration cannot be activated until its evidence is approved —
            this is enforced by the API, not only this screen.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">New configuration</h2>
          <form onSubmit={handleCreate} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <select
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as ReferralConfigurationType)}
            >
              {(Object.keys(TYPE_LABELS) as ReferralConfigurationType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            {type === "CUSTOM_PARTNER_ATTRIBUTION" && (
              <input
                className="input sm:col-span-2"
                placeholder="Declared partner attribution value"
                value={customReferrerValue}
                onChange={(e) => setCustomReferrerValue(e.target.value)}
                required
              />
            )}
            <button type="submit" className="btn-primary" disabled={!activeOrganizationId}>
              Create
            </button>
          </form>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        <div className="space-y-4">
          {configurations.map((config) => {
            const hasApprovedProof = config.proofs.some((p) => p.reviewStatus === "APPROVED");
            const canActivate =
              config.status === "INACTIVE" &&
              (config.type !== "CUSTOM_PARTNER_ATTRIBUTION" || hasApprovedProof);

            return (
              <div key={config.id} className="card p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-slate-800">{TYPE_LABELS[config.type]}</p>
                    {config.customReferrerValue && (
                      <p className="text-sm text-slate-500">{config.customReferrerValue}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`badge ${
                        config.status === "ACTIVE"
                          ? "bg-green-50 text-green-700"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {config.status}
                    </span>
                    {config.status === "INACTIVE" && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!canActivate}
                        title={
                          !canActivate && config.type === "CUSTOM_PARTNER_ATTRIBUTION"
                            ? "Requires an approved referral proof"
                            : undefined
                        }
                        onClick={() => handleActivate(config.id)}
                      >
                        Activate
                      </button>
                    )}
                  </div>
                </div>

                {config.type === "CUSTOM_PARTNER_ATTRIBUTION" && (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <p className="text-xs font-semibold uppercase text-slate-500">
                      Attribution proof
                    </p>

                    <ul className="mt-2 space-y-2 text-sm">
                      {config.proofs.map((proof) => (
                        <li key={proof.id} className="rounded-lg bg-slate-50 p-3">
                          <div className="flex items-center justify-between">
                            <a
                              href={proof.evidenceUrl ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate text-brand-600 hover:underline"
                            >
                              {proof.evidenceUrl ?? proof.documentReference}
                            </a>
                            <span
                              className={`badge ${
                                proof.reviewStatus === "APPROVED"
                                  ? "bg-green-50 text-green-700"
                                  : proof.reviewStatus === "REJECTED"
                                    ? "bg-red-50 text-red-700"
                                    : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              {proof.reviewStatus}
                            </span>
                          </div>
                          {proof.rejectionReason && (
                            <p className="mt-1 text-xs text-red-600">{proof.rejectionReason}</p>
                          )}
                          {isAdmin && proof.reviewStatus === "PENDING" && (
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => handleReview(config.id, proof.id, "APPROVED")}
                              >
                                Approve
                              </button>
                              <input
                                className="input"
                                placeholder="Rejection reason"
                                value={rejectionReason[proof.id] ?? ""}
                                onChange={(e) =>
                                  setRejectionReason((prev) => ({
                                    ...prev,
                                    [proof.id]: e.target.value,
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => handleReview(config.id, proof.id, "REJECTED")}
                              >
                                Reject
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                      {config.proofs.length === 0 && (
                        <li className="text-slate-500">No proof submitted yet.</li>
                      )}
                    </ul>

                    <div className="mt-3 flex items-end gap-2">
                      <input
                        className="input"
                        placeholder="Evidence URL"
                        value={evidenceUrl[config.id] ?? ""}
                        onChange={(e) =>
                          setEvidenceUrl((prev) => ({ ...prev, [config.id]: e.target.value }))
                        }
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => handleSubmitProof(config.id)}
                      >
                        Submit proof
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {configurations.length === 0 && (
            <p className="text-sm text-slate-500">No referral configurations yet.</p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
