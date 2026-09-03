import type { PrismaClient } from "@adstrackio/database";
import { ApiError } from "@adstrackio/shared";
import { generateApiKey } from "@adstrackio/auth";
import type { CreateApiKeyInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

/**
 * API key control plane (Phase 11: API + Integrations) — see
 * docs/api/api-keys.md.
 *
 * organizationId is never taken from the request body — only from the
 * authenticated, membership-checked URL path, the same IDOR boundary
 * every other organization-scoped module in this codebase already
 * enforces. The raw secret is generated here and returned exactly once;
 * nothing this module returns to a route handler after creation/rotation
 * ever includes it again.
 */

const PUBLIC_FIELDS = {
  id: true,
  organizationId: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** How many times to retry key generation if the (astronomically
 * unlikely) random keyPrefix collides with an existing row. */
const MAX_PREFIX_COLLISION_RETRIES = 5;

export async function createApiKey(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateApiKeyInput,
) {
  for (let attempt = 0; attempt < MAX_PREFIX_COLLISION_RETRIES; attempt += 1) {
    const generated = generateApiKey();
    try {
      const apiKey = await prisma.$transaction(async (tx) => {
        const created = await tx.apiKey.create({
          data: {
            organizationId,
            name: input.name,
            keyPrefix: generated.prefix,
            keyHash: generated.hash,
            scopes: input.scopes,
            expiresAt: input.expiresAt,
            createdBy: actorUserId,
          },
          select: PUBLIC_FIELDS,
        });

        // Metadata never includes the prefix or any key material — only
        // the non-secret name/scopes, matching the "never log secrets"
        // requirement from docs/api/api-keys.md#security.
        await writeAuditLog(tx, {
          organizationId,
          actorUserId,
          action: "api_key.created",
          entityType: "ApiKey",
          entityId: created.id,
          metadata: { name: created.name, scopes: created.scopes },
        });

        return created;
      });
      return { apiKey, rawKey: generated.raw };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
        continue; // keyPrefix collision — retry with a fresh random key
      }
      throw error;
    }
  }
  throw ApiError.internal("Failed to generate a unique API key; please retry");
}

export async function listApiKeys(
  prisma: PrismaClient,
  organizationId: string,
  query: { take: number; cursor?: string },
) {
  return prisma.apiKey.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: query.take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    select: PUBLIC_FIELDS,
  });
}

export async function getApiKey(prisma: PrismaClient, organizationId: string, apiKeyId: string) {
  const apiKey = await prisma.apiKey.findFirst({
    where: { id: apiKeyId, organizationId },
    select: PUBLIC_FIELDS,
  });
  if (!apiKey) {
    throw ApiError.notFound("API key not found");
  }
  return apiKey;
}

/**
 * Issues a brand-new secret for an existing ApiKey row, invalidating the
 * previous one immediately (the old keyHash is overwritten, so it can
 * never authenticate again). Scopes/name/expiresAt are left unchanged —
 * rotation replaces the credential, not the key's identity or grants.
 */
export async function rotateApiKey(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  apiKeyId: string,
) {
  const existing = await getApiKey(prisma, organizationId, apiKeyId);
  if (existing.revokedAt) {
    throw ApiError.conflict("Cannot rotate a revoked API key");
  }

  for (let attempt = 0; attempt < MAX_PREFIX_COLLISION_RETRIES; attempt += 1) {
    const generated = generateApiKey();
    try {
      const apiKey = await prisma.$transaction(async (tx) => {
        const updated = await tx.apiKey.update({
          where: { id: apiKeyId },
          data: { keyPrefix: generated.prefix, keyHash: generated.hash, lastUsedAt: null },
          select: PUBLIC_FIELDS,
        });

        await writeAuditLog(tx, {
          organizationId,
          actorUserId,
          action: "api_key.rotated",
          entityType: "ApiKey",
          entityId: updated.id,
          metadata: { name: updated.name },
        });

        return updated;
      });
      return { apiKey, rawKey: generated.raw };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
        continue;
      }
      throw error;
    }
  }
  throw ApiError.internal("Failed to generate a unique API key; please retry");
}

/**
 * Revocation is permanent and one-directional (no un-revoke endpoint), so
 * a conditional updateMany guarded on `revokedAt: null` is sufficient
 * race-safety here — unlike the campaign/tracking-link/conversion
 * multi-state lifecycles, there is only ever one meaningful transition
 * (unrevoked -> revoked), so two concurrent revoke calls racing for it
 * can only ever agree on the outcome, never conflict. The loser simply
 * observes `count === 0` and, finding the row already revoked, returns
 * the same idempotent success the winner got — no audit entry for it,
 * since it caused no change.
 */
export async function revokeApiKey(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  apiKeyId: string,
) {
  const existing = await getApiKey(prisma, organizationId, apiKeyId);
  if (existing.revokedAt) {
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.apiKey.updateMany({
      where: { id: apiKeyId, organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const updated = await tx.apiKey.findUniqueOrThrow({ where: { id: apiKeyId }, select: PUBLIC_FIELDS });

    if (count > 0) {
      await writeAuditLog(tx, {
        organizationId,
        actorUserId,
        action: "api_key.revoked",
        entityType: "ApiKey",
        entityId: apiKeyId,
        metadata: { name: updated.name },
      });
    }

    return updated;
  });
}
