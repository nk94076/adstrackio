import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "@adstrackio/config";
import { REDACT_PATHS } from "@adstrackio/logger";
import { prismaPlugin } from "./plugins/prisma.js";
import { securityPlugin } from "./plugins/security.js";
import { authPlugin } from "./plugins/auth.js";
import { apiKeyAuthPlugin } from "./plugins/api-key-auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerOrganizationRoutes } from "./modules/organizations/organizations.routes.js";
import { registerDomainRoutes } from "./modules/domains/domains.routes.js";
import { registerDestinationRoutes } from "./modules/destinations/destinations.routes.js";
import { registerCampaignRoutes } from "./modules/campaigns/campaigns.routes.js";
import { registerTrackingLinkRoutes } from "./modules/tracking-links/tracking-links.routes.js";
import { registerReferralRoutes } from "./modules/referrals/referrals.routes.js";
import { registerAuditLogRoutes } from "./modules/audit-logs/audit-logs.routes.js";
import { registerAnalyticsRoutes } from "./modules/analytics/analytics.routes.js";
import { registerConversionRoutes } from "./modules/conversions/conversions.routes.js";
import { registerRoutingRuleRoutes } from "./modules/routing-rules/routing-rules.routes.js";
import { registerAffiliatePartnerRoutes } from "./modules/affiliate-partners/affiliate-partners.routes.js";
import { registerReportRoutes } from "./modules/reports/reports.routes.js";
import { registerApiKeyRoutes } from "./modules/api-keys/api-keys.routes.js";
import { registerWebhookRoutes } from "./modules/webhooks/webhooks.routes.js";

export interface BuildAppOptions {
  env: Env;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: (options.logger ?? true)
      ? {
          name: "api",
          level: options.env.NODE_ENV === "test" ? "silent" : "info",
          redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
        }
      : false,
    trustProxy: true,
  });

  await fastify.register(prismaPlugin);
  await fastify.register(securityPlugin, { env: options.env });
  await fastify.register(authPlugin, { env: options.env });
  await fastify.register(apiKeyAuthPlugin);
  await fastify.register(errorHandlerPlugin);

  fastify.get("/health", async () => ({ status: "ok", service: "api" }));

  // Liveness (/health, above) only proves the process is running.
  // Readiness additionally proves it can actually serve requests that
  // touch the database — a load balancer/orchestrator should stop
  // routing traffic here (without restarting the process) when this
  // returns 503, e.g. during a database failover. Deliberately not on
  // any hot request path: it is its own endpoint, checked out-of-band by
  // infrastructure, never called as part of handling a real request.
  fastify.get("/ready", async (_request, reply) => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      return { status: "ready", service: "api" };
    } catch (error) {
      fastify.log.error(error, "readiness check failed: database unreachable");
      reply.status(503);
      return { status: "not_ready", service: "api" };
    }
  });

  await fastify.register(
    async (v1) => {
      await registerAuthRoutes(v1, { env: options.env });
      await registerOrganizationRoutes(v1);
      await registerDomainRoutes(v1);
      await registerDestinationRoutes(v1);
      await registerCampaignRoutes(v1);
      await registerTrackingLinkRoutes(v1);
      await registerReferralRoutes(v1);
      await registerAuditLogRoutes(v1);
      await registerAnalyticsRoutes(v1);
      await registerConversionRoutes(v1);
      await registerRoutingRuleRoutes(v1);
      await registerAffiliatePartnerRoutes(v1);
      await registerReportRoutes(v1);
      await registerApiKeyRoutes(v1);
      await registerWebhookRoutes(v1, { env: options.env });
    },
    { prefix: "/api/v1" },
  );

  return fastify;
}
