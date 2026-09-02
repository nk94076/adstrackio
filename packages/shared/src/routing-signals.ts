/**
 * Synchronous, header-only signal extraction for Rules & Routing Engine
 * (Phase 8) rule conditions — see routing-rules.ts's RoutingContext doc
 * comment for why this is deliberately separate from GeoLocationProvider
 * (Phase 4), which is async/best-effort and never awaited on the redirect
 * path. Everything here is a pure string read, safe to call unconditionally
 * on the tracker's hot path.
 */

/** Headers a CDN/edge proxy commonly injects with the viewer's country,
 * checked in this order and the first present one used. This is honest,
 * best-effort infrastructure, not a geolocation service of its own: with
 * no such CDN in front of the tracker (the default in this codebase's own
 * deployment — see docs/architecture/rules-routing.md#country-signal),
 * none of these headers are present and extractCountrySignal returns null,
 * so a COUNTRY condition simply never matches rather than guessing. */
const COUNTRY_HEADER_NAMES = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "cloudfront-viewer-country", // AWS CloudFront
] as const;

const VALID_COUNTRY_CODE = /^[A-Z]{2}$/;

/** Node/Fastify already lowercases incoming header names, matching this
 * module's lowercase COUNTRY_HEADER_NAMES entries — the same convention
 * apps/tracker's own header helpers (e.g. extractDetectionHeaderSignals)
 * already rely on. */
export type RoutingSignalHeaders = Record<string, string | string[] | undefined>;

/** Reads the first present, well-formed (2-letter alpha) country code from
 * the known CDN geo-header list. Never throws. A header present but
 * malformed (a CDN's placeholder like "XX", multi-value, or garbage) is
 * treated the same as absent — never forwarded as if it were real. */
export function extractCountrySignal(headers: RoutingSignalHeaders): string | null {
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
