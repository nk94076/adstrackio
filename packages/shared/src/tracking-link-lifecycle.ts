/**
 * TrackingLink status lifecycle (Phase 6: Campaign Manager). Same shape and
 * rationale as campaign-lifecycle.ts, scoped to the three statuses a
 * TrackingLink actually has (no DRAFT — a tracking link is either serving
 * traffic, deliberately paused, or retired).
 */
export type TrackingLinkStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

const TRACKING_LINK_STATUS_TRANSITIONS: Record<TrackingLinkStatus, readonly TrackingLinkStatus[]> = {
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export class InvalidTrackingLinkStatusTransitionError extends Error {
  constructor(
    public readonly from: TrackingLinkStatus,
    public readonly to: TrackingLinkStatus,
  ) {
    super(
      to === from
        ? `Tracking link is already ${from}`
        : `Cannot transition tracking link from ${from} to ${to}`,
    );
    this.name = "InvalidTrackingLinkStatusTransitionError";
  }
}

export function isValidTrackingLinkStatusTransition(
  from: TrackingLinkStatus,
  to: TrackingLinkStatus,
): boolean {
  return from === to || TRACKING_LINK_STATUS_TRANSITIONS[from].includes(to);
}

export function assertValidTrackingLinkStatusTransition(
  from: TrackingLinkStatus,
  to: TrackingLinkStatus,
): void {
  if (!isValidTrackingLinkStatusTransition(from, to)) {
    throw new InvalidTrackingLinkStatusTransitionError(from, to);
  }
}

/** ARCHIVED describes a link that was retired, not a starting point — a
 * tracking link is always created ACTIVE or deliberately PAUSED. */
export const CREATABLE_TRACKING_LINK_STATUSES: readonly TrackingLinkStatus[] = ["ACTIVE", "PAUSED"];
