import { describe, expect, it } from "vitest";
import { boundedMetadataSchema, createConversionSchema, MAX_FUTURE_CLOCK_SKEW_MS } from "./conversions.js";

const VALID_CLICK_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"; // well-formed UUID
const VALID_CUID = "cltk9d4xm00espdu70b3v511z"; // well-formed cuid, wrong format for clickId

function base(overrides: Record<string, unknown> = {}) {
  return { clickId: VALID_CLICK_ID, eventName: "purchase", ...overrides };
}

describe("createConversionSchema", () => {
  it("accepts a minimal valid payload (no value/currency/externalConversionId)", () => {
    expect(createConversionSchema.safeParse(base()).success).toBe(true);
  });

  it("accepts value+currency together and normalizes currency to uppercase", () => {
    const result = createConversionSchema.safeParse(base({ value: 19.99, currency: "usd" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currency).toBe("USD");
    }
  });

  it("rejects a Click.id-shaped cuid — clickId must be the UUID format the tracker actually generates", () => {
    const result = createConversionSchema.safeParse(base({ clickId: VALID_CUID }));
    expect(result.success).toBe(false);
  });

  it("rejects value without currency", () => {
    expect(createConversionSchema.safeParse(base({ value: 10 })).success).toBe(false);
  });

  it("rejects currency without value", () => {
    expect(createConversionSchema.safeParse(base({ currency: "USD" })).success).toBe(false);
  });

  it("rejects a negative value", () => {
    expect(createConversionSchema.safeParse(base({ value: -1, currency: "USD" })).success).toBe(false);
  });

  it("rejects a non-finite value", () => {
    expect(
      createConversionSchema.safeParse(base({ value: Infinity, currency: "USD" })).success,
    ).toBe(false);
  });

  it("rejects a value beyond the Decimal(12,2) column's range", () => {
    expect(
      createConversionSchema.safeParse(base({ value: 10_000_000_000, currency: "USD" })).success,
    ).toBe(false);
  });

  it("rejects a 2-letter currency code", () => {
    expect(createConversionSchema.safeParse(base({ value: 1, currency: "US" })).success).toBe(false);
  });

  it("rejects a 4-letter currency code", () => {
    expect(createConversionSchema.safeParse(base({ value: 1, currency: "USDX" })).success).toBe(
      false,
    );
  });

  it("accepts an occurredAt within the clock-skew tolerance", () => {
    const soon = new Date(Date.now() + MAX_FUTURE_CLOCK_SKEW_MS - 1000);
    expect(createConversionSchema.safeParse(base({ occurredAt: soon.toISOString() })).success).toBe(
      true,
    );
  });

  it("rejects an occurredAt beyond the clock-skew tolerance", () => {
    const tooFar = new Date(Date.now() + MAX_FUTURE_CLOCK_SKEW_MS + 60_000);
    expect(
      createConversionSchema.safeParse(base({ occurredAt: tooFar.toISOString() })).success,
    ).toBe(false);
  });

  it("accepts an occurredAt far in the past (backfilled conversions are legitimate)", () => {
    const longAgo = new Date("2020-01-01T00:00:00Z");
    expect(
      createConversionSchema.safeParse(base({ occurredAt: longAgo.toISOString() })).success,
    ).toBe(true);
  });

  it("rejects an empty eventName", () => {
    expect(createConversionSchema.safeParse(base({ eventName: "" })).success).toBe(false);
  });

  it("rejects an externalConversionId over the length cap", () => {
    expect(
      createConversionSchema.safeParse(base({ externalConversionId: "x".repeat(256) })).success,
    ).toBe(false);
  });
});

describe("boundedMetadataSchema", () => {
  it("accepts undefined", () => {
    expect(boundedMetadataSchema.safeParse(undefined).success).toBe(true);
  });

  it("accepts a small, shallow object", () => {
    expect(boundedMetadataSchema.safeParse({ orderId: "abc", qty: 2 }).success).toBe(true);
  });

  it("rejects a payload over the serialized-size cap", () => {
    expect(boundedMetadataSchema.safeParse({ blob: "x".repeat(20_000) }).success).toBe(false);
  });

  it("rejects a payload nested deeper than the depth cap", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    expect(boundedMetadataSchema.safeParse(nested).success).toBe(false);
  });

  it("accepts a payload nested within the depth cap", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 3; i++) nested = { child: nested };
    expect(boundedMetadataSchema.safeParse(nested).success).toBe(true);
  });
});
