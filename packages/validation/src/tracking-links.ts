import { z } from "zod";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const trackingLinkStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);

/** ARCHIVED is excluded on purpose: a tracking link is only ever archived
 * by an explicit lifecycle action on a link that already exists, never as
 * a starting state (see packages/shared/src/tracking-link-lifecycle.ts). */
export const creatableTrackingLinkStatusSchema = z.enum(["ACTIVE", "PAUSED"]);

export const createTrackingLinkSchema = z.object({
  campaignId: z.string().cuid(),
  trackingDomainId: z.string().cuid(),
  destinationId: z.string().cuid(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(80)
    .regex(slugPattern, "Slug must be lowercase letters, numbers and hyphens only"),
  status: creatableTrackingLinkStatusSchema.default("ACTIVE"),
  /// The single AffiliatePartner this link's clicks deterministically
  /// attribute to (Phase 9: Affiliate/Partner System) — optional; omitted
  /// or null means an ordinary non-affiliate link. Service layer verifies
  /// the referenced partner is currently assigned to this link's own
  /// campaign, backstopped by a database trigger — see
  /// docs/architecture/affiliate-partners.md.
  affiliatePartnerId: z.string().cuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateTrackingLinkInput = z.infer<typeof createTrackingLinkSchema>;

/** Same as createTrackingLinkSchema minus campaignId, for the nested
 * POST /campaigns/:campaignId/tracking-links route, where the campaign is
 * unambiguously identified by the URL path rather than the request body —
 * there is no client-supplied campaignId here for a route handler to
 * second-guess against the path. */
export const createTrackingLinkForCampaignSchema = createTrackingLinkSchema.omit({
  campaignId: true,
});
export type CreateTrackingLinkForCampaignInput = z.infer<
  typeof createTrackingLinkForCampaignSchema
>;

// Deliberately no `status` field, for the same reason as
// updateCampaignSchema: lifecycle transitions only happen through the
// explicit POST .../activate, .../pause, .../archive endpoints.
export const updateTrackingLinkSchema = z.object({
  destinationId: z.string().cuid().optional(),
  /// Nullable so an existing attribution can be explicitly cleared
  /// (set to null) as well as changed to a different partner — omitted
  /// entirely leaves the current attribution untouched, matching the
  /// rest of this schema's partial-update convention.
  affiliatePartnerId: z.string().cuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateTrackingLinkInput = z.infer<typeof updateTrackingLinkSchema>;
