import { z } from "zod";

export const campaignStatusSchema = z.enum(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]);

/** Routing action for SUSPICIOUS/UNKNOWN-classified traffic (Phase 5: Bot
 * Detection Integration) — see packages/shared/src/bot-traffic-policy.ts.
 * BOT/HUMAN are not configurable and have no corresponding field. */
export const botTrafficPolicyActionSchema = z.enum(["SAFE_PAGE", "TARGET", "BLOCK"]);

export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    status: campaignStatusSchema.default("DRAFT"),
    trackingDomainId: z.string().cuid().optional(),
    destinationId: z.string().cuid().optional(),
    safePageUrl: z.string().trim().min(1).max(2048).optional(),
    suspiciousTrafficPolicy: botTrafficPolicyActionSchema.default("TARGET"),
    unknownTrafficPolicy: botTrafficPolicyActionSchema.default("TARGET"),
    budgetAmount: z.number().nonnegative().optional(),
    budgetCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .length(3, "Currency must be a 3-letter ISO code")
      .optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((data) => !data.startDate || !data.endDate || data.startDate <= data.endDate, {
    message: "startDate must be before or equal to endDate",
    path: ["endDate"],
  });
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  status: campaignStatusSchema.optional(),
  trackingDomainId: z.string().cuid().nullable().optional(),
  destinationId: z.string().cuid().nullable().optional(),
  safePageUrl: z.string().trim().min(1).max(2048).nullable().optional(),
  suspiciousTrafficPolicy: botTrafficPolicyActionSchema.optional(),
  unknownTrafficPolicy: botTrafficPolicyActionSchema.optional(),
  budgetAmount: z.number().nonnegative().nullable().optional(),
  budgetCurrency: z.string().trim().toUpperCase().length(3).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
