import { Prisma, type PrismaClient } from "@adstrackio/database";
import { ApiError, hashRequestBody } from "@adstrackio/shared";

export interface WithIdempotencyKeyParams {
  organizationId: string;
  /** Namespaces the key so the same client-chosen string can be reused
   * across different mutation types without colliding — e.g.
   * "conversion.create". */
  scope: string;
  key: string | undefined;
  /** The exact parsed request body the caller sent — hashed to detect a
   * conflicting reuse of the same key with a different payload. */
  requestBody: unknown;
}

export interface IdempotentMutationResult<T> {
  responseBody: T;
  /** True when this call returned a STORED prior response rather than
   * running the mutation again. */
  replayed: boolean;
}

/**
 * Wraps a mutation with `Idempotency-Key` deduplication (Phase 11: API +
 * Integrations) — see docs/api/api-keys.md#idempotency and
 * IdempotencyRecord's schema doc comment (packages/database/prisma/schema.prisma)
 * for the concurrency-safety argument this relies on.
 *
 * `fn` performs the actual business mutation, using the SAME transaction
 * this function opens (so the mutation and the IdempotencyRecord commit
 * or roll back together), and returns the exact JSON-serializable
 * response body a fresh (non-replayed) call should return, plus an
 * optional resourceId for observability. A replay returns that same
 * value byte-for-byte, never re-derived from a live database read.
 *
 * When `key` is undefined (the header was omitted), this is a pure
 * passthrough: the mutation runs normally with no dedup guarantee — an
 * omitted Idempotency-Key has always meant "this caller accepts the risk
 * of duplicate side effects from a retried request," the same tradeoff
 * Conversion.externalConversionId already offers as optional. See
 * docs/api/api-keys.md#idempotency for how the two relate: externalConversionId
 * is a business-level identity for the created resource itself (so two
 * DIFFERENT Idempotency-Keys that both name the same externalConversionId
 * still collide, by design); Idempotency-Key instead protects one
 * specific HTTP call attempt against being retried into a duplicate side
 * effect, whether or not the request supplied an externalConversionId at
 * all.
 */
export async function withIdempotencyKey<T>(
  prisma: PrismaClient,
  params: WithIdempotencyKeyParams,
  fn: (tx: Prisma.TransactionClient) => Promise<{ responseBody: T; resourceId?: string }>,
): Promise<IdempotentMutationResult<T>> {
  if (!params.key) {
    const { responseBody } = await prisma.$transaction((tx) => fn(tx));
    return { responseBody, replayed: false };
  }

  const key = params.key;
  const requestHash = hashRequestBody(params.requestBody);
  const uniqueWhere = {
    organizationId_scope_key: { organizationId: params.organizationId, scope: params.scope, key },
  };

  try {
    const responseBody = await prisma.$transaction(async (tx) => {
      // Inserted BEFORE the mutation runs. A concurrent request racing on
      // the exact same (organizationId, scope, key) blocks on this INSERT
      // until this transaction commits or rolls back (Postgres's unique-
      // index insert semantics) — see IdempotencyRecord's schema doc
      // comment for why this alone is sufficient for correctness under
      // concurrency, with no separate row lock or in-memory map needed.
      await tx.idempotencyRecord.create({
        data: {
          organizationId: params.organizationId,
          scope: params.scope,
          key,
          requestHash,
          // Real values are filled in by the update below, once `fn` has
          // actually produced them — placeholders here are never visible
          // to any other transaction (this one hasn't committed yet).
          responseStatus: 0,
          responseBody: {},
        },
      });

      const { responseBody: body, resourceId } = await fn(tx);
      // Round-trip through JSON so the stored value is guaranteed to be
      // plain JSON (e.g. Prisma Decimal instances serialize via their own
      // toJSON) — a replay must return exactly what the wire response
      // would have contained, not a driver-specific class instance.
      const plainBody = JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;

      await tx.idempotencyRecord.update({
        where: uniqueWhere,
        data: {
          responseBody: plainBody,
          responseStatus: 201,
          resourceType: params.scope,
          resourceId,
        },
      });

      return body;
    });
    return { responseBody, replayed: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.idempotencyRecord.findUnique({ where: uniqueWhere });
      if (!existing) {
        // The conflicting row existed a moment ago (that's why we're in
        // this catch) but is gone now — not a state this design should
        // ever reach (rows are never deleted), so surface the original
        // error rather than guessing.
        throw error;
      }
      if (existing.requestHash !== requestHash) {
        throw ApiError.conflict(
          "This Idempotency-Key was already used with a different request payload",
        );
      }
      return { responseBody: existing.responseBody as T, replayed: true };
    }
    throw error;
  }
}
