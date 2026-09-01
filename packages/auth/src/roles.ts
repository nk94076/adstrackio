export const ORGANIZATION_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Simple linear role hierarchy for Phase 1. Higher-privilege roles satisfy
 * any check that a lower-privilege role would satisfy. This intentionally
 * stays a flat ranking rather than a full permissions matrix — expand to
 * granular permissions only when a real use case needs it.
 */
const ROLE_RANK: Record<OrganizationRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/** Returns true if `role` meets or exceeds `minimumRole` in privilege. */
export function hasMinimumRole(role: OrganizationRole, minimumRole: OrganizationRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimumRole];
}

export function isValidOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}
