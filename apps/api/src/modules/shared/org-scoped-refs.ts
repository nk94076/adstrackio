import type { PrismaClient } from "@adstrackio/database";
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
