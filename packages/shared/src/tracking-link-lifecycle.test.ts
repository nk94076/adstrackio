import { describe, expect, it } from "vitest";
import {
  CREATABLE_TRACKING_LINK_STATUSES,
  InvalidTrackingLinkStatusTransitionError,
  assertValidTrackingLinkStatusTransition,
  isValidTrackingLinkStatusTransition,
  type TrackingLinkStatus,
} from "./tracking-link-lifecycle.js";

const ALL_STATUSES: TrackingLinkStatus[] = ["ACTIVE", "PAUSED", "ARCHIVED"];

const LEGAL_TRANSITIONS: [TrackingLinkStatus, TrackingLinkStatus][] = [
  ["ACTIVE", "PAUSED"],
  ["ACTIVE", "ARCHIVED"],
  ["PAUSED", "ACTIVE"],
  ["PAUSED", "ARCHIVED"],
];

describe("tracking link lifecycle", () => {
  it.each(LEGAL_TRANSITIONS)("allows %s -> %s", (from, to) => {
    expect(isValidTrackingLinkStatusTransition(from, to)).toBe(true);
    expect(() => assertValidTrackingLinkStatusTransition(from, to)).not.toThrow();
  });

  it.each(ALL_STATUSES)("treats %s -> itself as a legal no-op", (status) => {
    expect(isValidTrackingLinkStatusTransition(status, status)).toBe(true);
  });

  it("rejects every transition out of ARCHIVED (terminal state)", () => {
    for (const to of ["ACTIVE", "PAUSED"] as TrackingLinkStatus[]) {
      expect(isValidTrackingLinkStatusTransition("ARCHIVED", to)).toBe(false);
      expect(() => assertValidTrackingLinkStatusTransition("ARCHIVED", to)).toThrow(
        InvalidTrackingLinkStatusTransitionError,
      );
    }
  });

  it("error carries the from/to statuses", () => {
    try {
      assertValidTrackingLinkStatusTransition("ARCHIVED", "PAUSED");
      throw new Error("expected assertValidTrackingLinkStatusTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTrackingLinkStatusTransitionError);
      const err = error as InvalidTrackingLinkStatusTransitionError;
      expect(err.from).toBe("ARCHIVED");
      expect(err.to).toBe("PAUSED");
      expect(err.message).toBe("Cannot transition tracking link from ARCHIVED to PAUSED");
    }
  });

  it("CREATABLE_TRACKING_LINK_STATUSES excludes ARCHIVED", () => {
    expect(CREATABLE_TRACKING_LINK_STATUSES).toEqual(["ACTIVE", "PAUSED"]);
  });
});
