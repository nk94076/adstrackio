import type { PrismaClient, Prisma } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";
import type { CreateCampaignInput, UpdateCampaignInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

async function assertBelongsToOrg(
  prisma: PrismaClient,
  organizationId: string,
  trackingDomainId?: string | null,
  destinationId?: string | null,
) {
  if (trackingDomainId) {
    const domain = await prisma.trackingDomain.findFirst({
      where: { id: trackingDomainId, organizationId },
    });
    if (!domain) {
      throw ApiError.validation("trackingDomainId does not belong to this organization");
    }
  }
  if (destinationId) {
    const destination = await prisma.destination.findFirst({
      where: { id: destinationId, organizationId },
    });
    if (!destination) {
      throw ApiError.validation("destinationId does not belong to this organization");
    }
  }
}

export async function createCampaign(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateCampaignInput,
) {
  await assertBelongsToOrg(prisma, organizationId, input.trackingDomainId, input.destinationId);

  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        organizationId,
        name: input.name,
        status: input.status,
        trackingDomainId: input.trackingDomainId,
        destinationId: input.destinationId,
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
  await getCampaign(prisma, organizationId, campaignId);
  await assertBelongsToOrg(prisma, organizationId, input.trackingDomainId, input.destinationId);

  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.update({
      where: { id: campaignId },
      data: {
        name: input.name,
        status: input.status,
        trackingDomainId: input.trackingDomainId,
        destinationId: input.destinationId,
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
