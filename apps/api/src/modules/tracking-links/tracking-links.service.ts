import type { PrismaClient, Prisma } from "@adstrackio/database";
import {
  ApiError,
  InvalidTrackingLinkStatusTransitionError,
  assertValidTrackingLinkStatusTransition,
  type TrackingLinkStatus,
} from "@adstrackio/shared";
import type { CreateTrackingLinkInput, UpdateTrackingLinkInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";
import { getCampaign } from "../campaigns/campaigns.service.js";
import {
  assertAffiliatePartnerAssignable,
  assertCampaignAcceptsNewOrReactivatedLinks,
  assertDestinationAssignable,
  assertTrackingDomainAssignable,
} from "../shared/org-scoped-refs.js";

async function assertCreateReferencesValid(
  prisma: PrismaClient,
  organizationId: string,
  input: {
    campaignId: string;
    trackingDomainId: string;
    destinationId: string;
    affiliatePartnerId?: string;
  },
) {
  // Order matters for a clear error message: campaign existence/status
  // first (a link cannot exist without a valid campaign to belong to),
  // then the domain/destination it will actually use, then (Phase 9) the
  // affiliate partner it will attribute clicks to, if any — checked last
  // since it depends on the campaign already being known-valid.
  await assertCampaignAcceptsNewOrReactivatedLinks(prisma, organizationId, input.campaignId);
  await assertTrackingDomainAssignable(prisma, organizationId, input.trackingDomainId);
  await assertDestinationAssignable(prisma, organizationId, input.destinationId);
  if (input.affiliatePartnerId) {
    await assertAffiliatePartnerAssignable(
      prisma,
      organizationId,
      input.campaignId,
      input.affiliatePartnerId,
    );
  }
}

/**
 * Creates a TrackingLink record. Actual click resolution against it is
 * implemented by PrismaTrackingResolver (apps/tracker) — this only manages
 * the control-plane row: existence, organization/campaign ownership, and
 * that the domain it's created against can actually serve traffic (Phase 6
 * — previously only organization ownership was checked here).
 */
export async function createTrackingLink(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateTrackingLinkInput,
) {
  await assertCreateReferencesValid(prisma, organizationId, input);

  const existing = await prisma.trackingLink.findUnique({
    where: { trackingDomainId_slug: { trackingDomainId: input.trackingDomainId, slug: input.slug } },
  });
  if (existing) {
    throw ApiError.conflict(`Slug "${input.slug}" is already used on this tracking domain`);
  }

  return prisma.$transaction(async (tx) => {
    const trackingLink = await tx.trackingLink.create({
      data: {
        campaignId: input.campaignId,
        trackingDomainId: input.trackingDomainId,
        destinationId: input.destinationId,
        slug: input.slug,
        status: input.status,
        affiliatePartnerId: input.affiliatePartnerId,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "tracking_link.created",
      entityType: "TrackingLink",
      entityId: trackingLink.id,
      metadata: {
        slug: trackingLink.slug,
        campaignId: trackingLink.campaignId,
        affiliatePartnerId: trackingLink.affiliatePartnerId,
      },
    });

    return trackingLink;
  });
}

export async function listTrackingLinks(prisma: PrismaClient, organizationId: string) {
  return prisma.trackingLink.findMany({
    where: { campaign: { organizationId } },
    orderBy: { createdAt: "desc" },
  });
}

export async function listTrackingLinksForCampaign(
  prisma: PrismaClient,
  organizationId: string,
  campaignId: string,
) {
  // Confirms the campaign itself is in-org before listing, so an
  // out-of-org campaignId reports 404 rather than a confusing empty list.
  await getCampaign(prisma, organizationId, campaignId);
  return prisma.trackingLink.findMany({
    where: { campaignId, campaign: { organizationId } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getTrackingLink(
  prisma: PrismaClient,
  organizationId: string,
  trackingLinkId: string,
) {
  const trackingLink = await prisma.trackingLink.findFirst({
    where: { id: trackingLinkId, campaign: { organizationId } },
  });
  if (!trackingLink) {
    throw ApiError.notFound("Tracking link not found");
  }
  return trackingLink;
}

/**
 * Same as getTrackingLink but additionally requires the link belongs to
 * the specific campaign named in the URL path (nested route) — a link that
 * exists, in-org, under a *different* campaign must 404 here rather than
 * being returned, since the URL asserted a campaign/link relationship that
 * doesn't hold.
 */
export async function getTrackingLinkForCampaign(
  prisma: PrismaClient,
  organizationId: string,
  campaignId: string,
  trackingLinkId: string,
) {
  const trackingLink = await prisma.trackingLink.findFirst({
    where: { id: trackingLinkId, campaignId, campaign: { organizationId } },
  });
  if (!trackingLink) {
    throw ApiError.notFound("Tracking link not found");
  }
  return trackingLink;
}

export async function updateTrackingLink(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  trackingLinkId: string,
  input: UpdateTrackingLinkInput,
) {
  const existing = await getTrackingLink(prisma, organizationId, trackingLinkId);

  if (input.destinationId) {
    await assertDestinationAssignable(prisma, organizationId, input.destinationId);
  }
  // null explicitly clears attribution (always allowed); a string value
  // must be assignable against this link's own campaign; undefined leaves
  // the current attribution untouched.
  if (input.affiliatePartnerId) {
    await assertAffiliatePartnerAssignable(
      prisma,
      organizationId,
      existing.campaignId,
      input.affiliatePartnerId,
    );
  }

  return prisma.$transaction(async (tx) => {
    const trackingLink = await tx.trackingLink.update({
      where: { id: trackingLinkId },
      data: {
        destinationId: input.destinationId,
        affiliatePartnerId: input.affiliatePartnerId,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "tracking_link.updated",
      entityType: "TrackingLink",
      entityId: trackingLink.id,
      metadata:
        input.affiliatePartnerId !== undefined
          ? { affiliatePartnerId: trackingLink.affiliatePartnerId }
          : undefined,
    });

    return trackingLink;
  });
}

/**
 * Shared by activateTrackingLink/pauseTrackingLink/archiveTrackingLink —
 * same conditional-updateMany race-safety pattern as
 * campaigns.service.ts's transitionCampaignStatus.
 */
async function transitionTrackingLinkStatus(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  trackingLinkId: string,
  targetStatus: TrackingLinkStatus,
  auditAction: string,
) {
  const trackingLink = await getTrackingLink(prisma, organizationId, trackingLinkId);

  try {
    assertValidTrackingLinkStatusTransition(trackingLink.status as TrackingLinkStatus, targetStatus);
  } catch (error) {
    if (error instanceof InvalidTrackingLinkStatusTransitionError) {
      throw ApiError.conflict(error.message);
    }
    throw error;
  }

  if (trackingLink.status === targetStatus) {
    return trackingLink;
  }

  // Reactivating a link (PAUSED -> ACTIVE) is "adding new traffic" from
  // the campaign's point of view, same as creating one — an ARCHIVED
  // campaign must not gain new active links either way.
  if (targetStatus === "ACTIVE") {
    await assertCampaignAcceptsNewOrReactivatedLinks(prisma, organizationId, trackingLink.campaignId);
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.trackingLink.updateMany({
      where: { id: trackingLinkId, status: trackingLink.status },
      data: { status: targetStatus },
    });

    if (count === 0) {
      throw ApiError.conflict("Tracking link status changed concurrently; please retry");
    }

    const updated = await tx.trackingLink.findUniqueOrThrow({ where: { id: trackingLinkId } });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: auditAction,
      entityType: "TrackingLink",
      entityId: trackingLinkId,
      metadata: { from: trackingLink.status, to: targetStatus },
    });

    return updated;
  });
}

export function activateTrackingLink(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  trackingLinkId: string,
) {
  return transitionTrackingLinkStatus(
    prisma,
    actorUserId,
    organizationId,
    trackingLinkId,
    "ACTIVE",
    "tracking_link.activated",
  );
}

export function pauseTrackingLink(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  trackingLinkId: string,
) {
  return transitionTrackingLinkStatus(
    prisma,
    actorUserId,
    organizationId,
    trackingLinkId,
    "PAUSED",
    "tracking_link.paused",
  );
}

export function archiveTrackingLink(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  trackingLinkId: string,
) {
  return transitionTrackingLinkStatus(
    prisma,
    actorUserId,
    organizationId,
    trackingLinkId,
    "ARCHIVED",
    "tracking_link.archived",
  );
}
