import { z } from "zod";

/**
 * Canonical environment schema for backend services (api, tracker).
 * Values are validated eagerly at process startup so misconfiguration fails
 * fast instead of surfacing as a confusing runtime error later.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters long")
    .refine((value) => !/^replace-with/i.test(value), {
      message: "AUTH_SECRET still contains the placeholder value from .env.example",
    }),

  APP_URL: z.string().url("APP_URL must be a valid URL"),
  API_URL: z.string().url("API_URL must be a valid URL"),
  TRACKER_URL: z.string().url("TRACKER_URL must be a valid URL"),

  API_PORT: z.coerce.number().int().positive().default(4000),
  TRACKER_PORT: z.coerce.number().int().positive().default(4100),

  // Salt for one-way hashing a click's IP address (apps/tracker never
  // stores a raw IP — see Click.ipHash). Optional: falls back to
  // AUTH_SECRET at the call site if unset, so no new required config is
  // introduced. Set explicitly in production to decouple IP-hash
  // derivation from the session-signing secret (e.g. so rotating one
  // doesn't silently change the other's output).
  CLICK_IP_HASH_SALT: z.string().min(16).optional(),

  // Shared secret that a trusted CDN/edge must inject as the
  // x-adstrackio-edge-secret header before apps/tracker will trust ANY
  // geo header on a request (cf-ipcountry / x-vercel-ip-country /
  // cloudfront-viewer-country) for Phase 8 COUNTRY routing-rule
  // conditions — see packages/shared/src/routing-signals.ts and
  // docs/architecture/rules-routing.md#country-signal-trust-boundary.
  // Deliberately optional with no default: unset (the default, matching
  // NullGeoLocationProvider's own off-by-default precedent) means COUNTRY
  // never matches for ANY request, geo header present or not — a client
  // can never make itself trusted by merely sending a geo header. Set
  // this in production ONLY once your CDN/edge is configured to inject
  // the matching secret header on every request it forwards to this
  // service (and to strip/overwrite any client-supplied copy of that
  // header first) — see the docs link above for exact per-CDN setup.
  TRUSTED_EDGE_SECRET: z.string().min(16).optional(),
});

export type Env = z.infer<typeof envSchema>;
