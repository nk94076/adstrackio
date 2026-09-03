import { z } from "zod";

export const apiKeyScopeSchema = z.enum(["READ", "WRITE", "REPORTS", "CONVERSIONS"]);

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(160),
  scopes: z.array(apiKeyScopeSchema).min(1, "At least one scope is required").max(10),
  /** Optional; null/omitted means the key never expires. */
  expiresAt: z.coerce.date().optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/** Cursor-bounded list — matches audit-logs/conversions' existing
 * pagination shape rather than inventing a new one. */
export const listApiKeysQuerySchema = z.object({
  take: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().cuid().optional(),
});
export type ListApiKeysQuery = z.infer<typeof listApiKeysQuerySchema>;
