import { z } from "zod";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const trackingLinkStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);

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
  status: trackingLinkStatusSchema.default("ACTIVE"),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateTrackingLinkInput = z.infer<typeof createTrackingLinkSchema>;

export const updateTrackingLinkSchema = z.object({
  destinationId: z.string().cuid().optional(),
  status: trackingLinkStatusSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateTrackingLinkInput = z.infer<typeof updateTrackingLinkSchema>;
