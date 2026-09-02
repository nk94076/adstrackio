/**
 * Architectural boundary for the Transparent Click Tracker (Phase 3).
 *
 * Phase 1 originally sketched this interface assuming the resolver would
 * hand back a backend-configured `destinationUrl` to redirect to. Phase 3
 * settled on a different, and more literally "transparent", architecture
 * instead: the immediate next hop is the request's OWN visible
 * `redirection_url` query parameter (validated by
 * `validateTransparentRedirectUrl` in transparent-redirect.ts), never a
 * value resolved from the database. See
 * docs/compliance/google-transparent-tracker.md for the full rationale.
 *
 * What TrackingResolver is still responsible for: turning
 * (hostname, slug) into the tracking link's identity and organization
 * context, and enforcing that only a verified+active domain and an
 * active link may serve traffic — i.e. authorization/existence, not
 * destination selection. It intentionally does NOT return a URL to
 * redirect to.
 */
import type { BotTrafficPolicy } from "./bot-traffic-policy.js";

export interface TrackingResolutionRequest {
  hostname: string;
  slug: string;
}

export interface TrackingResolutionResult {
  trackingLinkId: string;
  campaignId: string;
  organizationId: string;
  /** Server-configured Safe Page for bot/automated traffic on this
   * campaign, or null if none is configured (see Campaign.safePageUrl). */
  safePageUrl: string | null;
  /** Campaign-configured routing policy for SUSPICIOUS/UNKNOWN traffic
   * (Phase 5: Bot Detection Integration) — see
   * packages/shared/src/bot-traffic-policy.ts. */
  botTrafficPolicy: BotTrafficPolicy;
}

/** Why resolution failed — lets callers map to the right HTTP response
 * without parsing error message text. */
export type TrackingResolutionFailureReason =
  | "domain_not_found"
  | "domain_not_verified"
  | "domain_inactive"
  | "link_not_found"
  | "link_inactive";

export class TrackingResolutionError extends Error {
  constructor(
    public readonly reason: TrackingResolutionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "TrackingResolutionError";
  }
}

export interface TrackingResolver {
  resolve(request: TrackingResolutionRequest): Promise<TrackingResolutionResult>;
}

/**
 * Explicit "not implemented yet" stub so the interface can be wired into
 * apps/tracker's dependency graph without pretending the redirect engine
 * works, before a real implementation exists.
 */
export class NotImplementedTrackingResolver implements TrackingResolver {
  resolve(_request: TrackingResolutionRequest): Promise<TrackingResolutionResult> {
    return Promise.reject(
      new Error(
        "TrackingResolver has no implementation registered. " +
          "apps/tracker must supply a real resolver (e.g. PrismaTrackingResolver).",
      ),
    );
  }
}
