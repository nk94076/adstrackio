import type { PrismaClient } from "@adstrackio/database";
import { ApiError, type AffiliatePartnerStatus } from "@adstrackio/shared";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";
import { getCampaign } from "../campaigns/campaigns.service.js";

/**
 * Campaign <-> AffiliatePartner roster/assignment (Phase 9: Affiliate/
 * Partner System) — the single join table this phase introduces (see
 * AffiliatePartner's schema doc comment for why this is deliberately NOT
 * paired with a second TrackingLinkAffiliatePartner join table). Every
 * route calling into this module is nested under
 * /campaigns/:campaignId/affiliate-partners/... — organizationId and
 * campaignId are always taken from the authenticated URL path, never the
 * request body.
 */

export async function listAffiliatePartnersForCampaign(
  prisma: PrismaClient,
  organizationId: string,
  campaignId: string,
) {
  // Confirms the campaign itself is in-org before listing, so an
  // out-of-org campaignId reports 404 rather than a confusing empty list —
  // the same convention listTrackingLinksForCampaign already established.
  await getCampaign(prisma, organizationId, campaignId);
  return prisma.campaignAffiliatePartner.findMany({
    where: { campaignId, organizationId },
    orderBy: { createdAt: "desc" },
    include: { affiliatePartner: true },
  });
}

/**
 * Assigns a partner to a campaign's roster. Idempotent by design — a
 * second concurrent (or sequential) call assigning the SAME partner to the
 * SAME campaign is treated as success, not a 409, learning directly from
 * PR #8's review finding on Conversion/RoutingRule: a same-target duplicate
 * request means the caller wants a fact to be true, and getting an error
 * for asking twice is exactly the class of bug that review flagged.
 *
 * Concurrency: the AffiliatePartner row is locked (`SELECT ... FOR UPDATE`)
 * before deciding whether the assignment is allowed, so this transaction
 * correctly serializes against a concurrent archiveAffiliatePartner call on
 * the same partner (the "archive + assignment" race explicitly called out
 * in the brief) — whichever transaction commits first is authoritative;
 * the loser sees the post-commit status before making its own decision,
 * never a stale read.
 */
export async function assignAffiliatePartnerToCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  affiliatePartnerId: string,
) {
  await getCampaign(prisma, organizationId, campaignId);

  return prisma.$transaction(async (tx) => {
    const lockedPartner = await tx.$queryRaw<{ status: AffiliatePartnerStatus }[]>`
      SELECT status FROM affiliate_partners
      WHERE id = ${affiliatePartnerId} AND "organizationId" = ${organizationId}
      FOR UPDATE
    `;
    const partnerStatus = lockedPartner[0]?.status;
    if (!partnerStatus) {
      throw ApiError.validation("affiliatePartnerId does not belong to this organization");
    }

    const existing = await tx.campaignAffiliatePartner.findUnique({
      where: { campaignId_affiliatePartnerId: { campaignId, affiliatePartnerId } },
    });
    if (existing) {
      // Idempotent no-op: already assigned, regardless of the partner's
      // current status (archiving a partner never un-assigns it — see
      // "Historical attribution" in docs/architecture/affiliate-partners.md).
      return existing;
    }

    if (partnerStatus === "ARCHIVED") {
      throw ApiError.conflict(
        "Cannot assign an ARCHIVED affiliate partner to a campaign — archived partners cannot receive new assignments",
      );
    }

    const assignment = await tx.campaignAffiliatePartner.create({
      data: { organizationId, campaignId, affiliatePartnerId },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "affiliate_partner.assigned",
      entityType: "AffiliatePartner",
      entityId: affiliatePartnerId,
      metadata: { campaignId },
    });

    return assignment;
  });
}

export async function unassignAffiliatePartnerFromCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  affiliatePartnerId: string,
) {
  await getCampaign(prisma, organizationId, campaignId);

  const existing = await prisma.campaignAffiliatePartner.findUnique({
    where: { campaignId_affiliatePartnerId: { campaignId, affiliatePartnerId } },
  });
  if (!existing || existing.organizationId !== organizationId) {
    throw ApiError.notFound("Affiliate partner assignment not found");
  }

  await prisma.$transaction(async (tx) => {
    await tx.campaignAffiliatePartner.delete({ where: { id: existing.id } });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "affiliate_partner.unassigned",
      entityType: "AffiliatePartner",
      entityId: affiliatePartnerId,
      metadata: { campaignId },
    });
  });
}
