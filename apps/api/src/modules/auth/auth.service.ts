import type { PrismaClient } from "@adstrackio/database";
import { hashPassword, verifyPassword } from "@adstrackio/auth";
import { ApiError } from "@adstrackio/shared";
import type { RegisterInput, LoginInput } from "@adstrackio/validation";
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

export interface RegisteredAccount {
  user: { id: string; email: string; name: string };
  organizationId: string | null;
}

/**
 * Registers a new user. If `organizationName` is supplied, also creates a
 * new organization and makes the user its OWNER — this is the common
 * "sign up and start a workspace" flow. Otherwise the user is created
 * without any organization membership (e.g. they will join one via invite
 * later, once invites exist).
 */
export async function registerUser(
  prisma: PrismaClient,
  input: RegisterInput,
): Promise<RegisteredAccount> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw ApiError.conflict("An account with this email already exists");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: input.email, passwordHash, name: input.name },
    });

    await writeAuditLog(tx, {
      actorUserId: user.id,
      action: "user.registered",
      entityType: "User",
      entityId: user.id,
    });

    let organizationId: string | null = null;

    if (input.organizationName) {
      const organization = await tx.organization.create({
        data: { name: input.organizationName, slug: slugify(input.organizationName) },
      });

      await tx.organizationMember.create({
        data: { userId: user.id, organizationId: organization.id, role: "OWNER" },
      });

      await writeAuditLog(tx, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: "organization.created",
        entityType: "Organization",
        entityId: organization.id,
      });

      await writeAuditLog(tx, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: "organization.member_added",
        entityType: "OrganizationMember",
        entityId: user.id,
        metadata: { role: "OWNER" },
      });

      organizationId = organization.id;
    }

    return { user, organizationId };
  });

  return {
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
    organizationId: result.organizationId,
  };
}

export async function authenticateUser(
  prisma: PrismaClient,
  input: LoginInput,
): Promise<{ id: string; email: string; name: string }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Constant-shape response: don't reveal whether the email exists.
  if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
    throw ApiError.unauthenticated("Invalid email or password");
  }

  await writeAuditLog(prisma, {
    actorUserId: user.id,
    action: "user.login",
    entityType: "User",
    entityId: user.id,
  });

  return { id: user.id, email: user.email, name: user.name };
}
