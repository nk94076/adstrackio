"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch } from "./api-client";
import type { Membership, User } from "./types";

const ACTIVE_ORG_STORAGE_KEY = "adstrackio.activeOrganizationId";

interface AuthState {
  user: User | null;
  memberships: Membership[];
  loading: boolean;
  activeOrganizationId: string | null;
  setActiveOrganizationId: (id: string) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ user: User; memberships: Membership[] }>("/api/v1/auth/me");
      setUser(data.user);
      setMemberships(data.memberships);
    } catch {
      setUser(null);
      setMemberships([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stored =
      typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY) : null;
    if (stored) {
      setActiveOrganizationIdState(stored);
    }
  }, [refresh]);

  useEffect(() => {
    if (!activeOrganizationId && memberships.length > 0) {
      setActiveOrganizationIdState(memberships[0]!.organization.id);
    }
  }, [memberships, activeOrganizationId]);

  const setActiveOrganizationId = useCallback((id: string) => {
    setActiveOrganizationIdState(id);
    window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, id);
  }, []);

  const logout = useCallback(async () => {
    await apiFetch("/api/v1/auth/logout", { method: "POST" });
    setUser(null);
    setMemberships([]);
  }, []);

  const value = useMemo(
    () => ({ user, memberships, loading, activeOrganizationId, setActiveOrganizationId, refresh, logout }),
    [user, memberships, loading, activeOrganizationId, setActiveOrganizationId, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
