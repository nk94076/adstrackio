import type { PrismaClient, Prisma } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";

/**
 * Organization-scoped foreign-key validation shared by campaigns.service.ts
 * and tracking-links.service.ts (Phase 6: Campaign Manager). Both modules
 * let an organization member attach a TrackingDomain/Destination/Campaign
 * by ID; every one of those IDs is client-supplied and must never be
 * trusted without an explicit ownership (and, for domains, usability)
 * check — this is the IDOR boundary for campaign/tracking-link
 * configuration.
 *
 * Consolidates what Phase 1-5 had as two near-identical
 * assertBelongsToOrg/assertOwnedByOrg helpers, and extends the domain check
 * with the verification/activation requirement Phase 6 adds (see
 * docs/architecture/campaign-manager.md): a domain that isn't VERIFIED and
 * isActive can never actually serve traffic (PrismaTrackingResolver already
 * rejects it at request time — apps/tracker/src/modules/tracker/
 * prisma-tracking-resolver.ts), so letting a campaign or tracking link
 * point at one just defers a guaranteed failure to first click instead of
 * catching it at configuration time.
 */
export async function assertTrackingDomainAssignable(
  prisma: PrismaClient,
  organizationId: string,
  trackingDomainId: string,
): Promise<void> {
  const domain = await prisma.trackingDomain.findFirst({
    where: { id: trackingDomainId, organizationId },
  });
  if (!domain) {
    throw ApiError.validation("trackingDomainId does not belong to this organization");
  }
  if (domain.verificationStatus !== "VERIFIED") {
    throw ApiError.validation(
      "trackingDomainId refers to a domain that has not completed DNS verification",
    );
  }
  if (!domain.isActive) {
    throw ApiError.validation("trackingDomainId refers to a domain that is not active");
  }
}

export async function assertDestinationAssignable(
  prisma: PrismaClient,
  organizationId: string,
  destinationId: string,
): Promise<void> {
  const destination = await prisma.destination.findFirst({
    where: { id: destinationId, organizationId },
  });
  if (!destination) {
    throw ApiError.validation("destinationId does not belong to this organization");
  }
}

/**
 * Used when attaching a *new* TrackingLink to a campaign (creation, or
 * reactivating one that was PAUSED). An ARCHIVED campaign is a closed
 * chapter — creating fresh traffic infrastructure under it, or resuming
 * traffic on an existing link under it, would contradict that. Config-only
 * changes (e.g. updating a link's destinationId) are not gated by this:
 * only creation and (re)activation are.
 */
export async function assertCampaignAcceptsNewOrReactivatedLinks(
  prisma: PrismaClient,
  organizationId: string,
  campaignId: string,
): Promise<void> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId } });
  if (!campaign) {
    throw ApiError.validation("campaignId does not belong to this organization");
  }
  if (campaign.status === "ARCHIVED") {
    throw ApiError.conflict("Cannot add or activate tracking links on an archived campaign");
  }
}

/**
 * Used when attributing a TrackingLink to an AffiliatePartner (Phase 9:
 * Affiliate/Partner System) — the partner must belong to this
 * organization, must NOT be ARCHIVED, and must already be on the target
 * campaign's roster (a CampaignAffiliatePartner row). The org/roster facts
 * are also re-verified at the database layer by
 * `enforce_tracking_link_affiliate_partner` as a backstop.
 *
 * CTO review finding (Phase 9 PR #10): this used to run against the
 * top-level PrismaClient *before* the transaction that writes the
 * TrackingLink row, which left a check-then-act race —
 *
 *   Request A: reads partner status = ACTIVE, passes the check
 *   Request B: archives the partner (commits)
 *   Request A: writes TrackingLink.affiliatePartnerId anyway
 *
 * — letting a tracking link end up attributed to a partner that was
 * ARCHIVED by the time the write actually happened. The required
 * invariant is absolute: an ARCHIVED AffiliatePartner must never receive a
 * NEW TrackingLink attribution, concurrently or not.
 *
 * The fix: this function MUST be called with the same transaction client
 * (`tx`) that goes on to write the TrackingLink row, and that write must
 * happen inside the same `prisma.$transaction(...)` callback — never call
 * this with the top-level PrismaClient and write the TrackingLink
 * separately. It takes a `SELECT ... FOR UPDATE` row lock on the
 * AffiliatePartner row — the exact same row
 * affiliate-partners.service.ts's `transitionAffiliatePartnerStatus`
 * (activate/pause/archive) and campaign-affiliate-partners.service.ts's
 * `assignAffiliatePartnerToCampaign` already lock — before re-reading its
 * status. Postgres serializes any two transactions that take a `FOR
 * UPDATE` lock on the same row: whichever transaction's lock is granted
 * first runs to completion (commit or rollback) before the other's `SELECT
 * ... FOR UPDATE` can even return, so the loser always observes the
 * winner's already-committed status — never a stale read from before the
 * lock was acquired. There is no interleaving under which a concurrent
 * archive and a concurrent tracking-link attribution can both believe the
 * partner is ACTIVE.
 */
export async function assertAffiliatePartnerAssignable(
  tx: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  campaignId: string,
  affiliatePartnerId: string,
): Promise<void> {
  const locked = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM affiliate_partners
    WHERE id = ${affiliatePartnerId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  const status = locked[0]?.status;
  if (!status) {
    throw ApiError.validation("affiliatePartnerId does not belong to this organization");
  }
  if (status === "ARCHIVED") {
    throw ApiError.conflict(
      "Cannot attribute a tracking link to an ARCHIVED affiliate partner — archived partners cannot receive new assignments",
    );
  }

  const assignment = await tx.campaignAffiliatePartner.findUnique({
    where: { campaignId_affiliatePartnerId: { campaignId, affiliatePartnerId } },
  });
  if (!assignment) {
    throw ApiError.validation(
      "affiliatePartnerId is not assigned to this tracking link's campaign — assign it to the campaign first",
    );
  }
}
