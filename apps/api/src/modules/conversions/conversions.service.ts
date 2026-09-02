import { Prisma, type PrismaClient } from "@adstrackio/database";
import {
  ApiError,
  InvalidConversionStatusTransitionError,
  assertValidConversionStatusTransition,
  type ConversionStatus,
} from "@adstrackio/shared";
import type { CreateConversionInput, ListConversionsQuery } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

/**
 * Creates a Conversion attributed to an existing Click. campaignId/
 * trackingLinkId are read from the Click row — never from `input` — so a
 * client cannot invent or override which campaign/tracking link a
 * conversion counts against; see docs/architecture/conversion-tracking.md#click-attribution.
 * The Click lookup is organization-scoped, so a clickId from another
 * organization is indistinguishable from one that doesn't exist at all
 * (both 404) — the existing uniform-404 convention this codebase already
 * uses elsewhere (e.g. campaign/tracking-domain lookups), which avoids
 * confirming to an unauthorized caller that a given click ID is real.
 *
 * Deduplication: if `externalConversionId` is supplied, the database's
 * `conversions_organizationId_externalConversionId_key` unique index
 * (packages/database, migration 20260902155750_conversion_tracking_foundation)
 * is the actual enforcement point, not a check-then-insert race — see
 * docs/architecture/conversion-tracking.md#deduplication. A unique-
 * violation here always means "this externalConversionId was already
 * used in this organization," since campaignId/trackingLinkId/
 * organizationId are derived, not client-chosen, so they can't be the
 * cause of a different unique constraint firing.
 */
