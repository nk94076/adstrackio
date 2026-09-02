import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_TRAFFIC_POLICY, resolveBotRoutingAction } from "./bot-traffic-policy.js";
import type { BotTrafficPolicy } from "./bot-traffic-policy.js";

describe("resolveBotRoutingAction", () => {
  it("always routes BOT to SAFE_PAGE, regardless of policy", () => {
    const policy: BotTrafficPolicy = { suspiciousTrafficPolicy: "BLOCK", unknownTrafficPolicy: "BLOCK" };
    expect(resolveBotRoutingAction("BOT", policy)).toBe("SAFE_PAGE");
  });

  it("always routes HUMAN to TARGET, regardless of policy", () => {
    const policy: BotTrafficPolicy = {
      suspiciousTrafficPolicy: "SAFE_PAGE",
      unknownTrafficPolicy: "BLOCK",
    };
    expect(resolveBotRoutingAction("HUMAN", policy)).toBe("TARGET");
  });

  it.each(["SAFE_PAGE", "TARGET", "BLOCK"] as const)(
    "routes SUSPICIOUS according to the campaign's suspiciousTrafficPolicy: %s",
    (action) => {
      const policy: BotTrafficPolicy = {
        suspiciousTrafficPolicy: action,
        unknownTrafficPolicy: "TARGET",
      };
      expect(resolveBotRoutingAction("SUSPICIOUS", policy)).toBe(action);
    },
  );

  it.each(["SAFE_PAGE", "TARGET", "BLOCK"] as const)(
    "routes UNKNOWN according to the campaign's unknownTrafficPolicy: %s",
    (action) => {
      const policy: BotTrafficPolicy = {
        suspiciousTrafficPolicy: "TARGET",
        unknownTrafficPolicy: action,
      };
      expect(resolveBotRoutingAction("UNKNOWN", policy)).toBe(action);
    },
  );

  it("SUSPICIOUS and UNKNOWN policies are independent of each other", () => {
    const policy: BotTrafficPolicy = {
      suspiciousTrafficPolicy: "SAFE_PAGE",
      unknownTrafficPolicy: "BLOCK",
    };
    expect(resolveBotRoutingAction("SUSPICIOUS", policy)).toBe("SAFE_PAGE");
    expect(resolveBotRoutingAction("UNKNOWN", policy)).toBe("BLOCK");
  });

  it("DEFAULT_BOT_TRAFFIC_POLICY resolves both SUSPICIOUS and UNKNOWN to TARGET (backward-compatible default)", () => {
    expect(resolveBotRoutingAction("SUSPICIOUS", DEFAULT_BOT_TRAFFIC_POLICY)).toBe("TARGET");
    expect(resolveBotRoutingAction("UNKNOWN", DEFAULT_BOT_TRAFFIC_POLICY)).toBe("TARGET");
  });
});
