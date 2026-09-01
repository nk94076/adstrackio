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
  await fastify.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });
});
