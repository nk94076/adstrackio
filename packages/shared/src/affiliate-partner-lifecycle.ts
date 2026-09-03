/**
 * Affiliate partner status lifecycle (Phase 9: Affiliate/Partner System).
 *
 * A small, explicit state machine — the same pattern established by
 * campaign-lifecycle.ts/tracking-link-lifecycle.ts/conversion-lifecycle.ts:
 * pure, synchronous, no I/O, safe to call from any layer. The API layer
 * (apps/api/src/modules/affiliate-partners/affiliate-partners.service.ts)
 * is the only place an AffiliatePartner.status column is ever written; this
 * module is what it consults before doing so.
 */
export type AffiliatePartnerStatus = "PENDING" | "ACTIVE" | "PAUSED" | "ARCHIVED";

/**
 * Legal transitions: PENDING -> ACTIVE/ARCHIVED, ACTIVE <-> PAUSED,
 * ACTIVE/PAUSED -> ARCHIVED. ARCHIVED is terminal — the same "done is done,
 * not silently reactivatable" rule Campaign's own lifecycle established.
 */
const AFFILIATE_PARTNER_STATUS_TRANSITIONS: Record<
  AffiliatePartnerStatus,
  readonly AffiliatePartnerStatus[]
> = {
  PENDING: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export class InvalidAffiliatePartnerStatusTransitionError extends Error {
  constructor(
    public readonly from: AffiliatePartnerStatus,
    public readonly to: AffiliatePartnerStatus,
  ) {
    super(
      to === from
        ? `Affiliate partner is already ${from}`
        : `Cannot transition affiliate partner from ${from} to ${to}`,
    );
    this.name = "InvalidAffiliatePartnerStatusTransitionError";
  }
}

/** True for a no-op (from === to) as well as any transition on the legal list. */
export function isValidAffiliatePartnerStatusTransition(
  from: AffiliatePartnerStatus,
  to: AffiliatePartnerStatus,
): boolean {
  return from === to || AFFILIATE_PARTNER_STATUS_TRANSITIONS[from].includes(to);
}

/** Throws InvalidAffiliatePartnerStatusTransitionError for anything not legal. */
export function assertValidAffiliatePartnerStatusTransition(
  from: AffiliatePartnerStatus,
  to: AffiliatePartnerStatus,
): void {
  if (!isValidAffiliatePartnerStatusTransition(from, to)) {
    throw new InvalidAffiliatePartnerStatusTransitionError(from, to);
  }
}

/** Statuses a partner may be created directly in. PAUSED/ARCHIVED describe
 * something that was once ACTIVE — creating a partner directly into either
 * would be a fabricated history, not a real lifecycle transition. Mirrors
 * CREATABLE_CAMPAIGN_STATUSES exactly. */
export const CREATABLE_AFFILIATE_PARTNER_STATUSES: readonly AffiliatePartnerStatus[] = [
  "PENDING",
  "ACTIVE",
];
