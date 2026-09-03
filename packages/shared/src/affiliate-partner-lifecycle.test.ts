import { describe, expect, it } from "vitest";
import {
  CREATABLE_AFFILIATE_PARTNER_STATUSES,
  InvalidAffiliatePartnerStatusTransitionError,
  assertValidAffiliatePartnerStatusTransition,
  isValidAffiliatePartnerStatusTransition,
  type AffiliatePartnerStatus,
} from "./affiliate-partner-lifecycle.js";

const ALL_STATUSES: AffiliatePartnerStatus[] = ["PENDING", "ACTIVE", "PAUSED", "ARCHIVED"];

const LEGAL_TRANSITIONS: [AffiliatePartnerStatus, AffiliatePartnerStatus][] = [
  ["PENDING", "ACTIVE"],
  ["PENDING", "ARCHIVED"],
  ["ACTIVE", "PAUSED"],
  ["ACTIVE", "ARCHIVED"],
  ["PAUSED", "ACTIVE"],
  ["PAUSED", "ARCHIVED"],
];

describe("affiliate partner lifecycle", () => {
  it.each(LEGAL_TRANSITIONS)("allows %s -> %s", (from, to) => {
    expect(isValidAffiliatePartnerStatusTransition(from, to)).toBe(true);
    expect(() => assertValidAffiliatePartnerStatusTransition(from, to)).not.toThrow();
  });

  it.each(ALL_STATUSES)("treats %s -> itself as a legal no-op", (status) => {
    expect(isValidAffiliatePartnerStatusTransition(status, status)).toBe(true);
    expect(() => assertValidAffiliatePartnerStatusTransition(status, status)).not.toThrow();
  });

  it("rejects every transition out of ARCHIVED (terminal state)", () => {
    for (const to of ["PENDING", "ACTIVE", "PAUSED"] as AffiliatePartnerStatus[]) {
      expect(isValidAffiliatePartnerStatusTransition("ARCHIVED", to)).toBe(false);
      expect(() => assertValidAffiliatePartnerStatusTransition("ARCHIVED", to)).toThrow(
        InvalidAffiliatePartnerStatusTransitionError,
      );
    }
  });

  it("rejects PENDING -> PAUSED (a partner must be activated before it can be paused)", () => {
    expect(isValidAffiliatePartnerStatusTransition("PENDING", "PAUSED")).toBe(false);
    expect(() => assertValidAffiliatePartnerStatusTransition("PENDING", "PAUSED")).toThrow(
      InvalidAffiliatePartnerStatusTransitionError,
    );
  });

  it("rejects ACTIVE -> PENDING and PAUSED -> PENDING (no going back to PENDING)", () => {
    expect(isValidAffiliatePartnerStatusTransition("ACTIVE", "PENDING")).toBe(false);
    expect(isValidAffiliatePartnerStatusTransition("PAUSED", "PENDING")).toBe(false);
  });

  it("error carries the from/to statuses and a distinct message for the reactivation case", () => {
    try {
      assertValidAffiliatePartnerStatusTransition("ARCHIVED", "ACTIVE");
      throw new Error("expected assertValidAffiliatePartnerStatusTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAffiliatePartnerStatusTransitionError);
      const err = error as InvalidAffiliatePartnerStatusTransitionError;
      expect(err.from).toBe("ARCHIVED");
      expect(err.to).toBe("ACTIVE");
      expect(err.message).toBe("Cannot transition affiliate partner from ARCHIVED to ACTIVE");
    }
  });

  it("CREATABLE_AFFILIATE_PARTNER_STATUSES excludes PAUSED and ARCHIVED", () => {
    expect(CREATABLE_AFFILIATE_PARTNER_STATUSES).toEqual(["PENDING", "ACTIVE"]);
  });
});
