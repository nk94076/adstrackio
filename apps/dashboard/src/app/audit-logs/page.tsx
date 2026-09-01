"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { AuditLog } from "@/lib/types";

export default function AuditLogsPage() {
  const { activeOrganizationId } = useAuth();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeOrganizationId) return;
    setError(null);
    apiFetch<{ auditLogs: AuditLog[] }>(`/api/v1/organizations/${activeOrganizationId}/audit-logs`)
      .then((data) => setLogs(data.auditLogs))
      .catch((err) => {
        setError(
          err instanceof ApiClientError
            ? err.message
            : "Failed to load audit logs (ADMIN role required)",
        );
      });
  }, [activeOrganizationId]);

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Audit Logs</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every administrative and configuration change in this organization, in order.
            Visible to ADMIN and OWNER roles.
          </p>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Entity</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-800">{log.action}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {log.entityType} · {log.entityId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{log.actor?.email ?? "system"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && !error && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500" colSpan={4}>
                    No audit log entries yet.
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
