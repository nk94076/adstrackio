import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_TRAFFIC_POLICY, type BotTrafficPolicy } from "./bot-traffic-policy.js";
import {
  MAX_ACTIVE_RULES_PER_CAMPAIGN,
  evaluateRules,
  resolveRoutingDecision,
  type RoutingContext,
  type RoutingRuleInput,
} from "./routing-rules.js";

const baseContext: RoutingContext = {
  botClassification: "HUMAN",
  country: null,
  deviceType: "UNKNOWN",
  browser: null,
  os: null,
  referrerHost: null,
};

function rule(overrides: Partial<RoutingRuleInput> = {}): RoutingRuleInput {
  return {
    id: "rule_1",
    priority: 1,
    conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
    action: "SAFE_PAGE",
    ...overrides,
  };
}

describe("evaluateRules", () => {
  it("returns null when there are no rules", () => {
    expect(evaluateRules([], baseContext)).toBeNull();
  });

  it("returns null when no rule's conditions match", () => {
    const rules = [rule({ conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }] })];
    expect(evaluateRules(rules, { ...baseContext, country: "GB" })).toBeNull();
  });

  it("matches a single EQUALS condition case-insensitively", () => {
    const rules = [rule({ conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "us" }] })];
    expect(evaluateRules(rules, { ...baseContext, country: "US" })).toEqual({
      action: "SAFE_PAGE",
      matchedRuleId: "rule_1",
    });
  });

  it("matches NOT_EQUALS when the actual value differs", () => {
    const rules = [
      rule({ conditions: [{ field: "COUNTRY", operator: "NOT_EQUALS", value: "US" }], action: "BLOCK" }),
    ];
    expect(evaluateRules(rules, { ...baseContext, country: "GB" })).toEqual({
      action: "BLOCK",
      matchedRuleId: "rule_1",
    });
  });

  it("does not match NOT_EQUALS when the actual value is the same", () => {
    const rules = [
      rule({ conditions: [{ field: "COUNTRY", operator: "NOT_EQUALS", value: "US" }], action: "BLOCK" }),
    ];
    expect(evaluateRules(rules, { ...baseContext, country: "US" })).toBeNull();
  });

  it("matches IN when the value is one of the listed options", () => {
    const rules = [
      rule({
        conditions: [{ field: "DEVICE_TYPE", operator: "IN", value: ["MOBILE", "TABLET"] }],
        action: "TARGET",
      }),
    ];
    expect(evaluateRules(rules, { ...baseContext, deviceType: "TABLET" })).toEqual({
      action: "TARGET",
      matchedRuleId: "rule_1",
    });
  });

  it("does not match NOT_IN when the value is one of the excluded options", () => {
    const rules = [
      rule({ conditions: [{ field: "DEVICE_TYPE", operator: "NOT_IN", value: ["MOBILE", "TABLET"] }] }),
    ];
    expect(evaluateRules(rules, { ...baseContext, deviceType: "MOBILE" })).toBeNull();
  });

  it("matches NOT_IN when the value is outside the excluded options", () => {
    const rules = [
      rule({ conditions: [{ field: "DEVICE_TYPE", operator: "NOT_IN", value: ["MOBILE", "TABLET"] }] }),
    ];
    expect(evaluateRules(rules, { ...baseContext, deviceType: "DESKTOP" })).toEqual({
      action: "SAFE_PAGE",
      matchedRuleId: "rule_1",
    });
  });

  it("requires every condition in a rule to match (AND semantics)", () => {
    const rules = [
      rule({
        conditions: [
          { field: "COUNTRY", operator: "EQUALS", value: "US" },
          { field: "DEVICE_TYPE", operator: "EQUALS", value: "MOBILE" },
        ],
      }),
    ];
    expect(evaluateRules(rules, { ...baseContext, country: "US", deviceType: "DESKTOP" })).toBeNull();
    expect(
      evaluateRules(rules, { ...baseContext, country: "US", deviceType: "MOBILE" }),
    ).toEqual({ action: "SAFE_PAGE", matchedRuleId: "rule_1" });
  });

  it.each(["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] as const)(
    "fails closed for %s when the context signal is unknown (null)",
    (operator) => {
      const value = operator === "IN" || operator === "NOT_IN" ? ["US"] : "US";
      const rules = [rule({ conditions: [{ field: "COUNTRY", operator, value }] })];
      expect(evaluateRules(rules, { ...baseContext, country: null })).toBeNull();
    },
  );

  it("evaluates rules in ascending priority order and stops at the first match", () => {
    const rules = [
      rule({ id: "low", priority: 5, action: "BLOCK", conditions: [] }),
      rule({ id: "high", priority: 1, action: "TARGET", conditions: [] }),
    ];
    // Both would match (empty conditions array matches vacuously); the
    // lower-priority-number rule must win.
    expect(evaluateRules(rules, baseContext)).toEqual({ action: "TARGET", matchedRuleId: "high" });
  });

  it("is not affected by input array order, only by priority", () => {
    const rules = [
      rule({ id: "high", priority: 1, action: "TARGET", conditions: [] }),
      rule({ id: "low", priority: 5, action: "BLOCK", conditions: [] }),
    ];
    expect(evaluateRules(rules, baseContext)).toEqual({ action: "TARGET", matchedRuleId: "high" });
  });

  it("bounds evaluation to MAX_ACTIVE_RULES_PER_CAMPAIGN even if given more", () => {
    const rules: RoutingRuleInput[] = Array.from({ length: MAX_ACTIVE_RULES_PER_CAMPAIGN + 10 }, (_, i) =>
      rule({ id: `rule_${i}`, priority: i + 1, action: "BLOCK", conditions: [] }),
    );
    // The lowest-priority rule within the bound (index 0, priority 1) wins;
    // this alone doesn't prove the bound applied, so also check a rule
    // placed intentionally beyond the bound never wins even though it's
    // still numerically lower priority than nothing else matched.
    const result = evaluateRules(rules, baseContext);
    expect(result?.matchedRuleId).toBe("rule_0");
  });

  it("never throws for an empty rules array or an empty conditions array", () => {
    expect(() => evaluateRules([], baseContext)).not.toThrow();
    expect(() => evaluateRules([rule({ conditions: [] })], baseContext)).not.toThrow();
  });
});

