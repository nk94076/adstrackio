"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { ApiKey, ApiKeyScope } from "@/lib/types";

const ALL_SCOPES: ApiKeyScope[] = ["READ", "WRITE", "REPORTS", "CONVERSIONS"];

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * API key management (Phase 11) — ADMIN/OWNER only, matching
 * apps/api/src/modules/api-keys/api-keys.routes.ts's RBAC exactly. The
 * raw secret is shown exactly once, right after create/rotate, in a
 * dismissible banner — never persisted client-side beyond this session's
 * component state, and never requested again afterward (the API itself
 * never returns it again either).
 */
export default function ApiKeysPage() {
  const { activeOrganizationId, memberships } = useAuth();
  const currentRole = useMemo(
    () => memberships.find((m) => m.organization.id === activeOrganizationId)?.role ?? null,
    [memberships, activeOrganizationId],
  );
  const canManage = currentRole === "OWNER" || currentRole === "ADMIN";

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["READ"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ name: string; key: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (organizationId: string) => {
    const res = await apiFetch<{ apiKeys: ApiKey[] }>(`/api/v1/organizations/${organizationId}/api-keys`);
    setApiKeys(res.apiKeys);
  }, []);

  useEffect(() => {
    if (activeOrganizationId) void load(activeOrganizationId);
  }, [activeOrganizationId, load]);

  function toggleScope(scope: ApiKeyScope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId || scopes.length === 0) return;
    setCreateError(null);
    try {
      const res = await apiFetch<{ apiKey: ApiKey }>(`/api/v1/organizations/${activeOrganizationId}/api-keys`, {
        method: "POST",
        body: JSON.stringify({
          name,
          scopes,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        }),
      });
      setRevealedKey({ name: res.apiKey.name, key: res.apiKey.key! });
      setName("");
      setScopes(["READ"]);
      setExpiresAt("");
      await load(activeOrganizationId);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create API key");
    }
  }

  async function handleRotate(apiKeyId: string) {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingId(apiKeyId);
    try {
      const res = await apiFetch<{ apiKey: ApiKey }>(
        `/api/v1/organizations/${activeOrganizationId}/api-keys/${apiKeyId}/rotate`,
        { method: "POST" },
      );
      setRevealedKey({ name: res.apiKey.name, key: res.apiKey.key! });
      await load(activeOrganizationId);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Failed to rotate API key");
    } finally {
      setPendingId(null);
    }
  }

  async function handleRevoke(apiKeyId: string) {
    if (!activeOrganizationId) return;
    setActionError(null);
    setPendingId(apiKeyId);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/api-keys/${apiKeyId}/revoke`, {
        method: "POST",
      });
      await load(activeOrganizationId);
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Failed to revoke API key");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">API Keys</h1>
          <p className="mt-1 text-sm text-slate-500">
            Organization-scoped credentials for the public API (<code>/api/v1</code>). A key&apos;s raw
            secret is shown exactly once, right after it&apos;s created or rotated — AdstrackIO never
            stores it and cannot show it to you again. See <code>docs/api/authentication.md</code> for
            how to use it.
          </p>
        </div>

        {revealedKey && (
          <div className="card border-2 border-amber-300 bg-amber-50 p-6">
            <h2 className="text-sm font-semibold text-amber-900">
              Copy this key now — &quot;{revealedKey.name}&quot;
            </h2>
            <p className="mt-1 text-xs text-amber-800">
              This is the only time this secret will ever be shown. Store it somewhere safe.
            </p>
            <code className="mt-3 block break-all rounded-lg bg-white px-3 py-2 text-sm text-slate-800">
              {revealedKey.key}
            </code>
            <button type="button" className="btn-secondary mt-3" onClick={() => setRevealedKey(null)}>
              I&apos;ve copied it — dismiss
            </button>
          </div>
        )}

        {!canManage && (
          <div className="card p-4 text-sm text-slate-600">
            Only OWNER/ADMIN members can view or manage this organization&apos;s API keys.
          </div>
        )}

        {canManage && (
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-slate-800">Create API key</h2>
            <form onSubmit={handleCreate} className="mt-3 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  className="input"
                  placeholder="Key name (e.g. Reporting integration)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
                <input
                  className="input"
                  type="datetime-local"
                  placeholder="Expires at (optional)"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Scopes</label>
                <div className="mt-1 flex flex-wrap gap-3">
                  {ALL_SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-1.5 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      {scope}
                    </label>
                  ))}
                </div>
              </div>
              <button type="submit" className="btn-primary" disabled={scopes.length === 0}>
                Create key
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
                <th className="px-4 py-2 font-medium">Prefix</th>
                <th className="px-4 py-2 font-medium">Scopes</th>
                <th className="px-4 py-2 font-medium">Last used</th>
                <th className="px-4 py-2 font-medium">Expires</th>
                <th className="px-4 py-2 font-medium">Status</th>
                {canManage && <th className="px-4 py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {apiKeys.map((key) => (
                <tr key={key.id}>
                  <td className="px-4 py-3 font-medium text-slate-800">{key.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">atk_live_{key.keyPrefix}…</td>
                  <td className="px-4 py-3 text-slate-600">{key.scopes.join(", ")}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(key.lastUsedAt)}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(key.expiresAt)}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${key.revokedAt ? "bg-slate-100 text-slate-500" : "bg-green-50 text-green-700"}`}>
                      {key.revokedAt ? "Revoked" : "Active"}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3">
                      {!key.revokedAt && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={pendingId === key.id}
                            onClick={() => handleRotate(key.id)}
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={pendingId === key.id}
                            onClick={() => handleRevoke(key.id)}
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {apiKeys.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={canManage ? 7 : 6}>
                    No API keys yet.
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
