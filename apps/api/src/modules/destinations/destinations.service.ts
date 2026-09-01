import type { PrismaClient, Prisma } from "@adstrackio/database";
import { ApiError, InvalidDestinationUrlError, normalizeDestinationUrl } from "@adstrackio/shared";
import type { CreateDestinationInput, UpdateDestinationInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";

function normalizeOrThrow(url: string): string {
  try {
    return normalizeDestinationUrl(url);
  } catch (error) {
    if (error instanceof InvalidDestinationUrlError) {
      throw ApiError.validation(error.message);
    }
    throw error;
  }
}

export async function createDestination(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateDestinationInput,
) {
  const url = normalizeOrThrow(input.url);

  return prisma.$transaction(async (tx) => {
    const destination = await tx.destination.create({
      data: {
        organizationId,
        name: input.name,
        url,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "destination.created",
      entityType: "Destination",
      entityId: destination.id,
    });

    return destination;
  });
}

export async function listDestinations(prisma: PrismaClient, organizationId: string) {
  return prisma.destination.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getDestination(
  prisma: PrismaClient,
  organizationId: string,
  destinationId: string,
) {
  const destination = await prisma.destination.findFirst({
    where: { id: destinationId, organizationId },
  });
  if (!destination) {
    throw ApiError.notFound("Destination not found");
  }
  return destination;
}

export async function updateDestination(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  destinationId: string,
  input: UpdateDestinationInput,
) {
  await getDestination(prisma, organizationId, destinationId);

  return prisma.$transaction(async (tx) => {
    const destination = await tx.destination.update({
      where: { id: destinationId },
      data: {
        name: input.name,
        url: input.url ? normalizeOrThrow(input.url) : undefined,
        isActive: input.isActive,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "destination.updated",
      entityType: "Destination",
      entityId: destination.id,
    });

    return destination;
  });
}
