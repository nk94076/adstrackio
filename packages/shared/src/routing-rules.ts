import type { BotClassification } from "./bot-detection.js";
import type { AnalyticsDeviceType } from "./user-agent.js";
import {
  resolveBotRoutingAction,
  type BotTrafficPolicy,
  type BotTrafficPolicyAction,
} from "./bot-traffic-policy.js";

/**
 * Rules & Routing Engine (Phase 8) — a pure, synchronous, bounded evaluator
 * layered on top of the existing bot-policy abstraction (Phase 5), not a
 * replacement for it. See docs/architecture/rules-routing.md for the full
 * design and precedence rationale.
 *
 * `RoutingRuleAction` is deliberately the exact same three values as
 * `BotTrafficPolicyAction` (TARGET/SAFE_PAGE/BLOCK) — a rule can only pick
 * among the same physical outcomes the tracker's redirect switch already
 * knows how to execute (apps/tracker/src/modules/tracker/tracker.routes.ts).
 * There is no way for a rule to name an arbitrary URL: TARGET still means
 * "follow the request's own transparent redirection_url", never a
 * rule-configured destination — this is what keeps the Google Transparent
 * Click Tracker architecture (Phase 3) intact.
 */
export type RoutingRuleAction = BotTrafficPolicyAction;

/** Small, closed set of request-derived signals a rule may condition on —
 * deliberately not an open/arbitrary field name, so every condition is
 * guaranteed to resolve against a known, typed piece of RoutingContext. */
export type RoutingConditionField =
  | "BOT_CLASSIFICATION"
  | "COUNTRY"
  | "DEVICE_TYPE"
  | "BROWSER"
  | "OS"
  | "REFERRER_HOST";

export type RoutingConditionOperator = "EQUALS" | "NOT_EQUALS" | "IN" | "NOT_IN";

export interface RoutingCondition {
  field: RoutingConditionField;
  operator: RoutingConditionOperator;
  /** A single string for EQUALS/NOT_EQUALS, an array for IN/NOT_IN — see
   * packages/validation/src/routing-rules.ts for the schema that enforces
   * this pairing and bounds array length. */
  value: string | string[];
}

/**
 * The request-derived signals a rule may be evaluated against. Every field
 * is synchronously available on the tracker's hot path — none of these
 * require a network call or await:
 *
 * - botClassification: already computed by BotDetectionEngine before
 *   routing is decided (Phase 5).
 * - deviceType/browser/os: parsed synchronously from the User-Agent header
 *   by UserAgentParser (Phase 4) — pure string matching, no I/O.
 * - country: NOT sourced from GeoLocationProvider. That provider is
 *   explicitly async/best-effort and, by design, is never awaited on the
 *   redirect path (see packages/shared/src/geo-location.ts) — enrichment
 *   happens in the background, after the redirect has already been sent,
 *   so its result cannot be part of a synchronous routing decision without
 *   either violating that latency guarantee or evaluating rules against
 *   stale/absent data. Instead, country is read synchronously from a
 *   well-known CDN-injected header (see extractCountrySignal in
 *   routing-signals.ts) — but ONLY on a request verified to have passed
 *   through a trusted edge (isTrustedEdgeRequest, gated on the
 *   TRUSTED_EDGE_SECRET server config): a geo header's mere presence is
 *   not a security boundary, since an ordinary client can set it on its
 *   own request. With no trusted edge configured (the default), or on any
 *   request that doesn't prove it passed through one, country is null and
 *   any COUNTRY condition simply never matches — see
 *   docs/architecture/rules-routing.md#country-signal-trust-boundary for
 *   the full mechanism and per-CDN setup.
 * - referrerHost: parsed synchronously from the Referer header.
 *
 * A null field value means "this signal is unknown for this request", not
 * "empty string" — see matchesCondition's fail-closed handling below.
 */
