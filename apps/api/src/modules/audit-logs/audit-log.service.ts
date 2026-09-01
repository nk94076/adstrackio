import type { PrismaClient, Prisma } from "@adstrackio/database";

export interface WriteAuditLogInput {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  /** Must never contain secrets (passwords, tokens, session cookies). */
  metadata?: Record<string, unknown>;
}

/**
 * Writes one audit log entry. Accepts a Prisma transaction client so callers
 * can record the audit entry atomically alongside the mutation it describes.
 */
export async function writeAuditLog(
  db: PrismaClient | Prisma.TransactionClient,
  input: WriteAuditLogInput,
) {
  return db.auditLog.create({
    data: {
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

export interface ListAuditLogsOptions {
  organizationId: string;
  take?: number;
  cursor?: string;
}

export async function listAuditLogs(prisma: PrismaClient, options: ListAuditLogsOptions) {
  return prisma.auditLog.findMany({
    where: { organizationId: options.organizationId },
    orderBy: { createdAt: "desc" },
    take: options.take ?? 50,
    ...(options.cursor ? { skip: 1, cursor: { id: options.cursor } } : {}),
    include: {
      actor: { select: { id: true, name: true, email: true } },
    },
  });
}
