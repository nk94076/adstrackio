/**
 * Campaign status lifecycle (Phase 6: Campaign Manager).
 *
 * A small, explicit state machine — deliberately not a generic workflow
 * engine — mirroring the pattern already established by
 * bot-traffic-policy.ts: pure, synchronous, no I/O, safe to call from any
 * layer. The API layer (apps/api/src/modules/campaigns/campaigns.service.ts)
 * is the only place a Campaign.status column is ever written; this module
 * is what it consults before doing so, so "can this transition happen" has
 * exactly one answer shared by every caller (the explicit lifecycle
 * endpoints and, indirectly, campaign creation).
 */
export type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";

/**
 * Legal transitions, DRAFT -> ACTIVE/ARCHIVED, ACTIVE <-> PAUSED,
 * ACTIVE/PAUSED -> ARCHIVED, ARCHIVED is terminal (no way back to any other
 * state — a real campaign that's done is done, not silently reactivatable).
 */
const CAMPAIGN_STATUS_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export class InvalidCampaignStatusTransitionError extends Error {
  constructor(
    public readonly from: CampaignStatus,
    public readonly to: CampaignStatus,
  ) {
    super(
      to === from
        ? `Campaign is already ${from}`
        : `Cannot transition campaign from ${from} to ${to}`,
    );
    this.name = "InvalidCampaignStatusTransitionError";
  }
}

/** True for a no-op (from === to) as well as any transition on the legal list. */
export function isValidCampaignStatusTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return from === to || CAMPAIGN_STATUS_TRANSITIONS[from].includes(to);
}

/** Throws InvalidCampaignStatusTransitionError for anything not legal. */
export function assertValidCampaignStatusTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!isValidCampaignStatusTransition(from, to)) {
    throw new InvalidCampaignStatusTransitionError(from, to);
  }
}

/** Statuses a campaign may be created directly in. PAUSED/ARCHIVED describe
 * something that was once ACTIVE — creating a campaign directly into either
 * would be a fabricated history, not a real lifecycle transition. */
export const CREATABLE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["DRAFT", "ACTIVE"];
