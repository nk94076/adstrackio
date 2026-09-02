import type { BotClassification } from "./bot-detection.js";

/**
 * Small, explicit routing-policy abstraction (Phase 5: Bot Detection
 * Integration) — deliberately not the full Rules & Routing Engine (Phase
 * 8). It answers exactly one question: given a classification and a
 * campaign's configured policy, where does this request go? Nothing here
 * inspects campaign targeting, geo, device, or any other dimension — that
 * belongs to Phase 8, which can replace this module without touching the
 * tracker route's control flow (it would just call a richer resolver in
 * `resolveBotRoutingAction`'s place).
 *
 * BOT and HUMAN are intentionally NOT configurable: BOT always routes to
 * the Safe Page (or a controlled block if none is configured), HUMAN
 * always routes to the transparent destination. Only SUSPICIOUS and
 * UNKNOWN are configurable per campaign, since those are genuinely
 * ambiguous verdicts a campaign owner may reasonably want to treat
 * differently (e.g. a lead-gen campaign paying for guaranteed real humans
 * might BLOCK anything not confidently HUMAN; a display campaign might
 * prefer TARGET to avoid losing any borderline-legitimate traffic).
 */
export type BotTrafficPolicyAction = "SAFE_PAGE" | "TARGET" | "BLOCK";

export interface BotTrafficPolicy {
  suspiciousTrafficPolicy: BotTrafficPolicyAction;
  unknownTrafficPolicy: BotTrafficPolicyAction;
}

/** The policy every campaign had, implicitly, before this field existed:
 * the old engine never produced SUSPICIOUS/UNKNOWN, so every request that
 * wasn't a definitive BOT verdict was routed to the transparent
 * destination. Used as the Prisma column default and by anything that
 * needs a policy for a campaign it can't otherwise determine one for. */
export const DEFAULT_BOT_TRAFFIC_POLICY: BotTrafficPolicy = {
  suspiciousTrafficPolicy: "TARGET",
  unknownTrafficPolicy: "TARGET",
};

/**
 * Resolves a classification + policy into a routing action. Pure and
 * synchronous — no I/O, no database lookups — so it's always safe to call
 * on the tracker's hot path.
 */
export function resolveBotRoutingAction(
  classification: BotClassification,
  policy: BotTrafficPolicy,
): BotTrafficPolicyAction {
  switch (classification) {
    case "BOT":
      return "SAFE_PAGE";
    case "HUMAN":
      return "TARGET";
    case "SUSPICIOUS":
      return policy.suspiciousTrafficPolicy;
    case "UNKNOWN":
      return policy.unknownTrafficPolicy;
    default: {
      const exhaustive: never = classification;
      throw new Error(`Unhandled bot classification: ${String(exhaustive)}`);
    }
  }
}
