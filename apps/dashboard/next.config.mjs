import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Production containerization (Phase 13): emit a self-contained
  // `.next/standalone` server (only the node_modules this app actually
  // traces as used) so the production Docker image
  // (apps/dashboard/Dockerfile) doesn't need to ship the whole pnpm
  // workspace's node_modules. `outputFileTracingRoot` points at the
  // monorepo root, not this app's own directory, so Next's file tracer
  // can see and correctly prune the workspace — the standard, safe
  // setting for any pnpm-workspace Next.js app.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Next's dev-mode "building..." badge floats bottom-left, which
  // overlaps the app shell's own bottom-left "Sign out" control at
  // common viewport sizes and swallows clicks meant for it. Disabling
  // both indicators here only affects local development, not production.
  devIndicators: {
    buildActivity: false,
    appIsrStatus: false,
  },
  // Phase 12 security hardening pass: apps/api and apps/tracker already
  // set an explicit CSP via @fastify/helmet; the dashboard (a separate
  // Next.js origin, session-cookie authenticated) had no equivalent
  // response headers. This is an internal admin tool, not part of the
  // Google Transparent Click Tracker surface, but "missing security
  // headers" was a real, fixable gap found during this phase's general
  // hardening review.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
