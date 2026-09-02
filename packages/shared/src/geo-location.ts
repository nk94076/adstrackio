/**
 * Plug-in boundary for IP-based geolocation enrichment (Phase 4: Click
 * Analytics). No concrete network-backed implementation exists in this
 * codebase — the default is NullGeoLocationProvider, which always
 * resolves to "nothing known" without making any lookup at all. This is
 * deliberate, not a placeholder to be embarrassed about:
 *
 * - It keeps geo enrichment optional infrastructure, not a hard runtime
 *   dependency for basic click tracking to work at all.
 * - It avoids adding a paid third-party GeoIP service (or its API key)
 *   as a requirement just to record a click.
 * - It keeps the tracker's hot path free of a network call by default.
 *   `lookup` is async precisely because a real implementation is expected
 *   to be a remote network call (e.g. a hosted geo API) — the caller
 *   (apps/tracker's recordClick) guarantees it is never awaited on the
 *   redirect path regardless of how slow or unreliable a configured
 *   provider is: the lookup runs in the background, after the Click row
 *   is already written and the redirect already sent, with its result
 *   applied via a follow-up update if/when it resolves. See
 *   docs/architecture/click-analytics.md for the full design. A local,
 *   file-backed database lookup (e.g. MaxMind GeoLite2) is still a
 *   reasonable choice when available — it avoids depending on a
 *   third-party service's uptime — but a network-backed implementation is
 *   not a latency risk the way it would be if the lookup were awaited
 *   inline.
 *
 * Privacy note on the input: `lookup` takes the request's raw IP address,
 * the same transient value used to compute Click.ipHash — a geo lookup is
 * fundamentally impossible from a one-way hash, since hashing destroys
 * exactly the structure a geo database indexes on. "Privacy-safe" here
 * describes the OUTPUT and what gets persisted, not the input: the raw IP
 * is used in memory for this one call and then discarded, mirroring how
 * hashIp already uses it transiently — nothing in this codebase writes a
 * raw IP to the database. Only the coarse-grained GeoLocationResult
 * (country/region/city/timezone) is ever stored, on the Click row.
 */
export interface GeoLocationResult {
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
}

export const UNKNOWN_GEO_LOCATION: GeoLocationResult = {
  country: null,
  region: null,
  city: null,
  timezone: null,
};

export interface GeoLocationProvider {
  lookup(ip: string): Promise<GeoLocationResult>;
}

/** Default provider: no lookup is performed, ever. See module doc above. */
export class NullGeoLocationProvider implements GeoLocationProvider {
  lookup(_ip: string): Promise<GeoLocationResult> {
    return Promise.resolve(UNKNOWN_GEO_LOCATION);
  }
}
