"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "▦" },
  { href: "/campaigns", label: "Campaigns", icon: "◉" },
  { href: "/tracking-links", label: "Tracking links", icon: "↗" },
  { href: "/analytics", label: "Analytics", icon: "◌" },
  { href: "/reports", label: "Reports", icon: "▤" },
];

const MANAGE_ITEMS = [
  { href: "/domains", label: "Domains" },
  { href: "/affiliate-partners", label: "Partners" },
  { href: "/conversions", label: "Conversions" },
  { href: "/webhooks", label: "Integrations" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, memberships, activeOrganizationId, setActiveOrganizationId, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading workspace…</div>;
  if (!user) return null;

  const link = (href: string, label: string, icon?: string) => {
    const active = pathname === href || pathname?.startsWith(`${href}/`);
    return <Link key={href} href={href} className={`nav-link ${active ? "nav-link-active" : ""}`}>
      {icon && <span className="w-5 text-center text-base">{icon}</span>}<span>{label}</span>
    </Link>;
  };

  return <div className="min-h-screen bg-[#f6f7fb]">
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-[246px] flex-col bg-[#171a2b] text-slate-300 lg:flex">
      <div className="flex h-[72px] items-center gap-3 border-b border-white/10 px-6">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#7866f5] text-lg font-black text-white">A</div>
        <div><p className="font-semibold tracking-tight text-white">Adstrack<span className="text-[#9b8eff]">IO</span></p><p className="text-[10px] uppercase tracking-[.18em] text-slate-500">Performance cloud</p></div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-5">
        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-500">Workspace</p>
        {NAV_ITEMS.map((item) => link(item.href, item.label, item.icon))}
        <p className="mb-2 mt-7 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-500">Manage</p>
        {MANAGE_ITEMS.map((item) => link(item.href, item.label))}
        <p className="mb-2 mt-7 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-500">Account</p>
        {link("/organizations", "Organization")}{link("/settings", "Settings")}{link("/api-keys", "API keys")}{link("/audit-logs", "Activity log")}
      </nav>
      <div className="m-3 rounded-xl bg-white/5 p-3">
        <p className="truncate text-sm font-medium text-white">{user.name}</p><p className="truncate text-xs text-slate-500">{user.email}</p>
        <button type="button" onClick={async () => { await logout(); router.replace("/login"); }} className="mt-3 text-xs font-semibold text-[#aea3ff] hover:text-white">Sign out →</button>
      </div>
    </aside>
    <div className="lg:pl-[246px]">
      <header className="sticky top-0 z-10 flex h-[72px] items-center justify-between border-b border-[#e7e8ef] bg-white/95 px-5 backdrop-blur lg:px-8">
        <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-[#171a2b] font-bold text-white lg:hidden">A</div><span className="hidden text-sm font-medium text-slate-400 sm:block">Performance marketing workspace</span></div>
        <div className="flex items-center gap-3"><button className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-500" aria-label="Notifications">♧</button><select aria-label="Organization" className="h-9 max-w-44 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none" value={activeOrganizationId ?? ""} onChange={(event) => setActiveOrganizationId(event.target.value)}>{memberships.length === 0 && <option value="">No organizations</option>}{memberships.map((membership) => <option key={membership.organization.id} value={membership.organization.id}>{membership.organization.name}</option>)}</select><div className="grid h-9 w-9 place-items-center rounded-full bg-[#eeeaff] text-sm font-bold text-[#6655dd]">{user.name.slice(0, 1).toUpperCase()}</div></div>
      </header>
      <main className="p-5 lg:p-8">{children}</main>
    </div>
  </div>;
}
