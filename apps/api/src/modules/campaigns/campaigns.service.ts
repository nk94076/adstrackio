import type { PrismaClient, Prisma } from "@adstrackio/database";
import {
  ApiError,
  CREATABLE_CAMPAIGN_STATUSES,
  InvalidCampaignStatusTransitionError,
  InvalidDestinationUrlError,
  assertValidCampaignStatusTransition,
  normalizeDestinationUrl,
  type CampaignStatus,
} from "@adstrackio/shared";
import type { CreateCampaignInput, UpdateCampaignInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";
import { assertDestinationAssignable, assertTrackingDomainAssignable } from "../shared/org-scoped-refs.js";

// safePageUrl is a server-configured, admin-entered URL (not the
// request-supplied transparent redirection_url the tracker follows for
// real traffic), so the same admin-configured-URL validator used for
// Destination applies here.
function normalizeSafePageUrlOrThrow(url: string): string {
  try {
    return normalizeDestinationUrl(url);
  } catch (error) {
    if (error instanceof InvalidDestinationUrlError) {
      throw ApiError.validation(error.message);
    }
    throw error;
  }
}

async function assertReferencesValid(
  prisma: PrismaClient,
  organizationId: string,
  trackingDomainId?: string | null,
  destinationId?: string | null,
) {
  if (trackingDomainId) {
    await assertTrackingDomainAssignable(prisma, organizationId, trackingDomainId);
  }
  if (destinationId) {
    await assertDestinationAssignable(prisma, organizationId, destinationId);
  }
}

export async function createCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateCampaignInput,
) {
  if (!CREATABLE_CAMPAIGN_STATUSES.includes(input.status as CampaignStatus)) {
    throw ApiError.validation(
      `A campaign cannot be created directly in ${input.status} status; create it as DRAFT or ACTIVE and use the lifecycle endpoints from there`,
    );
  }
  await assertReferencesValid(prisma, organizationId, input.trackingDomainId, input.destinationId);
  const safePageUrl = input.safePageUrl ? normalizeSafePageUrlOrThrow(input.safePageUrl) : undefined;

  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        organizationId,
        name: input.name,
        status: input.status,
        trackingDomainId: input.trackingDomainId,
        destinationId: input.destinationId,
        safePageUrl,
        suspiciousTrafficPolicy: input.suspiciousTrafficPolicy,
        unknownTrafficPolicy: input.unknownTrafficPolicy,
        budgetAmount: input.budgetAmount,
        budgetCurrency: input.budgetCurrency,
        startDate: input.startDate,
        endDate: input.endDate,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "campaign.created",
      entityType: "Campaign",
      entityId: campaign.id,
      metadata: { name: campaign.name, status: campaign.status },
    });

    return campaign;
  });
}

export async function listCampaigns(prisma: PrismaClient, organizationId: string) {
  return prisma.campaign.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getCampaign(
  prisma: PrismaClient,
  organizationId: string,
  campaignId: string,
) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId } });
  if (!campaign) {
    throw ApiError.notFound("Campaign not found");
  }
  return campaign;
}

export async function updateCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  input: UpdateCampaignInput,
) {
  const existing = await getCampaign(prisma, organizationId, campaignId);

  // A campaign serving live traffic must not have the domain it resolves
  // requests on swapped out from under it — that would silently change
  // which hostname's clicks the campaign's tracking links depend on
  // without anyone pausing traffic first. Pause (or archive) the campaign
  // to change its tracking domain. destinationId/safePageUrl are exempt:
  // neither is read by the tracker's actual redirect decision (Phase 3's
  // transparent architecture uses the request's own redirection_url), so
  // changing them can't break an in-flight resolution the way trackingDomainId can.
  if (
    existing.status === "ACTIVE" &&
    input.trackingDomainId !== undefined &&
    input.trackingDomainId !== existing.trackingDomainId
  ) {
    throw ApiError.conflict(
      "Cannot change trackingDomainId while the campaign is ACTIVE; pause the campaign first",
    );
  }

  await assertReferencesValid(prisma, organizationId, input.trackingDomainId, input.destinationId);
  const safePageUrl =
    input.safePageUrl === null || input.safePageUrl === undefined
      ? input.safePageUrl
      : normalizeSafePageUrlOrThrow(input.safePageUrl);

  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.update({
      where: { id: campaignId },
      data: {
        name: input.name,
        trackingDomainId: input.trackingDomainId,
        destinationId: input.destinationId,
        safePageUrl,
        suspiciousTrafficPolicy: input.suspiciousTrafficPolicy,
        unknownTrafficPolicy: input.unknownTrafficPolicy,
        budgetAmount: input.budgetAmount,
        budgetCurrency: input.budgetCurrency,
        startDate: input.startDate,
        endDate: input.endDate,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "campaign.updated",
      entityType: "Campaign",
      entityId: campaign.id,
    });

    return campaign;
  });
}

/**
 * Shared by activateCampaign/pauseCampaign/archiveCampaign. Validates the
 * transition against the state machine in packages/shared/src/
 * campaign-lifecycle.ts, then applies it with a conditional updateMany
 * (guarding on the status just read) rather than an unconditional update —
 * the same race-safety pattern domains.service.ts's activateTrackingDomain
 * uses — so a concurrent transition can't be silently clobbered.
 */
async function transitionCampaignStatus(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  targetStatus: CampaignStatus,
  auditAction: string,
) {
  const campaign = await getCampaign(prisma, organizationId, campaignId);

  try {
    assertValidCampaignStatusTransition(campaign.status as CampaignStatus, targetStatus);
  } catch (error) {
    if (error instanceof InvalidCampaignStatusTransitionError) {
      throw ApiError.conflict(error.message);
    }
    throw error;
  }

  if (campaign.status === targetStatus) {
    // Idempotent no-op: calling activate() on an already-ACTIVE campaign
    // (etc.) succeeds without writing a redundant audit entry.
    return campaign;
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.campaign.updateMany({
      where: { id: campaignId, organizationId, status: campaign.status },
      data: { status: targetStatus },
    });

    if (count === 0) {
      throw ApiError.conflict("Campaign status changed concurrently; please retry");
    }

    const updated = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: auditAction,
      entityType: "Campaign",
      entityId: campaignId,
      metadata: { from: campaign.status, to: targetStatus },
    });

    return updated;
  });
}

export function activateCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
) {
  return transitionCampaignStatus(
    prisma,
    actorUserId,
    organizationId,
    campaignId,
    "ACTIVE",
    "campaign.activated",
  );
}

export function pauseCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
) {
  return transitionCampaignStatus(
    prisma,
    actorUserId,
    organizationId,
    campaignId,
    "PAUSED",
    "campaign.paused",
  );
}

export function archiveCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
) {
  return transitionCampaignStatus(
    prisma,
    actorUserId,
    organizationId,
    campaignId,
    "ARCHIVED",
    "campaign.archived",
  );
}
