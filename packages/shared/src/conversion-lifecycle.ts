/**
 * Conversion status lifecycle (Phase 7: Conversion Tracking). Same shape
 * and rationale as campaign-lifecycle.ts / tracking-link-lifecycle.ts
 * (Phase 6): pure, synchronous, no I/O, the single source of truth every
 * lifecycle-changing endpoint consults before writing a status.
 */
export type ConversionStatus = "PENDING" | "APPROVED" | "REJECTED" | "REVERSED";

/**
 * PENDING -> APPROVED or REJECTED (the initial review decision).
 * APPROVED -> REVERSED (a later chargeback/refund/fraud finding).
 * REJECTED and REVERSED are both terminal — in particular REJECTED can
 * never become APPROVED (that would require re-review through a new
 * conversion, not resurrecting a rejected one) and REVERSED can never
 * become APPROVED again (a reversal is final, not a pause).
 */
const CONVERSION_STATUS_TRANSITIONS: Record<ConversionStatus, readonly ConversionStatus[]> = {
  PENDING: ["APPROVED", "REJECTED"],
  APPROVED: ["REVERSED"],
  REJECTED: [],
  REVERSED: [],
};

export class InvalidConversionStatusTransitionError extends Error {
  constructor(
    public readonly from: ConversionStatus,
    public readonly to: ConversionStatus,
  ) {
    super(
      to === from
        ? `Conversion is already ${from}`
        : `Cannot transition conversion from ${from} to ${to}`,
    );
    this.name = "InvalidConversionStatusTransitionError";
  }
}

/** True for a no-op (from === to) as well as any transition on the legal list. */
export function isValidConversionStatusTransition(
  from: ConversionStatus,
  to: ConversionStatus,
): boolean {
  return from === to || CONVERSION_STATUS_TRANSITIONS[from].includes(to);
}

/** Throws InvalidConversionStatusTransitionError for anything not legal. */
export function assertValidConversionStatusTransition(
  from: ConversionStatus,
  to: ConversionStatus,
): void {
  if (!isValidConversionStatusTransition(from, to)) {
    throw new InvalidConversionStatusTransitionError(from, to);
  }
}
