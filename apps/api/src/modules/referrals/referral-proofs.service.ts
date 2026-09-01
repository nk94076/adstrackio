import type { PrismaClient } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";
import type { ReviewReferralProofInput, SubmitReferralProofInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";
import { getReferralConfiguration } from "./referral-configurations.service.js";

export async function submitReferralProof(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  configurationId: string,
  input: SubmitReferralProofInput,
) {
  const configuration = await getReferralConfiguration(prisma, organizationId, configurationId);

  if (configuration.type !== "CUSTOM_PARTNER_ATTRIBUTION") {
    throw ApiError.validation(
      "Referral proofs are only applicable to CUSTOM_PARTNER_ATTRIBUTION configurations",
    );
  }

  return prisma.$transaction(async (tx) => {
    const proof = await tx.referralProof.create({
      data: {
        referralConfigurationId: configurationId,
        documentReference: input.documentReference,
        evidenceUrl: input.evidenceUrl,
        submittedById: actorUserId,
        reviewStatus: "PENDING",
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "referral_proof.submitted",
      entityType: "ReferralProof",
      entityId: proof.id,
      metadata: { referralConfigurationId: configurationId },
    });

    return proof;
  });
}

export async function listReferralProofs(
  prisma: PrismaClient,
  organizationId: string,
  configurationId: string,
) {
  await getReferralConfiguration(prisma, organizationId, configurationId);

  return prisma.referralProof.findMany({
    where: { referralConfigurationId: configurationId },
    orderBy: { createdAt: "desc" },
  });
}

export async function reviewReferralProof(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  configurationId: string,
  proofId: string,
  input: ReviewReferralProofInput,
) {
  await getReferralConfiguration(prisma, organizationId, configurationId);

  const proof = await prisma.referralProof.findFirst({
    where: { id: proofId, referralConfigurationId: configurationId },
  });
  if (!proof) {
    throw ApiError.notFound("Referral proof not found");
  }
  if (proof.reviewStatus === "APPROVED" || proof.reviewStatus === "REJECTED") {
    throw ApiError.conflict("This proof has already been reviewed");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.referralProof.update({
      where: { id: proofId },
      data: {
        reviewStatus: input.decision,
        reviewedById: actorUserId,
        reviewedAt: new Date(),
        rejectionReason: input.decision === "REJECTED" ? input.rejectionReason : null,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action:
        input.decision === "APPROVED" ? "referral_proof.approved" : "referral_proof.rejected",
      entityType: "ReferralProof",
      entityId: proof.id,
      metadata: { referralConfigurationId: configurationId },
    });

    return updated;
  });
}
