import type { PrismaClient, Prisma } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";
import type { CreateTrackingLinkInput, UpdateTrackingLinkInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

async function assertOwnedByOrg(
  prisma: PrismaClient,
  organizationId: string,
  input: { campaignId: string; trackingDomainId: string; destinationId: string },
) {
  const [campaign, domain, destination] = await Promise.all([
    prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId } }),
    prisma.trackingDomain.findFirst({ where: { id: input.trackingDomainId, organizationId } }),
    prisma.destination.findFirst({ where: { id: input.destinationId, organizationId } }),
  ]);

  if (!campaign) throw ApiError.validation("campaignId does not belong to this organization");
  if (!domain) throw ApiError.validation("trackingDomainId does not belong to this organization");
  if (!destination) {
    throw ApiError.validation("destinationId does not belong to this organization");
  }
}

/**
 * Creates a TrackingLink record only — it is a routing identifier, not a
 * live redirect endpoint. Actual click resolution is implemented by the
 * future TrackingResolver (see packages/shared/src/tracking-resolver.ts
 * and apps/tracker), which is out of scope for Phase 1.
 */
export async function createTrackingLink(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateTrackingLinkInput,
) {
  await assertOwnedByOrg(prisma, organizationId, input);

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
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "tracking_link.created",
      entityType: "TrackingLink",
      entityId: trackingLink.id,
      metadata: { slug: trackingLink.slug },
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

export async function updateTrackingLink(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  trackingLinkId: string,
  input: UpdateTrackingLinkInput,
) {
  await getTrackingLink(prisma, organizationId, trackingLinkId);

  if (input.destinationId) {
    const destination = await prisma.destination.findFirst({
      where: { id: input.destinationId, organizationId },
    });
    if (!destination) {
      throw ApiError.validation("destinationId does not belong to this organization");
    }
  }

  return prisma.$transaction(async (tx) => {
    const trackingLink = await tx.trackingLink.update({
      where: { id: trackingLinkId },
      data: {
        destinationId: input.destinationId,
        status: input.status,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "tracking_link.updated",
      entityType: "TrackingLink",
      entityId: trackingLink.id,
    });

    return trackingLink;
  });
}
