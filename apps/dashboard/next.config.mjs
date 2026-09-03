/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
