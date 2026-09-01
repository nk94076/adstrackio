"use client";

import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/lib/auth-context";

export default function SettingsPage() {
  const { user, memberships, activeOrganizationId } = useAuth();
  const activeMembership = memberships.find((m) => m.organization.id === activeOrganizationId);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">Account and organization details.</p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Account</h2>
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Name</dt>
              <dd className="font-medium text-slate-800">{user?.name}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium text-slate-800">{user?.email}</dd>
            </div>
          </dl>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Active organization</h2>
          {activeMembership ? (
            <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Name</dt>
                <dd className="font-medium text-slate-800">
                  {activeMembership.organization.name}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Slug</dt>
                <dd className="font-medium text-slate-800">{activeMembership.organization.slug}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Your role</dt>
                <dd className="font-medium text-slate-800">{activeMembership.role}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              No active organization selected. Choose one from the top-right switcher.
            </p>
          )}
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Coming in later phases</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-500">
            <li>Billing and plan management</li>
            <li>API key management (API + Integrations phase)</li>
            <li>Notification preferences</li>
            <li>Granular per-resource permissions</li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
