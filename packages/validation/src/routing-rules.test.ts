import { describe, expect, it } from "vitest";
import {
  MAX_CONDITIONS_PER_RULE,
  createRoutingRuleSchema,
  routingConditionSchema,
  updateRoutingRuleSchema,
} from "./routing-rules.js";

function base(overrides: Record<string, unknown> = {}) {
  return {
    name: "US mobile block",
    priority: 1,
    conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
    action: "BLOCK",
    ...overrides,
  };
}

describe("routingConditionSchema", () => {
  it("accepts a single-value EQUALS condition", () => {
    expect(
      routingConditionSchema.safeParse({ field: "COUNTRY", operator: "EQUALS", value: "US" }).success,
    ).toBe(true);
  });

  it("accepts an array value for IN", () => {
    expect(
      routingConditionSchema.safeParse({ field: "COUNTRY", operator: "IN", value: ["US", "GB"] }).success,
    ).toBe(true);
  });

  it("rejects an array value for EQUALS", () => {
    expect(
      routingConditionSchema.safeParse({ field: "COUNTRY", operator: "EQUALS", value: ["US"] }).success,
    ).toBe(false);
  });

  it("rejects a single string value for IN", () => {
    expect(
      routingConditionSchema.safeParse({ field: "COUNTRY", operator: "IN", value: "US" }).success,
    ).toBe(false);
  });

  it("rejects an empty IN array", () => {
    expect(
      routingConditionSchema.safeParse({ field: "COUNTRY", operator: "IN", value: [] }).success,
    ).toBe(false);
  });

  it("rejects more than 25 IN values", () => {
    const value = Array.from({ length: 26 }, (_, i) => `V${i}`);
    expect(routingConditionSchema.safeParse({ field: "COUNTRY", operator: "IN", value }).success).toBe(
      false,
    );
  });

  it.each(["UNKNOWN", "HUMAN", "SUSPICIOUS", "BOT"])(
    "accepts a valid BOT_CLASSIFICATION value: %s",
    (value) => {
      expect(
        routingConditionSchema.safeParse({ field: "BOT_CLASSIFICATION", operator: "EQUALS", value })
          .success,
      ).toBe(true);
    },
  );

  it("rejects a typo'd BOT_CLASSIFICATION value", () => {
    expect(
      routingConditionSchema.safeParse({ field: "BOT_CLASSIFICATION", operator: "EQUALS", value: "HUMEN" })
        .success,
    ).toBe(false);
  });

  it.each(["UNKNOWN", "DESKTOP", "MOBILE", "TABLET", "BOT", "OTHER"])(
    "accepts a valid DEVICE_TYPE value: %s",
    (value) => {
      expect(
        routingConditionSchema.safeParse({ field: "DEVICE_TYPE", operator: "EQUALS", value }).success,
      ).toBe(true);
    },
  );

  it("rejects a typo'd DEVICE_TYPE value", () => {
    expect(
      routingConditionSchema.safeParse({ field: "DEVICE_TYPE", operator: "EQUALS", value: "DESKTPO" })
        .success,
    ).toBe(false);
  });

  it("accepts a well-formed 2-letter COUNTRY code", () => {
    expect(
      routingConditionSchema.safeParse({ field: "COUNTRY", operator: "EQUALS", value: "US" }).success,
    ).toBe(true);
  });

  it("rejects a malformed COUNTRY value", () => {
    expect(
      routingConditionSchema.safeParse({ field: "COUNTRY", operator: "EQUALS", value: "USA" }).success,
    ).toBe(false);
  });

  it("does not restrict BROWSER/OS/REFERRER_HOST values beyond length bounds", () => {
    expect(
      routingConditionSchema.safeParse({ field: "BROWSER", operator: "EQUALS", value: "Chrome Mobile" })
        .success,
    ).toBe(true);
    expect(
      routingConditionSchema.safeParse({ field: "OS", operator: "EQUALS", value: "Windows" }).success,
    ).toBe(true);
    expect(
      routingConditionSchema.safeParse({
        field: "REFERRER_HOST",
        operator: "EQUALS",
        value: "google.com",
      }).success,
    ).toBe(true);
  });
});

describe("createRoutingRuleSchema", () => {
  it("accepts a minimal valid payload and defaults status to ACTIVE", () => {
    const result = createRoutingRuleSchema.safeParse(base());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("ACTIVE");
    }
  });

  it("accepts an explicit INACTIVE status", () => {
    expect(createRoutingRuleSchema.safeParse(base({ status: "INACTIVE" })).success).toBe(true);
  });

  it("rejects a non-positive priority", () => {
    expect(createRoutingRuleSchema.safeParse(base({ priority: 0 })).success).toBe(false);
    expect(createRoutingRuleSchema.safeParse(base({ priority: -1 })).success).toBe(false);
  });

  it("rejects a non-integer priority", () => {
    expect(createRoutingRuleSchema.safeParse(base({ priority: 1.5 })).success).toBe(false);
  });

  it("rejects an empty conditions array", () => {
    expect(createRoutingRuleSchema.safeParse(base({ conditions: [] })).success).toBe(false);
  });

  it(`rejects more than ${MAX_CONDITIONS_PER_RULE} conditions`, () => {
    const conditions = Array.from({ length: MAX_CONDITIONS_PER_RULE + 1 }, () => ({
      field: "COUNTRY",
      operator: "EQUALS",
      value: "US",
    }));
    expect(createRoutingRuleSchema.safeParse(base({ conditions })).success).toBe(false);
  });

  it.each(["TARGET", "SAFE_PAGE", "BLOCK"])("accepts action %s", (action) => {
    expect(createRoutingRuleSchema.safeParse(base({ action })).success).toBe(true);
  });

  it("rejects an invalid action", () => {
    expect(createRoutingRuleSchema.safeParse(base({ action: "REDIRECT" })).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(createRoutingRuleSchema.safeParse(base({ name: "" })).success).toBe(false);
  });
});

describe("updateRoutingRuleSchema", () => {
  it("accepts a partial payload with only one field", () => {
    expect(updateRoutingRuleSchema.safeParse({ priority: 2 }).success).toBe(true);
  });

  it("accepts an empty payload (no-op update)", () => {
    expect(updateRoutingRuleSchema.safeParse({}).success).toBe(true);
  });

  it("has no status field — a status key in the input is silently ignored, not rejected", () => {
    const result = updateRoutingRuleSchema.safeParse({ status: "INACTIVE" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("status");
    }
  });
});
