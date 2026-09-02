import type { PrismaClient, Prisma } from "@adstrackio/database";
import {
  ApiError,
  InvalidAffiliatePartnerStatusTransitionError,
  assertValidAffiliatePartnerStatusTransition,
  type AffiliatePartnerStatus,
} from "@adstrackio/shared";
import type {
  CreateAffiliatePartnerInput,
  UpdateAffiliatePartnerInput,
} from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

/**
 * Affiliate partner control plane (Phase 9: Affiliate/Partner System) — see
 * docs/architecture/affiliate-partners.md.
 *
 * organizationId is never taken from the request body — only from the
 * authenticated, membership-checked URL path
 * (/organizations/:organizationId/affiliate-partners/...), the same IDOR
 * boundary every other organization-scoped module in this codebase already
 * enforces.
 */

function mapExternalIdConflict(error: unknown, organizationId: string, externalId: string): never {
  if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
    throw ApiError.conflict(
      `An affiliate partner with externalId "${externalId}" already exists in organization ${organizationId}`,
    );
  }
  throw error as Error;
}

export async function createAffiliatePartner(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateAffiliatePartnerInput,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const partner = await tx.affiliatePartner.create({
        data: {
          organizationId,
          name: input.name,
          externalId: input.externalId,
          email: input.email,
          status: input.status,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      await writeAuditLog(tx, {
        organizationId,
        actorUserId,
        action: "affiliate_partner.created",
        entityType: "AffiliatePartner",
        entityId: partner.id,
        metadata: { name: partner.name, status: partner.status },
      });

      return partner;
    });
  } catch (error) {
    if (input.externalId) {
      mapExternalIdConflict(error, organizationId, input.externalId);
    }
    throw error;
  }
}

export async function listAffiliatePartners(prisma: PrismaClient, organizationId: string) {
  return prisma.affiliatePartner.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getAffiliatePartner(
  prisma: PrismaClient,
  organizationId: string,
  affiliatePartnerId: string,
) {
  const partner = await prisma.affiliatePartner.findFirst({
    where: { id: affiliatePartnerId, organizationId },
  });
  if (!partner) {
    throw ApiError.notFound("Affiliate partner not found");
  }
  return partner;
}

export async function updateAffiliatePartner(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  affiliatePartnerId: string,
  input: UpdateAffiliatePartnerInput,
) {
  await getAffiliatePartner(prisma, organizationId, affiliatePartnerId);

  try {
    return await prisma.$transaction(async (tx) => {
      const partner = await tx.affiliatePartner.update({
        where: { id: affiliatePartnerId },
        data: {
          name: input.name,
          externalId: input.externalId,
          email: input.email,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      await writeAuditLog(tx, {
        organizationId,
        actorUserId,
        action: "affiliate_partner.updated",
        entityType: "AffiliatePartner",
        entityId: partner.id,
      });

      return partner;
    });
  } catch (error) {
    if (input.externalId) {
      mapExternalIdConflict(error, organizationId, input.externalId);
    }
    throw error;
  }
}

/**
 * Shared by activateAffiliatePartner/pauseAffiliatePartner/
 * archiveAffiliatePartner. Uses the same `SELECT ... FOR UPDATE` row-lock
 * pattern conversions.service.ts / routing-rules.service.ts settled on
 * (PR #8's review, applied proactively here rather than rediscovering the
 * same conditional-updateMany bug a third time): a conditional-updateMany
 * guarded on "the status I read a moment ago" cannot prove idempotency for
 * two concurrent calls that both want the SAME target status (e.g.
 * activate+activate on a PENDING partner) — exactly one would win the
 * updateMany and the other would incorrectly 409, even though both callers
 * asked for exactly the state the row ends up in. Locking the row first and
 * re-reading its status AFTER the lock is held means the loser of the race
 * observes the winner's already-committed result before deciding, so
 * "already at target" is correctly treated as idempotent success no matter
 * which caller's write physically happened first. The same lock also
 * serializes a concurrent archive against a concurrent
 * assignAffiliatePartnerToCampaign call on the same partner (see that
 * function) — the "archive + assignment" race section 17 of the brief asks
 * for.
 */
async function transitionAffiliatePartnerStatus(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  affiliatePartnerId: string,
  targetStatus: AffiliatePartnerStatus,
  auditAction: string,
) {
  await getAffiliatePartner(prisma, organizationId, affiliatePartnerId);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: AffiliatePartnerStatus }[]>`
      SELECT status FROM affiliate_partners
      WHERE id = ${affiliatePartnerId} AND "organizationId" = ${organizationId}
      FOR UPDATE
    `;
    const currentStatus = locked[0]?.status;
    if (!currentStatus) {
      throw ApiError.notFound("Affiliate partner not found");
    }

    if (currentStatus === targetStatus) {
      return tx.affiliatePartner.findUniqueOrThrow({ where: { id: affiliatePartnerId } });
    }

    try {
      assertValidAffiliatePartnerStatusTransition(currentStatus, targetStatus);
    } catch (error) {
      if (error instanceof InvalidAffiliatePartnerStatusTransitionError) {
        throw ApiError.conflict(error.message);
      }
      throw error;
    }

    const updated = await tx.affiliatePartner.update({
      where: { id: affiliatePartnerId },
      data: { status: targetStatus },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: auditAction,
      entityType: "AffiliatePartner",
      entityId: affiliatePartnerId,
      metadata: { from: currentStatus, to: targetStatus },
    });

    return updated;
  });
}

export function activateAffiliatePartner(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  affiliatePartnerId: string,
) {
  return transitionAffiliatePartnerStatus(
    prisma,
    actorUserId,
    organizationId,
    affiliatePartnerId,
    "ACTIVE",
    "affiliate_partner.activated",
  );
}

export function pauseAffiliatePartner(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  affiliatePartnerId: string,
) {
  return transitionAffiliatePartnerStatus(
    prisma,
    actorUserId,
    organizationId,
    affiliatePartnerId,
    "PAUSED",
    "affiliate_partner.paused",
  );
}

export function archiveAffiliatePartner(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  affiliatePartnerId: string,
) {
  return transitionAffiliatePartnerStatus(
    prisma,
    actorUserId,
    organizationId,
    affiliatePartnerId,
    "ARCHIVED",
    "affiliate_partner.archived",
  );
}
