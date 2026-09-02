import { describe, expect, it } from "vitest";
import {
  CREATABLE_CAMPAIGN_STATUSES,
  InvalidCampaignStatusTransitionError,
  assertValidCampaignStatusTransition,
  isValidCampaignStatusTransition,
  type CampaignStatus,
} from "./campaign-lifecycle.js";

const ALL_STATUSES: CampaignStatus[] = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"];

const LEGAL_TRANSITIONS: [CampaignStatus, CampaignStatus][] = [
  ["DRAFT", "ACTIVE"],
  ["DRAFT", "ARCHIVED"],
  ["ACTIVE", "PAUSED"],
  ["ACTIVE", "ARCHIVED"],
  ["PAUSED", "ACTIVE"],
  ["PAUSED", "ARCHIVED"],
];

describe("campaign lifecycle", () => {
  it.each(LEGAL_TRANSITIONS)("allows %s -> %s", (from, to) => {
    expect(isValidCampaignStatusTransition(from, to)).toBe(true);
    expect(() => assertValidCampaignStatusTransition(from, to)).not.toThrow();
  });

  it.each(ALL_STATUSES)("treats %s -> itself as a legal no-op", (status) => {
    expect(isValidCampaignStatusTransition(status, status)).toBe(true);
    expect(() => assertValidCampaignStatusTransition(status, status)).not.toThrow();
  });

  it("rejects every transition out of ARCHIVED (terminal state)", () => {
    for (const to of ["DRAFT", "ACTIVE", "PAUSED"] as CampaignStatus[]) {
      expect(isValidCampaignStatusTransition("ARCHIVED", to)).toBe(false);
      expect(() => assertValidCampaignStatusTransition("ARCHIVED", to)).toThrow(
        InvalidCampaignStatusTransitionError,
      );
    }
  });

  it("rejects DRAFT -> PAUSED (a campaign must be activated before it can be paused)", () => {
    expect(isValidCampaignStatusTransition("DRAFT", "PAUSED")).toBe(false);
    expect(() => assertValidCampaignStatusTransition("DRAFT", "PAUSED")).toThrow(
      InvalidCampaignStatusTransitionError,
    );
  });

  it("rejects ACTIVE -> DRAFT and PAUSED -> DRAFT (no going back to DRAFT)", () => {
    expect(isValidCampaignStatusTransition("ACTIVE", "DRAFT")).toBe(false);
    expect(isValidCampaignStatusTransition("PAUSED", "DRAFT")).toBe(false);
  });

  it("error carries the from/to statuses and a distinct message for the reactivation case", () => {
    try {
      assertValidCampaignStatusTransition("ARCHIVED", "ACTIVE");
      throw new Error("expected assertValidCampaignStatusTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCampaignStatusTransitionError);
      const err = error as InvalidCampaignStatusTransitionError;
      expect(err.from).toBe("ARCHIVED");
      expect(err.to).toBe("ACTIVE");
      expect(err.message).toBe("Cannot transition campaign from ARCHIVED to ACTIVE");
    }
  });

  it("CREATABLE_CAMPAIGN_STATUSES excludes PAUSED and ARCHIVED", () => {
    expect(CREATABLE_CAMPAIGN_STATUSES).toEqual(["DRAFT", "ACTIVE"]);
  });
});
