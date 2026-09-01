import { z } from "zod";

export const referralConfigurationTypeSchema = z.enum([
  "NORMAL",
  "HIDE",
  "CUSTOM_PARTNER_ATTRIBUTION",
]);

export const createReferralConfigurationSchema = z
  .object({
    campaignId: z.string().cuid().optional(),
    type: referralConfigurationTypeSchema,
    customReferrerValue: z.string().trim().min(1).max(255).optional(),
  })
  .refine(
    (data) => data.type !== "CUSTOM_PARTNER_ATTRIBUTION" || Boolean(data.customReferrerValue),
    {
      message: "customReferrerValue is required for CUSTOM_PARTNER_ATTRIBUTION configurations",
      path: ["customReferrerValue"],
    },
  );
export type CreateReferralConfigurationInput = z.infer<typeof createReferralConfigurationSchema>;

export const activateReferralConfigurationSchema = z.object({
  activate: z.literal(true),
});

export const submitReferralProofSchema = z
  .object({
    documentReference: z.string().trim().min(1).max(512).optional(),
    evidenceUrl: z.string().trim().url().max(2048).optional(),
  })
  .refine((data) => Boolean(data.documentReference) || Boolean(data.evidenceUrl), {
    message: "At least one of documentReference or evidenceUrl is required",
    path: ["evidenceUrl"],
  });
export type SubmitReferralProofInput = z.infer<typeof submitReferralProofSchema>;

export const reviewReferralProofSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    rejectionReason: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((data) => data.decision !== "REJECTED" || Boolean(data.rejectionReason), {
    message: "rejectionReason is required when rejecting a proof",
    path: ["rejectionReason"],
  });
export type ReviewReferralProofInput = z.infer<typeof reviewReferralProofSchema>;
