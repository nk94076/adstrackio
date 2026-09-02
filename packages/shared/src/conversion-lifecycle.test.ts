import { describe, expect, it } from "vitest";
import {
  InvalidConversionStatusTransitionError,
  assertValidConversionStatusTransition,
  isValidConversionStatusTransition,
  type ConversionStatus,
} from "./conversion-lifecycle.js";

const ALL_STATUSES: ConversionStatus[] = ["PENDING", "APPROVED", "REJECTED", "REVERSED"];

const LEGAL_TRANSITIONS: [ConversionStatus, ConversionStatus][] = [
  ["PENDING", "APPROVED"],
  ["PENDING", "REJECTED"],
  ["APPROVED", "REVERSED"],
];

describe("conversion lifecycle", () => {
  it.each(LEGAL_TRANSITIONS)("allows %s -> %s", (from, to) => {
    expect(isValidConversionStatusTransition(from, to)).toBe(true);
    expect(() => assertValidConversionStatusTransition(from, to)).not.toThrow();
  });

  it.each(ALL_STATUSES)("treats %s -> itself as a legal no-op", (status) => {
    expect(isValidConversionStatusTransition(status, status)).toBe(true);
    expect(() => assertValidConversionStatusTransition(status, status)).not.toThrow();
  });

  it("rejects every transition out of REJECTED (terminal state)", () => {
    for (const to of ["PENDING", "APPROVED", "REVERSED"] as ConversionStatus[]) {
      expect(isValidConversionStatusTransition("REJECTED", to)).toBe(false);
      expect(() => assertValidConversionStatusTransition("REJECTED", to)).toThrow(
        InvalidConversionStatusTransitionError,
      );
    }
  });

  it("rejects every transition out of REVERSED (terminal state)", () => {
    for (const to of ["PENDING", "APPROVED", "REJECTED"] as ConversionStatus[]) {
      expect(isValidConversionStatusTransition("REVERSED", to)).toBe(false);
      expect(() => assertValidConversionStatusTransition("REVERSED", to)).toThrow(
        InvalidConversionStatusTransitionError,
      );
    }
  });

  it("rejects PENDING -> REVERSED (must be APPROVED first)", () => {
    expect(isValidConversionStatusTransition("PENDING", "REVERSED")).toBe(false);
    expect(() => assertValidConversionStatusTransition("PENDING", "REVERSED")).toThrow(
      InvalidConversionStatusTransitionError,
    );
  });

  it("rejects APPROVED -> REJECTED (rejection only applies from PENDING)", () => {
    expect(isValidConversionStatusTransition("APPROVED", "REJECTED")).toBe(false);
  });

  it("error carries the from/to statuses and a clear message", () => {
    try {
      assertValidConversionStatusTransition("REJECTED", "APPROVED");
      throw new Error("expected assertValidConversionStatusTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConversionStatusTransitionError);
      const err = error as InvalidConversionStatusTransitionError;
      expect(err.from).toBe("REJECTED");
      expect(err.to).toBe("APPROVED");
      expect(err.message).toBe("Cannot transition conversion from REJECTED to APPROVED");
    }
  });
});
