import type { PrismaClient, OrganizationRole } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";
import type { CreateOrganizationInput, InviteMemberInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || "org"}-${suffix}`;
}

export async function createOrganization(
  prisma: PrismaClient,
  actorUserId: string,
  input: CreateOrganizationInput,
) {
  const slug = input.slug ?? slugify(input.name);

  const existingSlug = await prisma.organization.findUnique({ where: { slug } });
  if (existingSlug) {
    throw ApiError.conflict(`Organization slug "${slug}" is already taken`);
  }

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { name: input.name, slug } });

    await tx.organizationMember.create({
      data: { userId: actorUserId, organizationId: organization.id, role: "OWNER" },
    });

    await writeAuditLog(tx, {
      organizationId: organization.id,
      actorUserId,
      action: "organization.created",
      entityType: "Organization",
      entityId: organization.id,
    });

    await writeAuditLog(tx, {
      organizationId: organization.id,
      actorUserId,
      action: "organization.member_added",
      entityType: "OrganizationMember",
      entityId: actorUserId,
      metadata: { role: "OWNER" },
    });

    return organization;
  });
}

export async function listOrganizationsForUser(prisma: PrismaClient, userId: string) {
  return prisma.organization.findMany({
    where: { members: { some: { userId } } },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * OWNER is the top of the role hierarchy and must not be grantable or
 * revocable by anyone below it. Without this guard, an ADMIN (who only
 * needs ADMIN to call the member-management routes) could self-promote to
 * OWNER, hand OWNER to an outside account, or demote/remove the real
 * OWNER — a straightforward privilege escalation. Every function that can
 * touch the OWNER role must call this first.
 */
function assertActorCanManageOwnerRole(actorRole: OrganizationRole) {
  if (actorRole !== "OWNER") {
    throw ApiError.forbidden("Only an OWNER can grant, change, or remove the OWNER role");
  }
}

export async function addMember(
  prisma: PrismaClient,
  actorUserId: string,
  actorRole: OrganizationRole,
  organizationId: string,
  input: InviteMemberInput,
) {
  if (input.role === "OWNER") {
    assertActorCanManageOwnerRole(actorRole);
  }

  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    throw ApiError.notFound(
      "No AdstrackIO account exists for that email yet. Ask them to register first.",
    );
  }

  const existingMembership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId } },
  });
  if (existingMembership) {
    throw ApiError.conflict("This user is already a member of the organization");
  }

  return prisma.$transaction(async (tx) => {
    const membership = await tx.organizationMember.create({
      data: { userId: user.id, organizationId, role: input.role },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "organization.member_added",
      entityType: "OrganizationMember",
      entityId: membership.id,
      metadata: { role: input.role, memberEmail: input.email },
    });

    return membership;
  });
}

async function countOwners(
  prisma: PrismaClient,
  organizationId: string,
): Promise<number> {
  return prisma.organizationMember.count({ where: { organizationId, role: "OWNER" } });
}

export async function updateMemberRole(
  prisma: PrismaClient,
  actorUserId: string,
  actorRole: OrganizationRole,
  organizationId: string,
  memberId: string,
  role: OrganizationRole,
) {
  const membership = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId },
  });
  if (!membership) {
    throw ApiError.notFound("Membership not found");
  }

  if (membership.role === "OWNER" || role === "OWNER") {
    assertActorCanManageOwnerRole(actorRole);
  }

  if (membership.role === "OWNER" && role !== "OWNER") {
    const owners = await countOwners(prisma, organizationId);
    if (owners <= 1) {
      throw ApiError.conflict("An organization must always have at least one OWNER");
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.organizationMember.update({
      where: { id: memberId },
      data: { role },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "organization.member_role_changed",
      entityType: "OrganizationMember",
      entityId: memberId,
      metadata: { previousRole: membership.role, newRole: role },
    });

    return updated;
  });
}

export async function removeMember(
  prisma: PrismaClient,
  actorUserId: string,
  actorRole: OrganizationRole,
  organizationId: string,
  memberId: string,
) {
  const membership = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId },
  });
  if (!membership) {
    throw ApiError.notFound("Membership not found");
  }

  if (membership.role === "OWNER") {
    assertActorCanManageOwnerRole(actorRole);

    const owners = await countOwners(prisma, organizationId);
    if (owners <= 1) {
      throw ApiError.conflict("An organization must always have at least one OWNER");
    }
  }

  return prisma.$transaction(async (tx) => {
    await tx.organizationMember.delete({ where: { id: memberId } });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "organization.member_removed",
      entityType: "OrganizationMember",
      entityId: memberId,
    });
  });
}
