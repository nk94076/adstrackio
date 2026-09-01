import type { PrismaClient } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";
import type { CreateTrackingDomainInput, UpdateTrackingDomainInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

/**
 * Verification is a foundation-only concept in Phase 1: every domain is
 * created PENDING. Real DNS/TXT-record verification is a later phase; this
 * service intentionally does not fake a "verified" result.
 */
export async function createTrackingDomain(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateTrackingDomainInput,
) {
  const existing = await prisma.trackingDomain.findUnique({ where: { hostname: input.hostname } });
  if (existing) {
    throw ApiError.conflict(`Hostname "${input.hostname}" is already registered`);
  }

  return prisma.$transaction(async (tx) => {
    const domain = await tx.trackingDomain.create({
      data: { organizationId, hostname: input.hostname },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "domain.created",
      entityType: "TrackingDomain",
      entityId: domain.id,
      metadata: { hostname: domain.hostname },
    });

    return domain;
  });
}

export async function listTrackingDomains(prisma: PrismaClient, organizationId: string) {
  return prisma.trackingDomain.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getTrackingDomain(
  prisma: PrismaClient,
  organizationId: string,
  domainId: string,
) {
  const domain = await prisma.trackingDomain.findFirst({
    where: { id: domainId, organizationId },
  });
  if (!domain) {
    throw ApiError.notFound("Tracking domain not found");
  }
  return domain;
}

export async function updateTrackingDomain(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  domainId: string,
  input: UpdateTrackingDomainInput,
) {
  await getTrackingDomain(prisma, organizationId, domainId);

  return prisma.$transaction(async (tx) => {
    const domain = await tx.trackingDomain.update({
      where: { id: domainId },
      data: { isActive: input.isActive },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "domain.updated",
      entityType: "TrackingDomain",
      entityId: domain.id,
      metadata: { isActive: input.isActive },
    });

    return domain;
  });
}
