import helmet from "@fastify/helmet";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

/**
 * Minimal hardening for the tracker's own responses. Deliberately NOT
 * mirroring apps/api's full security plugin:
 * - No CORS: a redirect is a top-level navigation (Location header), not
 *   an XHR/fetch — CORS is irrelevant here and adding it would be dead
 *   weight on the hottest path in the system.
 * - No cookies: the tracker has no session concept.
 * - No rate limiting yet: real ad-click traffic can legitimately arrive
 *   in high-volume bursts from a shared egress IP (corporate NAT, mobile
 *   carrier CGNAT); a naive per-IP limit here risks dropping real clicks
 *   more than it stops abuse. Revisit with real traffic data before
 *   adding one (see docs/architecture/security.md known limitations).
 */
export const securityPlugin = fp(async function securityPlugin(fastify: FastifyInstance) {
  await fastify.register(helmet, {
    // The tracker serves only redirects and small JSON error bodies,
    // never HTML — a maximally restrictive CSP costs nothing here.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
      },
    },
  });
});