export interface RoutingContext {
  botClassification: BotClassification;
  country: string | null;
  deviceType: AnalyticsDeviceType;
  browser: string | null;
  os: string | null;
  referrerHost: string | null;
}

/** A rule as evaluateRules needs it — intentionally narrower than the full
 * Prisma RoutingRule row (no organizationId, timestamps, etc.), so the
 * evaluator has no way to reach outside what it was explicitly given. */
export interface RoutingRuleInput {
  id: string;
  priority: number;
  conditions: RoutingCondition[];
  action: RoutingRuleAction;
}

export interface RoutingRuleMatch {
  action: RoutingRuleAction;
  matchedRuleId: string;
}

/**
 * Hard ceiling on how many rules evaluateRules will ever consider for one
 * decision, regardless of how many are passed in. This is a second,
 * defensive bound — the real limit is enforced where rules are written
 * (apps/api/src/modules/routing-rules/routing-rules.service.ts refuses to
 * activate a rule that would push a campaign's ACTIVE rule count past
 * this), not here. evaluateRules must never throw or reject an
 * over-the-limit input on the tracker's hot path; it silently evaluates
 * only the first MAX_ACTIVE_RULES_PER_CAMPAIGN rules by priority order
 * instead, keeping evaluation cost bounded no matter what a caller passes.
 */
export const MAX_ACTIVE_RULES_PER_CAMPAIGN = 50;

const MAX_CONDITIONS_PER_RULE = 10;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function contextValueForField(
  context: RoutingContext,
  field: RoutingConditionField,
): string | null {
  switch (field) {
    case "BOT_CLASSIFICATION":
      return context.botClassification;
    case "COUNTRY":
      return context.country;
    case "DEVICE_TYPE":
      return context.deviceType;
    case "BROWSER":
      return context.browser;
    case "OS":
      return context.os;
    case "REFERRER_HOST":
      return context.referrerHost;
    default: {
      const exhaustive: never = field;
      throw new Error(`Unhandled routing condition field: ${String(exhaustive)}`);
    }
  }
}

/**
 * Fail-closed on an unknown signal: if the context has no value for a
 * condition's field (e.g. country is null because no CDN geo header was
 * present), the condition never matches — for EVERY operator, including
 * NOT_EQUALS/NOT_IN. "Unknown" is not the same as "different from X"; a
 * null country must never be treated as implicit proof the visitor is
 * NOT from country X. This is a deliberate, conservative choice: an
 * ambiguous signal can never be used to positively assert a routing
 * decision either way.
 */
function matchesCondition(context: RoutingContext, condition: RoutingCondition): boolean {
  const actual = contextValueForField(context, condition.field);
  if (actual === null) {
    return false;
  }
  const normalizedActual = normalize(actual);

  switch (condition.operator) {
    case "EQUALS":
      return normalizedActual === normalize(condition.value as string);
    case "NOT_EQUALS":
      return normalizedActual !== normalize(condition.value as string);
    case "IN":
      return (condition.value as string[]).some((v) => normalize(v) === normalizedActual);
    case "NOT_IN":
      return !(condition.value as string[]).some((v) => normalize(v) === normalizedActual);
    default: {
      const exhaustive: never = condition.operator;
      throw new Error(`Unhandled routing condition operator: ${String(exhaustive)}`);
    }
  }
}

/** A rule matches only if every one of its conditions matches (logical
 * AND) — the only boolean combinator this engine supports. There is no OR
 * within a single rule; the equivalent is writing multiple rules at
 * different priorities. This keeps evaluation a bounded, deterministic
 * walk with no expression tree to parse or eval — see the module doc
 * comment on RoutingCondition. */
function matchesRule(context: RoutingContext, rule: RoutingRuleInput): boolean {
  const conditions = rule.conditions.slice(0, MAX_CONDITIONS_PER_RULE);
  return conditions.every((condition) => matchesCondition(context, condition));
}

