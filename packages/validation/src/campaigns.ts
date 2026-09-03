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

// Deliberately no `status` field: lifecycle transitions are only made
// through the explicit POST .../activate, .../pause, .../archive endpoints
// (see packages/shared/src/campaign-lifecycle.ts), never as a side effect
// of a general PATCH. A payload that includes `status` has that key
// silently stripped (zod's default, non-strict object parsing) rather than
// rejected — the same way any other unrecognized field is ignored.
export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
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

/**
 * Cursor-bounded list query (Phase 11: API + Integrations) — mirrors the
 * shape `listConversionsQuerySchema`/`listApiKeysQuerySchema` already use.
 * `GET .../campaigns` predates pagination (Phase 1) and returned every
 * row unconditionally; now that it's also reachable by an external API
 * key (not just a dashboard session), an unbounded result set is a more
 * credible concern, so this phase adds the same bound every other list
 * endpoint already enforces. The default (100) is generous enough that
 * no existing dashboard view's behavior changes for any realistically-
 * sized organization.
 */
export const listCampaignsQuerySchema = z.object({
  take: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().cuid().optional(),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;
