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
 * Shared by approveConversion/rejectConversion/reverseConversion — same
 * validate-then-conditional-updateMany pattern as campaigns.service.ts's
 * transitionCampaignStatus (Phase 6): the transition is validated against
 * packages/shared/src/conversion-lifecycle.ts, then applied via an
 * updateMany guarded on the status just read (not an unconditional
 * update), so a concurrent status change can't be silently clobbered —
 * it surfaces as a 409 asking the caller to retry.
 */
async function transitionConversionStatus(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  conversionId: string,
  targetStatus: ConversionStatus,
  auditAction: string,
) {
  const conversion = await getConversion(prisma, organizationId, conversionId);

  try {
    assertValidConversionStatusTransition(conversion.status as ConversionStatus, targetStatus);
  } catch (error) {
    if (error instanceof InvalidConversionStatusTransitionError) {
      throw ApiError.conflict(error.message);
    }
    throw error;
  }

  if (conversion.status === targetStatus) {
    // Idempotent no-op: re-approving an already-APPROVED conversion (etc.)
    // succeeds without writing a redundant audit entry.
    return conversion;
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.conversion.updateMany({
      where: { id: conversionId, organizationId, status: conversion.status },
      data: { status: targetStatus },
    });

    if (count === 0) {
      throw ApiError.conflict("Conversion status changed concurrently; please retry");
    }

    const updated = await tx.conversion.findUniqueOrThrow({ where: { id: conversionId } });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: auditAction,
      entityType: "Conversion",
      entityId: conversionId,
      metadata: { from: conversion.status, to: targetStatus },
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