export async function createConversion(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateConversionInput,
) {
  const click = await prisma.click.findFirst({
    where: { id: input.clickId, organizationId },
  });
  if (!click) {
    throw ApiError.notFound("Click not found");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.create({
        data: {
          organizationId,
          campaignId: click.campaignId,
          trackingLinkId: click.trackingLinkId,
          clickId: click.id,
          eventName: input.eventName,
          value: input.value,
          currency: input.currency,
          externalConversionId: input.externalConversionId,
          occurredAt: input.occurredAt ?? new Date(),
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      await writeAuditLog(tx, {
        organizationId,
        actorUserId,
        action: "conversion.created",
        entityType: "Conversion",
        entityId: conversion.id,
        metadata: {
          eventName: conversion.eventName,
          clickId: conversion.clickId,
          campaignId: conversion.campaignId,
        },
      });

      return conversion;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw ApiError.conflict(
        `A conversion with externalConversionId "${input.externalConversionId}" already exists in this organization`,
      );
    }
    throw error;
  }
}

export async function listConversions(
  prisma: PrismaClient,
  organizationId: string,
  query: ListConversionsQuery,
) {
  return prisma.conversion.findMany({
    where: {
      organizationId,
      status: query.status,
      campaignId: query.campaignId,
      trackingLinkId: query.trackingLinkId,
    },
    orderBy: { occurredAt: "desc" },
    take: query.take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
  });
}

export async function getConversion(
  prisma: PrismaClient,
  organizationId: string,
  conversionId: string,
) {
  const conversion = await prisma.conversion.findFirst({
    where: { id: conversionId, organizationId },
  });
  if (!conversion) {
    throw ApiError.notFound("Conversion not found");
  }
  return conversion;
}

/**
 * Shared by approveConversion/rejectConversion/reverseConversion.
 *
 * Concurrency design: this is deliberately NOT a conditional-updateMany
 * (optimistic: read, then write-if-unchanged, then let the loser's
 * affected-row-count of 0 decide what happened). That approach correctly
 * serializes *conflicting* concurrent transitions (e.g. approve vs.
 * reject racing from PENDING — only one updateMany matches and wins) but
 * gets the *duplicate same-target* case wrong: two concurrent `approve`
 * calls both read PENDING before either commits, both attempt
 * `WHERE status = 'PENDING'`, and the loser's update matches zero rows
 * even though the end state it wanted (APPROVED) was in fact achieved —
 * by the other call. Reporting that as a 409 "conflict" would be a false
 * positive against the documented idempotent-retry contract (see
 * docs/architecture/conversion-tracking.md#status-lifecycle): a caller
 * that legitimately fires the same approve request twice (a retried
 * webhook delivery, a double-clicked button) must see two successes, not
 * one success and one spurious conflict.
 *
 * Instead this takes a real row-level lock — `SELECT ... FOR UPDATE` —
 * before deciding anything, making the whole read-decide-write sequence
 * atomic per conversion row:
 *
 * 1. A concurrent second call to this function for the SAME conversion
 *    (same target status or a different one) blocks on the `FOR UPDATE`
 *    below until the first call's transaction commits or rolls back —
 *    there is no window where both calls observe the pre-transition
 *    status simultaneously, unlike the optimistic approach.
 * 2. Once unblocked, it re-reads the status fresh — reflecting whatever
 *    the previous holder just committed, not a stale value — and only
 *    THEN decides: already at the target status -> idempotent no-op, no
 *    audit write, whether that's because this is a plain repeated call
 *    or because a concurrent duplicate request got there first; not at
 *    the target and the transition is legal -> apply it and audit
 *    exactly once; not at the target and the transition is illegal
 *    (e.g. the target status lost a race to a conflicting transition,
 *    or this is a genuinely invalid transition from wherever the row
 *    now sits) -> 409, naming the actual current/target statuses.
 *
 * This guarantees, provably rather than by convention, that any number
 * of concurrent requests against one conversion — identical or
 * conflicting — produce exactly one state transition and exactly one
 * audit entry for it, with every other request either idempotently
 * succeeding or cleanly failing.
 *
 * organizationId is checked twice — once via getConversion() below
 * (fast-fail 404 before ever opening a transaction) and again in the
 * locking query's WHERE clause (belt-and-braces, since the query is raw
 * SQL rather than going through Prisma's normal org-scoped query
 * builder) — never trusted from a single check alone. organizationId
 * itself is immutable after creation (enforced by the
 * enforce_conversion_click_attribution trigger — see
 * packages/database's conversion_tracking_foundation migration), so
 * there is no window for it to change between the two checks.
 */
async function transitionConversionStatus(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  conversionId: string,
  targetStatus: ConversionStatus,
  auditAction: string,
) {
  await getConversion(prisma, organizationId, conversionId);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: ConversionStatus }[]>`
      SELECT status FROM conversions
      WHERE id = ${conversionId} AND "organizationId" = ${organizationId}
      FOR UPDATE
    `;
    const currentStatus = locked[0]?.status;
    if (!currentStatus) {
      throw ApiError.notFound("Conversion not found");
    }

    if (currentStatus === targetStatus) {
      // Idempotent no-op — reached either by a plain repeated call, or by
      // the loser of a same-target concurrent race once it acquires the
      // lock the winner already released. No audit entry: this specific
      // call caused no change.
      return tx.conversion.findUniqueOrThrow({ where: { id: conversionId } });
    }

    try {
      assertValidConversionStatusTransition(currentStatus, targetStatus);
    } catch (error) {
      if (error instanceof InvalidConversionStatusTransitionError) {
        throw ApiError.conflict(error.message);
      }
      throw error;
    }

    const updated = await tx.conversion.update({
      where: { id: conversionId },
      data: { status: targetStatus },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: auditAction,
      entityType: "Conversion",
      entityId: conversionId,
      metadata: { from: currentStatus, to: targetStatus },
    });

    return updated;
  });
}

export function approveConversion(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  conversionId: string,
) {
  return transitionConversionStatus(
    prisma,
    actorUserId,
    organizationId,
    conversionId,
    "APPROVED",
    "conversion.approved",
  );
}

export function rejectConversion(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  conversionId: string,
) {
  return transitionConversionStatus(
    prisma,
    actorUserId,
    organizationId,
    conversionId,
    "REJECTED",
    "conversion.rejected",
  );
}

export function reverseConversion(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  conversionId: string,
) {
  return transitionConversionStatus(
    prisma,
    actorUserId,
    organizationId,
    conversionId,
    "REVERSED",
    "conversion.reversed",
  );
}
