import { z } from "zod";

const hostnamePattern = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/;

export const createTrackingDomainSchema = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(hostnamePattern, "Must be a valid hostname (e.g. track.example.com)"),
});
export type CreateTrackingDomainInput = z.infer<typeof createTrackingDomainSchema>;

export const updateTrackingDomainSchema = z.object({
  isActive: z.boolean().optional(),
});
export type UpdateTrackingDomainInput = z.infer<typeof updateTrackingDomainSchema>;
