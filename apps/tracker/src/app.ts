import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "@adstrackio/config";
import { REDACT_PATHS } from "@adstrackio/logger";
import { NotImplementedTrackingResolver, type TrackingResolver } from "@adstrackio/shared";

export interface BuildTrackerAppOptions {
  env: Env;
  logger?: boolean;
  resolver?: TrackingResolver;
}

/**
 * apps/tracker is a deliberately separate Fastify service from apps/api.
 *
 * Why a separate process/deployable:
 * - tracking traffic can become very high volume and needs to scale
 *   independently of the dashboard/API
 * - redirect latency must stay very low and must never be blocked by
 *   analytics or admin-plane work
 * - the future Google-facing transparent redirect behavior needs to be
 *   independently auditable, which is easier when it isn't entangled with
 *   general API/auth code
 *
 * Phase 1 only establishes this boundary. The actual redirect endpoint
 * (resolving hostname+slug -> Destination and recording a Click) is
 * Phase 3 (Transparent Click Tracker) — see
 * docs/compliance/google-transparent-tracker.md.
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

  const resolver = options.resolver ?? new NotImplementedTrackingResolver();

  fastify.get("/health", async () => ({ status: "ok", service: "tracker" }));

  // Not a real redirect endpoint. It proves the TrackingResolver boundary
  // is wired end-to-end while making it unambiguous that no resolution
  // logic exists yet, instead of silently 404ing or faking a redirect.
  fastify.get("/*", async (request, reply) => {
    try {
      await resolver.resolve({ hostname: request.hostname, slug: request.url });
    } catch (error) {
      reply.status(501).send({
        error: {
          code: "NOT_IMPLEMENTED",
          message: error instanceof Error ? error.message : "Not implemented",
        },
      });
    }
  });

  return fastify;
}
