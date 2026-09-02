import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "@adstrackio/config";
import { prisma } from "@adstrackio/database";
import { REDACT_PATHS } from "@adstrackio/logger";
import {
  NullGeoLocationProvider,
  type BotDetectionEngine,
  type GeoLocationProvider,
  type TrackingResolver,
  type UserAgentParser,
} from "@adstrackio/shared";
import { HeuristicBotDetectionEngine } from "./modules/bot-detection/heuristic-bot-detection-engine.js";
import { UaParserUserAgentParser } from "./modules/enrichment/ua-parser-user-agent-parser.js";
import { PrismaTrackingResolver } from "./modules/tracker/prisma-tracking-resolver.js";
import { registerTrackerRoutes } from "./modules/tracker/tracker.routes.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { securityPlugin } from "./plugins/security.js";

export interface BuildTrackerAppOptions {
  env: Env;
  logger?: boolean;
  resolver?: TrackingResolver;
  botDetectionEngine?: BotDetectionEngine;
  userAgentParser?: UserAgentParser;
  geoLocationProvider?: GeoLocationProvider;
}

/**
 * apps/tracker is a deliberately separate Fastify service from apps/api.
 *
 * Why a separate process/deployable:
 * - tracking traffic can become very high volume and needs to scale
 *   independently of the dashboard/API
 * - redirect latency must stay very low and must never be blocked by
 *   analytics or admin-plane work
 * - the Google-facing transparent redirect behavior needs to be
 *   independently auditable, which is easier when it isn't entangled with
 *   general API/auth code
 *
 * Phase 3 (Transparent Click Tracker) implements the real GET /:slug
 * redirect endpoint here — see modules/tracker/tracker.routes.ts and
 * docs/compliance/google-transparent-tracker.md for the architecture (the
 * request's own `redirection_url` parameter is the immediate next hop;
 * nothing here resolves or substitutes a hidden backend destination).
 */
export async function buildTrackerApp(options: BuildTrackerAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: (options.logger ?? true)
      ? {
          name: "tracker",
          level: options.env.NODE_ENV === "test" ? "silent" : "info",
          redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
        }
      : false,
    trustProxy: true,
  });

  await fastify.register(prismaPlugin);
  await fastify.register(securityPlugin);
  await fastify.register(errorHandlerPlugin);

  fastify.get("/health", async () => ({ status: "ok", service: "tracker" }));

  const resolver = options.resolver ?? new PrismaTrackingResolver(prisma);
  const botDetectionEngine = options.botDetectionEngine ?? new HeuristicBotDetectionEngine();
  const userAgentParser = options.userAgentParser ?? new UaParserUserAgentParser();
  // No geo provider is wired in by default — see
  // packages/shared/src/geo-location.ts for why this is deliberate, not a
  // placeholder to fill in later without noticing.
  const geoLocationProvider = options.geoLocationProvider ?? new NullGeoLocationProvider();
  // Falls back to AUTH_SECRET so no new required env var is introduced —
  // see packages/config/src/schema.ts for CLICK_IP_HASH_SALT.
  const ipHashSalt = options.env.CLICK_IP_HASH_SALT ?? options.env.AUTH_SECRET;

  await fastify.register(registerTrackerRoutes, {
    resolver,
    botDetectionEngine,
    userAgentParser,
    geoLocationProvider,
    ipHashSalt,
  });

  return fastify;
}
