import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Synchronous, header-only signal extraction for Rules & Routing Engine
 * (Phase 8) rule conditions — see routing-rules.ts's RoutingContext doc
 * comment for why this is deliberately separate from GeoLocationProvider
 * (Phase 4), which is async/best-effort and never awaited on the redirect
 * path. Everything here is a pure, local, synchronous computation — no
 * I/O, no network calls — safe to call unconditionally on the tracker's
 * hot path.
 *
 * ## Trust boundary (read before touching COUNTRY extraction)
 *
 * A CDN-injected geo header (`cf-ipcountry` etc.) is just an HTTP header
 * like any other — an ordinary direct client can set it to whatever value
 * it wants unless something actually stops that request from reaching
 * this service without first passing through the real CDN. Validating
 * that a header's *value* looks like a well-formed 2-letter country code
 * proves nothing about who *sent* it — an earlier version of this module
 * treated mere presence of one of these header names as sufficient, which
 * is a spoofable, non-boundary and was rejected as such: see this
 * module's own git history / PR #9 review for the finding this fixed.
 *
 * The real boundary implemented here is a shared secret
 * (`TRUSTED_EDGE_SECRET`, `packages/config`): a value known only to this
 * service's own server-side configuration and to whatever CDN/edge the
 * deploying operator has configured to inject it as the
 * `x-adstrackio-edge-secret` request header on every request it forwards
 * here (and to strip or overwrite any client-supplied copy of that header
 * first, so a client can never simply send its own). A request is only
 * ever treated as having passed through a trusted edge if that header's
 * value exactly matches the configured secret, compared in constant time
 * so response timing cannot be used to guess it byte-by-byte.
 *
 * `TRUSTED_EDGE_SECRET` is unset by default (mirroring
 * `NullGeoLocationProvider`'s own off-by-default precedent) — with no
 * secret configured, `isTrustedEdgeRequest` is always false and
 * `extractCountrySignal` always returns null, for every request,
 * regardless of which geo headers it carries. This is a deliberate,
 * fail-closed default: COUNTRY routing is inert until an operator
 * explicitly configures both sides of the boundary (their CDN AND this
 * service's `TRUSTED_EDGE_SECRET`), not merely by fronting the tracker
 * with a CDN and doing nothing else. See
 * docs/architecture/rules-routing.md#country-signal-trust-boundary for
 * the exact per-CDN configuration an operator needs to do to turn this
 * on, and docs/architecture/security.md for the full threat-model
 * writeup.
 */

/** Header a trusted CDN/edge must inject, carrying TRUSTED_EDGE_SECRET's
 * exact value, before any geo header on the same request is trusted. */
export const TRUSTED_EDGE_SECRET_HEADER = "x-adstrackio-edge-secret";

/** Headers a CDN/edge commonly injects with the viewer's country. Only
 * ever consulted when isTrustedEdgeRequest has already confirmed this
 * specific request passed through the configured trusted edge — see the
 * module doc above. Checked in this order, the first present one used. */
const COUNTRY_HEADER_NAMES = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "cloudfront-viewer-country", // AWS CloudFront
] as const;

const VALID_COUNTRY_CODE = /^[A-Z]{2}$/;

/** Node/Fastify already lowercases incoming header names, matching this
 * module's lowercase header name constants — the same convention
 * apps/tracker's own header helpers (e.g. extractDetectionHeaderSignals)
 * already rely on. */
export type RoutingSignalHeaders = Record<string, string | string[] | undefined>;

/** Fixed-length-digest constant-time string comparison — hashing both
 * inputs first means the comparison always operates on two 32-byte
 * buffers regardless of the two strings' own lengths, so this never has
 * to special-case (and potentially leak via early-return timing) a
 * length mismatch the way a naive direct timingSafeEqual on the raw
 * strings would. */
function constantTimeStringsEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * True only if this specific request carries the exact configured
 * TRUSTED_EDGE_SECRET as its x-adstrackio-edge-secret header. False for
 * every request when `trustedEdgeSecret` is undefined (no boundary
 * configured) — this is the fail-closed default, not an edge case to
 * special-case elsewhere.
 */
export function isTrustedEdgeRequest(
  headers: RoutingSignalHeaders,
  trustedEdgeSecret: string | undefined,
): boolean {
  if (!trustedEdgeSecret) return false;
  const raw = headers[TRUSTED_EDGE_SECRET_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return false;
  return constantTimeStringsEqual(value, trustedEdgeSecret);
}

/**
 * Reads the first present, well-formed (2-letter alpha) country code from
 * the known CDN geo-header list — but ONLY when `isTrustedEdgeRequest`
 * confirms this request actually passed through the configured trusted
 * edge. A geo header on an untrusted request (no secret configured, or a
 * missing/wrong secret header — including a client that copies a real
 * CDN header name into its own direct request, hoping to spoof it) is
 * never read at all: this returns null before even looking at
 * COUNTRY_HEADER_NAMES. Never throws.
 */
export function extractCountrySignal(
  headers: RoutingSignalHeaders,
  trustedEdgeSecret: string | undefined,
): string | null {
  if (!isTrustedEdgeRequest(headers, trustedEdgeSecret)) {
    return null;
  }

  for (const name of COUNTRY_HEADER_NAMES) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") continue;
    const normalized = value.trim().toUpperCase();
    if (VALID_COUNTRY_CODE.test(normalized)) {
      return normalized;
    }
  }
  return null;
}

/** Parses the hostname out of a Referer header value. Never throws — a
 * missing or malformed Referer (not present, empty, not a valid absolute
 * URL) resolves to null, the same "unknown signal" null that
 * routing-rules.ts's matchesCondition already treats as fail-closed. */
export function extractReferrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
