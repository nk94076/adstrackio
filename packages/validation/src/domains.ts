import { z } from "zod";

export const createTrackingDomainSchema = z.object({
  hostname: z.string().trim().min(1).max(253),
});
export type CreateTrackingDomainInput = z.infer<typeof createTrackingDomainSchema>;