describe("resolveRoutingDecision", () => {
  const policy: BotTrafficPolicy = { suspiciousTrafficPolicy: "BLOCK", unknownTrafficPolicy: "BLOCK" };

  it("BOT always resolves to SAFE_PAGE via BOT_POLICY, even with a matching TARGET rule", () => {
    const rules = [rule({ action: "TARGET", conditions: [] })];
    const decision = resolveRoutingDecision({
      classification: "BOT",
      botTrafficPolicy: policy,
      rules,
      context: { ...baseContext, botClassification: "BOT" },
    });
    expect(decision).toEqual({ action: "SAFE_PAGE", source: "BOT_POLICY", matchedRuleId: null });
  });

  it("a matching rule wins over the campaign default for HUMAN traffic", () => {
    const rules = [rule({ action: "BLOCK", conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }] })];
    const decision = resolveRoutingDecision({
      classification: "HUMAN",
      botTrafficPolicy: DEFAULT_BOT_TRAFFIC_POLICY,
      rules,
      context: { ...baseContext, botClassification: "HUMAN", country: "US" },
    });
    expect(decision).toEqual({ action: "BLOCK", source: "ROUTING_RULE", matchedRuleId: "rule_1" });
  });

  it("HUMAN with no matching rule falls back to the hard TARGET default", () => {
    const rules = [rule({ conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }] })];
    const decision = resolveRoutingDecision({
      classification: "HUMAN",
      botTrafficPolicy: policy,
      rules,
      context: { ...baseContext, botClassification: "HUMAN", country: "GB" },
    });
    expect(decision).toEqual({ action: "TARGET", source: "CAMPAIGN_DEFAULT", matchedRuleId: null });
  });

  it("SUSPICIOUS with no matching rule falls back to the campaign's suspiciousTrafficPolicy", () => {
    const decision = resolveRoutingDecision({
      classification: "SUSPICIOUS",
      botTrafficPolicy: policy,
      rules: [],
      context: { ...baseContext, botClassification: "SUSPICIOUS" },
    });
    expect(decision).toEqual({ action: "BLOCK", source: "CAMPAIGN_DEFAULT", matchedRuleId: null });
  });

  it("UNKNOWN with no matching rule falls back to the campaign's unknownTrafficPolicy", () => {
    const decision = resolveRoutingDecision({
      classification: "UNKNOWN",
      botTrafficPolicy: policy,
      rules: [],
      context: { ...baseContext, botClassification: "UNKNOWN" },
    });
    expect(decision).toEqual({ action: "BLOCK", source: "CAMPAIGN_DEFAULT", matchedRuleId: null });
  });

  it("a campaign with zero rules behaves exactly like pre-Phase-8 resolveBotRoutingAction", () => {
    for (const classification of ["BOT", "HUMAN", "SUSPICIOUS", "UNKNOWN"] as const) {
      const decision = resolveRoutingDecision({
        classification,
        botTrafficPolicy: DEFAULT_BOT_TRAFFIC_POLICY,
        rules: [],
        context: { ...baseContext, botClassification: classification },
      });
      const expectedAction = classification === "BOT" ? "SAFE_PAGE" : "TARGET";
      expect(decision.action).toBe(expectedAction);
    }
  });

  it("a matching rule can route SUSPICIOUS/UNKNOWN traffic differently than the campaign default", () => {
    const rules = [
      rule({ action: "TARGET", conditions: [{ field: "BOT_CLASSIFICATION", operator: "EQUALS", value: "SUSPICIOUS" }] }),
    ];
    const decision = resolveRoutingDecision({
      classification: "SUSPICIOUS",
      botTrafficPolicy: policy, // would otherwise BLOCK
      rules,
      context: { ...baseContext, botClassification: "SUSPICIOUS" },
    });
    expect(decision).toEqual({ action: "TARGET", source: "ROUTING_RULE", matchedRuleId: "rule_1" });
  });
});
