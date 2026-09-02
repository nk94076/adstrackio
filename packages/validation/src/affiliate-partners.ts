import { z } from "zod";

export const affiliatePartnerStatusSchema = z.enum(["PENDING", "ACTIVE", "PAUSED", "ARCHIVED"]);

/** ARCHIVED/PAUSED are excluded on purpose: a partner is only ever paused
 * or archived by an explicit lifecycle action on a partner that already
 * exists, never as a starting state — mirrors
 * packages/shared/src/affiliate-partner-lifecycle.ts's
 * CREATABLE_AFFILIATE_PARTNER_STATUSES exactly. */
export const creatableAffiliatePartnerStatusSchema = z.enum(["PENDING", "ACTIVE"]);

export const createAffiliatePartnerSchema = z.object({
  name: z.string().trim().min(1).max(160),
  externalId: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  status: creatableAffiliatePartnerStatusSchema.default("PENDING"),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateAffiliatePartnerInput = z.infer<typeof createAffiliatePartnerSchema>;

// Deliberately no `status` field: lifecycle transitions are only made
// through the explicit POST .../activate, .../pause, .../archive endpoints
// (see packages/shared/src/affiliate-partner-lifecycle.ts), never as a side
// effect of a general PATCH — the same convention Campaign/TrackingLink/
// Conversion/RoutingRule already established. A payload that includes
// `status` has that key silently stripped (zod's default, non-strict
// object parsing), never rejected.
export const updateAffiliatePartnerSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  externalId: z.string().trim().min(1).max(160).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateAffiliatePartnerInput = z.infer<typeof updateAffiliatePartnerSchema>;
