import type { PrismaClient } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";
import type { CreateReferralConfigurationInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

export async function createReferralConfiguration(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateReferralConfigurationInput,
) {
  if (input.campaignId) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: input.campaignId, organizationId },
    });
    if (!campaign) {
      throw ApiError.validation("campaignId does not belong to this organization");
    }
  }

  return prisma.$transaction(async (tx) => {
    // Always created INACTIVE — activation is a separate, gated step so a
    // CUSTOM_PARTNER_ATTRIBUTION configuration can never go live without
    // proof review. See activateReferralConfiguration below.
    const configuration = await tx.referralConfiguration.create({
      data: {
        organizationId,
        campaignId: input.campaignId,
        type: input.type,
        customReferrerValue: input.customReferrerValue,
        createdById: actorUserId,
        status: "INACTIVE",
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "referral_configuration.created",
      entityType: "ReferralConfiguration",
      entityId: configuration.id,
      metadata: { type: configuration.type },
    });

    return configuration;
  });
}

export async function listReferralConfigurations(prisma: PrismaClient, organizationId: string) {
  return prisma.referralConfiguration.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { proofs: { orderBy: { createdAt: "desc" } } },
  });
}

export async function getReferralConfiguration(
  prisma: PrismaClient,
  organizationId: string,
  configurationId: string,
) {
  const configuration = await prisma.referralConfiguration.findFirst({
    where: { id: configurationId, organizationId },
    include: { proofs: { orderBy: { createdAt: "desc" } } },
  });
  if (!configuration) {
    throw ApiError.notFound("Referral configuration not found");
  }
  return configuration;
}

/**
 * Enforces the critical business rule: a CUSTOM_PARTNER_ATTRIBUTION
 * configuration must not become ACTIVE unless it has at least one
 * APPROVED ReferralProof. This is intentionally enforced here in the
 * service layer (not only validated in the UI) so no future API surface
 * can bypass it.
 */
export async function activateReferralConfiguration(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  configurationId: string,
) {
  const configuration = await getReferralConfiguration(prisma, organizationId, configurationId);

  if (configuration.type === "CUSTOM_PARTNER_ATTRIBUTION") {
    const hasApprovedProof = configuration.proofs.some(
      (proof) => proof.reviewStatus === "APPROVED",
    );
    if (!hasApprovedProof) {
      throw ApiError.conflict(
        "This custom partner attribution configuration cannot be activated until a submitted proof has been approved",
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.referralConfiguration.update({
      where: { id: configurationId },
      data: { status: "ACTIVE" },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "referral_configuration.activated",
      entityType: "ReferralConfiguration",
      entityId: configurationId,
    });

    return updated;
  });
}
