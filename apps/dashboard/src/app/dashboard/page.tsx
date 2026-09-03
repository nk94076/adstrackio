"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { Campaign, TrackingDomain } from "@/lib/types";

const MetricIcon = ({ children }: { children: React.ReactNode }) => <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0edff] text-lg text-[#6e5bea]">{children}</span>;

export default function DashboardPage() {
  const { user, activeOrganizationId } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]); const [domains, setDomains] = useState<TrackingDomain[]>([]);
  useEffect(() => { if (!activeOrganizationId) return; void Promise.all([apiFetch<{ campaigns: Campaign[] }>(`/api/v1/organizations/${activeOrganizationId}/campaigns`), apiFetch<{ domains: TrackingDomain[] }>(`/api/v1/organizations/${activeOrganizationId}/domains`)]).then(([c, d]) => { setCampaigns(c.campaigns); setDomains(d.domains); }).catch(() => undefined); }, [activeOrganizationId]);
  const active = useMemo(() => campaigns.filter((c) => c.status === "ACTIVE").length, [campaigns]);
  const verified = useMemo(() => domains.filter((d) => d.isActive && d.verificationStatus === "VERIFIED").length, [domains]);
  return <AppShell><div className="mx-auto max-w-[1440px]">
    <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end"><div><p className="eyebrow">Overview</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-[#202339]">Good morning, {user?.name?.split(" ")[0] ?? "there"} <span>👋</span></h1><p className="mt-2 text-sm text-slate-500">Here&apos;s what&apos;s happening across your performance campaigns.</p></div><Link href="/campaigns" className="btn-violet">+ Create campaign</Link></div>
    <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="metric-card"><MetricIcon>◎</MetricIcon><p className="metric-label">Active campaigns</p><p className="metric-value">{active}</p><p className="metric-detail">of {campaigns.length} total campaigns</p></div>
      <div className="metric-card"><MetricIcon>⌁</MetricIcon><p className="metric-label">Tracking domains</p><p className="metric-value">{verified}</p><p className="metric-detail">verified and active</p></div>
      <div className="metric-card"><MetricIcon>↗</MetricIcon><p className="metric-label">Campaign status</p><p className="metric-value">{campaigns.length ? "Ready" : "Start"}</p><p className="metric-detail">{campaigns.length ? "Manage campaigns below" : "Create your first campaign"}</p></div>
      <div className="metric-card"><MetricIcon>◌</MetricIcon><p className="metric-label">Performance data</p><p className="metric-value text-xl">Analytics</p><p className="metric-detail">View click and conversion trends</p></div>
    </section>
    <section className="mt-7 grid gap-6 xl:grid-cols-[1.6fr_1fr]"><div className="panel p-6"><div className="flex items-center justify-between"><div><h2 className="panel-title">Campaign health</h2><p className="panel-copy">Your campaign portfolio at a glance</p></div><Link href="/campaigns" className="text-sm font-semibold text-[#6958df]">View all →</Link></div><div className="mt-6 space-y-3">{campaigns.slice(0, 4).map((campaign) => <Link key={campaign.id} href={`/campaigns/${campaign.id}`} className="flex items-center justify-between rounded-xl border border-slate-100 p-4 transition hover:border-[#d8d2ff] hover:bg-[#fbfaff]"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-sm text-slate-500">◉</span><div><p className="font-semibold text-slate-700">{campaign.name}</p><p className="mt-0.5 text-xs text-slate-400">Created {new Date(campaign.createdAt).toLocaleDateString()}</p></div></div><span className={`status-pill status-${campaign.status.toLowerCase()}`}>{campaign.status}</span></Link>)}{campaigns.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 py-11 text-center"><p className="font-medium text-slate-600">No campaigns yet</p><p className="mt-1 text-sm text-slate-400">Build your first tracking flow in minutes.</p><Link className="mt-4 inline-block text-sm font-semibold text-[#6958df]" href="/campaigns">Create a campaign →</Link></div>}</div></div>
    <div className="panel overflow-hidden"><div className="bg-[#24213c] p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[.16em] text-[#b9b0ff]">Setup checklist</p><h2 className="mt-2 text-lg font-semibold">Get ready to track</h2><p className="mt-2 text-sm leading-6 text-slate-300">Complete these essentials to start sending traffic through AdstrackIO.</p></div><div className="space-y-1 p-4">{[[verified > 0, "Connect a tracking domain", "/domains"], [campaigns.length > 0, "Create a campaign", "/campaigns"], [false, "Generate a tracking link", "/tracking-links"]].map(([done, text, href]) => <Link href={href as string} key={text as string} className="flex items-center gap-3 rounded-lg p-3 hover:bg-slate-50"><span className={`grid h-5 w-5 place-items-center rounded-full text-xs ${done ? "bg-[#6e5bea] text-white" : "border border-slate-300 text-transparent"}`}>✓</span><span className={`text-sm ${done ? "text-slate-400 line-through" : "font-medium text-slate-700"}`}>{text as string}</span><span className="ml-auto text-slate-400">→</span></Link>)}</div></div></section>
  </div></AppShell>;
}
