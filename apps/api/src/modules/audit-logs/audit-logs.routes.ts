import type { FastifyInstance } from "fastify";
import { listAuditLogs } from "./audit-log.service.js";

export async function registerAuditLogRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/audit-logs",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const { cursor } = request.query as { cursor?: string };

      const logs = await listAuditLogs(fastify.prisma, { organizationId, cursor });
      return { auditLogs: logs };
    },
  );
}
