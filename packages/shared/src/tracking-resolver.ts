/**
 * Architectural boundary for Phase 3 (Transparent Click Tracker).
 *
 * This interface defines how an inbound tracking request (hostname + slug)
 * will eventually be resolved to a Destination and recorded as a Click. It
 * intentionally has NO implementation in Phase 1 — apps/tracker exposes
 * only a health check. Defining the contract now lets apps/api's
 * TrackingLink CRUD and apps/tracker's future redirect engine be built
 * against the same shape without a later rewrite.
 *
 * Google Transparent Click Tracker requirement: resolution must be based
 * solely on the tracking link's own configured destination — never on
 * request parameters that could substitute an arbitrary destination.
 * See docs/compliance/google-transparent-tracker.md.
 */
export interface TrackingResolutionRequest {
  hostname: string;
  slug: string;
  userAgent?: string;
  ipHash?: string;
  referrer?: string;
}

export interface TrackingResolutionResult {
  trackingLinkId: string;
  campaignId: string;
  destinationUrl: string;
}

export interface TrackingResolver {
  resolve(request: TrackingResolutionRequest): Promise<TrackingResolutionResult>;
}

/**
 * Explicit "not implemented yet" stub so the interface can be wired into
 * apps/tracker's dependency graph without pretending the redirect engine
 * works. Throws unconditionally.
 */
export class NotImplementedTrackingResolver implements TrackingResolver {
  resolve(_request: TrackingResolutionRequest): Promise<TrackingResolutionResult> {
    return Promise.reject(
      new Error(
        "TrackingResolver is not implemented in Phase 1 (Foundation). " +
          "It is planned for Phase 3 (Transparent Click Tracker).",
      ),
    );
  }
}
