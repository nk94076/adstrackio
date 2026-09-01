"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import type { Organization, OrganizationMember, OrganizationRole } from "@/lib/types";

export default function OrganizationsPage() {
  const { memberships, refresh, activeOrganizationId, setActiveOrganizationId } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<OrganizationRole>("VIEWER");
  const [memberError, setMemberError] = useState<string | null>(null);

  async function loadOrganizations() {
    const data = await apiFetch<{ organizations: Organization[] }>("/api/v1/organizations");
    setOrganizations(data.organizations);
  }

  async function loadMembers(organizationId: string) {
    const data = await apiFetch<{ members: OrganizationMember[] }>(
      `/api/v1/organizations/${organizationId}/members`,
    );
    setMembers(data.members);
  }

  useEffect(() => {
    void loadOrganizations();
  }, []);

  useEffect(() => {
    if (activeOrganizationId) {
      void loadMembers(activeOrganizationId);
    }
  }, [activeOrganizationId]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await apiFetch("/api/v1/organizations", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      await loadOrganizations();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  }

  async function handleAddMember(event: React.FormEvent) {
    event.preventDefault();
    if (!activeOrganizationId) return;
    setMemberError(null);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: memberEmail, role: memberRole }),
      });
      setMemberEmail("");
      await loadMembers(activeOrganizationId);
    } catch (err) {
      setMemberError(err instanceof ApiClientError ? err.message : "Failed to add member");
    }
  }

  async function handleRoleChange(memberId: string, role: OrganizationRole) {
    if (!activeOrganizationId) return;
    try {
      await apiFetch(`/api/v1/organizations/${activeOrganizationId}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      await loadMembers(activeOrganizationId);
    } catch (err) {
      setMemberError(err instanceof ApiClientError ? err.message : "Failed to update role");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Organizations</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every user belongs to one or more organizations. Switch the active organization from
            the top-right selector.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-slate-800">Your organizations</h2>
          <ul className="mt-3 divide-y divide-slate-100">
            {organizations.map((org) => (
              <li key={org.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <p className="font-medium text-slate-800">{org.name}</p>
                  <p className="text-slate-500">{org.slug}</p>
                </div>
                {org.id === activeOrganizationId ? (
                  <span className="badge bg-brand-50 text-brand-700">Active</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setActiveOrganizationId(org.id)}
                  >
                    Switch to this org
                  </button>
                )}
              </li>
            ))}
            {organizations.length === 0 && (
              <li className="py-3 text-sm text-slate-500">No organizations yet.</li>
            )}
          </ul>

          <form onSubmit={handleCreate} className="mt-6 flex items-end gap-3">
            <div className="flex-1">
              <label className="label" htmlFor="orgName">
                New organization name
              </label>
              <input
                id="orgName"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={creating}>
              Create
            </button>
          </form>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>

        {activeOrganizationId && (
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-slate-800">
              Members of {memberships.find((m) => m.organization.id === activeOrganizationId)?.organization.name}
            </h2>

            <table className="mt-3 w-full text-left text-sm">
              <thead>
                <tr className="text-slate-500">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {members.map((member) => (
                  <tr key={member.id}>
                    <td className="py-2">{member.user.name}</td>
                    <td className="py-2 text-slate-500">{member.user.email}</td>
                    <td className="py-2">
                      <select
                        className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
                        value={member.role}
                        onChange={(e) =>
                          handleRoleChange(member.id, e.target.value as OrganizationRole)
                        }
                      >
                        {(["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const).map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <form onSubmit={handleAddMember} className="mt-6 flex items-end gap-3">
              <div className="flex-1">
                <label className="label" htmlFor="memberEmail">
                  Add existing user by email
                </label>
                <input
                  id="memberEmail"
                  type="email"
                  className="input"
                  value={memberEmail}
                  onChange={(e) => setMemberEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="memberRole">
                  Role
                </label>
                <select
                  id="memberRole"
                  className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
                  value={memberRole}
                  onChange={(e) => setMemberRole(e.target.value as OrganizationRole)}
                >
                  {(["ADMIN", "MEMBER", "VIEWER"] as const).map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn-primary">
                Add member
              </button>
            </form>
            {memberError && <p className="mt-2 text-sm text-red-600">{memberError}</p>}
          </div>
        )}
      </div>
    </AppShell>
  );
}
