"use client";

import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/lib/auth-context";

const PLACEHOLDER_METRICS = [
  { label: "Clicks (24h)", value: "—" },
  { label: "Conversions (24h)", value: "—" },
  { label: "Active campaigns", value: "—" },
  { label: "Bot traffic rate", value: "—" },
];

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <h1 className="text-xl font-semibold text-slate-900">
          Welcome back{user ? `, ${user.name}` : ""}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          This is the Phase 1 foundation shell. Click, conversion, and bot-traffic analytics are
          not implemented yet — they arrive in later phases (Click Analytics, Bot Detection
          Integration, Attribution & Advanced Reporting).
        </p>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLACEHOLDER_METRICS.map((metric) => (
            <div key={metric.label} className="card p-5">
              <p className="text-sm text-slate-500">{metric.label}</p>
              <p className="mt-2 text-2xl font-semibold text-slate-400">{metric.value}</p>
              <p className="mt-1 text-xs text-slate-400">Not yet available</p>
            </div>
          ))}
        </div>

        <div className="mt-8 card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Get started</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-600">
            <li>Create or select an organization from the top-right switcher.</li>
            <li>Add a tracking domain under Domains.</li>
            <li>Create a Destination and a Campaign, then a Tracking Link.</li>
            <li>Configure referral attribution under Referrals, if needed.</li>
          </ol>
        </div>
      </div>
    </AppShell>
  );
}