/**
 * Pure, synchronous, bounded rule evaluator. No I/O, no network calls, no
 * database lookups, no eval of any kind — safe to call unconditionally on
 * the tracker's redirect hot path.
 *
 * Rules are evaluated in ascending priority order (lower number first);
 * the first matching rule wins and evaluation stops there. Tie-breaking is
 * never ambiguous because the database enforces a unique
 * (campaignId, priority) pair (see packages/database's RoutingRule model)
 * — evaluateRules never has to invent a secondary sort key.
 *
 * Returns null when no rule matches (including when `rules` is empty) —
 * the caller (resolveRoutingDecision below) is responsible for falling
 * back to the campaign's default bot-traffic policy in that case.
 */
export function evaluateRules(
  rules: RoutingRuleInput[],
  context: RoutingContext,
): RoutingRuleMatch | null {
  const bounded =
    rules.length > MAX_ACTIVE_RULES_PER_CAMPAIGN
      ? rules.slice(0, MAX_ACTIVE_RULES_PER_CAMPAIGN)
      : rules;
  const sorted = [...bounded].sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    if (matchesRule(context, rule)) {
      return { action: rule.action, matchedRuleId: rule.id };
    }
  }
  return null;
}

export type RoutingDecisionSource = "BOT_POLICY" | "ROUTING_RULE" | "CAMPAIGN_DEFAULT";

export interface RoutingDecision {
  action: RoutingRuleAction;
  source: RoutingDecisionSource;
  matchedRuleId: string | null;
}

export interface RoutingPolicyInput {
  classification: BotClassification;
  botTrafficPolicy: BotTrafficPolicy;
  rules: RoutingRuleInput[];
  context: RoutingContext;
}

/**
 * The single place that documents and enforces precedence between the
 * three routing authorities Phase 8's brief calls out explicitly:
 *
 *   1. Bot policy (hard, non-negotiable): a BOT classification always
 *      routes to SAFE_PAGE. This is never delegated to a routing rule —
 *      Phase 5 deliberately made BOT/HUMAN non-configurable (see
 *      bot-traffic-policy.ts's module doc), and Phase 8 does not revisit
 *      that decision. Routing rules are never even evaluated for BOT
 *      traffic, so there is no way to write a rule that "rescues" bot
 *      traffic back to a real destination.
 *
 *   2. Routing rules: consulted for every classification other than BOT
 *      (i.e. HUMAN, SUSPICIOUS, UNKNOWN). If a rule's conditions match,
 *      its action wins.
 *
 *   3. Campaign default: if no rule matches (including when the campaign
 *      has zero rules configured — the common case, and the reason a
 *      campaign with no rules behaves byte-for-byte the same as it did
 *      before Phase 8 existed), falls back to
 *      packages/shared/src/bot-traffic-policy.ts's resolveBotRoutingAction
 *      — HUMAN's hard TARGET default, and SUSPICIOUS/UNKNOWN's
 *      per-campaign suspiciousTrafficPolicy/unknownTrafficPolicy.
 *
 * This function composes resolveBotRoutingAction rather than duplicating
 * its logic — Phase 8 must not reimplement bot classification or its
 * routing (see bot-traffic-policy.ts's own module doc, which names this
 * exact function as the intended extension point).
 */
export function resolveRoutingDecision(input: RoutingPolicyInput): RoutingDecision {
  if (input.classification === "BOT") {
    return { action: "SAFE_PAGE", source: "BOT_POLICY", matchedRuleId: null };
  }

  const ruleMatch = evaluateRules(input.rules, input.context);
  if (ruleMatch) {
    return {
      action: ruleMatch.action,
      source: "ROUTING_RULE",
      matchedRuleId: ruleMatch.matchedRuleId,
    };
  }

  const fallbackAction = resolveBotRoutingAction(input.classification, input.botTrafficPolicy);
  return { action: fallbackAction, source: "CAMPAIGN_DEFAULT", matchedRuleId: null };
}
