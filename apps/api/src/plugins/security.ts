import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { Env } from "@adstrackio/config";

export const securityPlugin = fp(async function securityPlugin(
  fastify: FastifyInstance,
  opts: { env: Env },
) {
  await fastify.register(helmet, {
    // The dashboard is a separate Next.js origin; the API itself serves no
    // HTML, so a strict default-src is safe and CSP does not need to allow
    // the dashboard's asset origins.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
      },
    },
  });

  await fastify.register(cors, {
    origin: [opts.env.APP_URL],
    credentials: true,
  });

  await fastify.register(cookie, {
    secret: opts.env.AUTH_SECRET,
  });

  // Global baseline; authentication routes apply a stricter limit on top
  // of this via a per-route config (see modules/auth/auth.routes.ts).
  //
  // Relaxed for NODE_ENV=test for the same reason authRateLimit() is
  // (modules/auth/auth.routes.ts): Fastify's inject() has no real
  // per-request IP, so every request across an entire test file shares
  // one rate-limit bucket. A test file with enough setup calls and
  // concurrent-request tests (e.g. apps/api/test/conversion-tracking.test.ts,
  // which fires several Promise.all pairs against the same Fastify
  // instance to test status-transition concurrency) can otherwise exceed
  // 300 requests within the run and start failing on 429s that have
  // nothing to do with what the test is actually checking. The production
  // value (300/min) is unchanged; only the test-environment ceiling moves.
  await fastify.register(rateLimit, {
    global: true,
    max: opts.env.NODE_ENV === "test" ? 10_000 : 300,
    timeWindow: "1 minute",
  });
});
