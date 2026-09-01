import { z } from "zod";

export const createDestinationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().trim().min(1).max(2048),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;

export const updateDestinationSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateDestinationInput = z.infer<typeof updateDestinationSchema>;
