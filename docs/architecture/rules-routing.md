# Rules & Routing Engine (Phase 8)

## Status and scope

Phase 8 adds a deterministic, campaign-scoped **routing rule** layer on top
of Phases 1-7. A rule matches a small, closed set of request-derived
signals (bot classification, country, device type, browser, OS, referrer
host) and, when it matches, decides one of the same three outcomes the
tracker already knew how to execute since Phase 3/5: `TARGET` (follow the
request's own transparent `redirection_url`), `SAFE_PAGE`, or `BLOCK`. It
does **not** add a fourth outcome, does not let a rule name an arbitrary
URL, and does not touch how any of those three outcomes are actually
executed — only which one gets chosen.

Explicitly out of scope for this phase (unchanged from Phase 1-7): an
affiliate/partner system, attribution windows, multi-touch attribution,
payout calculation, webhooks/external integrations, ML-based bot
detection, an advanced fraud engine, arbitrary user-authored expressions
or `eval`, arbitrary redirect destinations, A/B testing, and percentage
traffic splitting.

```
Request -> TrackingResolver (domain/link/campaign lookup + active rules)
         -> BotDetectionEngine (classification)
         -> resolveRoutingDecision(classification, rules, botTrafficPolicy)
         -> tracker's existing TARGET/SAFE_PAGE/BLOCK switch (unchanged)
```

## What existed before this phase (audit summary)

Before writing any Phase 8 code, the following were inspected directly
(not from memory):

- `apps/tracker/src/modules/tracker/tracker.routes.ts` — the Phase 3
  transparent redirect handler. The request's own `redirection_url` query
  parameter is validated and is the only source of the `TARGET` outcome's
  destination; `resolveBotRoutingAction` (Phase 5) already picked between
  `TARGET`/`SAFE_PAGE`/`BLOCK` purely from classification + a campaign's
  two policy fields.
- `packages/shared/src/bot-traffic-policy.ts` — Phase 5's routing-policy
  abstraction. Its own module doc already named itself as "deliberately
  not the full Rules & Routing Engine" and as the extension point Phase 8
  should compose, not duplicate.
- `packages/shared/src/bot-detection.ts` /
  `apps/tracker/src/modules/bot-detection/heuristic-bot-detection-engine.ts`
  — the single source of truth for `BotClassification`. Phase 8 adds no
  second classifier.
- `packages/shared/src/user-agent.ts` /
  `apps/tracker/src/modules/enrichment/ua-parser-user-agent-parser.ts` —
  `UserAgentParser.parse` is documented as pure/synchronous, safe to call
  unconditionally.
- `packages/shared/src/geo-location.ts` — `GeoLocationProvider.lookup` is
  explicitly async/best-effort and **never awaited** on the redirect path;
  `apps/tracker/src/modules/tracker/tracker.service.ts`'s `recordClick`
  fires it in the background, after the Click row is already written and
  the redirect already sent. This directly shaped the design of the
  `COUNTRY` condition — see below.
- `packages/database/prisma/schema.prisma` — `Campaign.safePageUrl`,
  `suspiciousTrafficPolicy`, `unknownTrafficPolicy`; `Click`'s enrichment
  columns; the `enforce_conversion_click_attribution` /
  `enforce_referral_configuration_activation` trigger pattern (Phase 7/1)
  used as the template for this phase's own trigger.
- `apps/api/src/modules/campaigns/campaigns.service.ts` and
  `apps/api/src/modules/conversions/conversions.service.ts` — the
  conditional-updateMany vs. `SELECT ... FOR UPDATE` concurrency patterns
  (see "Concurrency" below for why this phase uses the latter for its own
  activate/deactivate toggle).
- `apps/dashboard/src/app/campaigns/[id]/page.tsx` — the existing
  campaign-detail page structure, extended with a new "Routing rules"
  card rather than a new top-level page.

## Rule model

```prisma
enum RoutingRuleStatus { ACTIVE INACTIVE }
enum RoutingRuleAction { TARGET SAFE_PAGE BLOCK }

model RoutingRule {
  id             String
  organizationId String   // set once from the URL path, never client body
  campaignId     String   // set once from the URL path, never client body
  name           String
  status         RoutingRuleStatus @default(ACTIVE)
  priority       Int               // unique per campaign — see below
  conditions     Json              // RoutingCondition[], validated + bounded
  action         RoutingRuleAction
  ...
  @@unique([campaignId, priority])
  @@index([campaignId, status, priority])
}
```

A rule is always scoped to exactly one campaign — there is no
organization-wide rule and no flat `/rules` listing, only
`/organizations/:organizationId/campaigns/:campaignId/rules`.

### Conditions and operators

`conditions` is a bounded array (max 10) of:

```ts
{ field: RoutingConditionField; operator: RoutingConditionOperator; value: string | string[] }
```

- `field`: `BOT_CLASSIFICATION | COUNTRY | DEVICE_TYPE | BROWSER | OS | REFERRER_HOST`
  — a closed enum, not an open field name.
- `operator`: `EQUALS | NOT_EQUALS | IN | NOT_IN` — `value` is a single
  string for `EQUALS`/`NOT_EQUALS` and a bounded array (max 25 entries)
  for `IN`/`NOT_IN`, enforced by `packages/validation/src/routing-rules.ts`.
- A rule matches only when **every** one of its conditions matches
  (logical AND). There is no OR within a rule and no nesting — the
  equivalent of OR is writing multiple rules at different priorities. This
  is a deliberate, closed evaluation model: no expression parser, no
  `eval`, nothing a rule's JSON could ever cause to run arbitrary code.
- `BOT_CLASSIFICATION`/`DEVICE_TYPE` values are validated against their
  real enum values at write time (a typo like `"HUMEN"` is rejected with a
  400, not silently accepted as a condition that can never match).
  `COUNTRY` values are validated as a loose 2-letter alpha shape.

### Fail-closed on an unknown signal

If the request has no value for a condition's field (most commonly:
`country` is `null` because no CDN geo header was present), that condition
**never matches**, regardless of operator — including `NOT_EQUALS`/
`NOT_IN`. "Unknown" is never treated as implicit proof of "different from
X." This is enforced in `packages/shared/src/routing-rules.ts`'s
`matchesCondition` and covered by a dedicated parameterized test for all
four operators.

### Action

`action` is exactly the same three-value type as Phase 5's
`BotTrafficPolicyAction` (`RoutingRuleAction = BotTrafficPolicyAction` in
`packages/shared/src/routing-rules.ts`). A rule cannot specify a URL of
its own:

- `TARGET` still means "follow the request's own validated
  `redirection_url`" — the tracker's existing `switch` in
  `tracker.routes.ts` is completely unchanged; a matched rule only changes
  which branch of that same switch gets taken.
- `SAFE_PAGE` still means "redirect to `Campaign.safePageUrl`, or a
  controlled 404 if unset."
- `BLOCK` still means "a controlled 404, never falls back to anything."

This is what keeps the Google Transparent Click Tracker architecture
(Phase 3) intact — see "Transparent tracker safety" below.

### Priority and determinism

`priority` is a plain positive integer, **unique per campaign** —
enforced by a real database unique constraint
(`@@unique([campaignId, priority])`), not application-level tie-breaking.
Rules are evaluated in ascending priority order (lower number first); the
first rule whose conditions all match wins and evaluation stops. Because
the database makes two rules on the same campaign sharing a priority
impossible, there is no secondary sort key to reason about, document, or
get subtly wrong under a future refactor — evaluation order is always
exactly the priority order.

## Precedence: bot policy -> routing rules -> campaign default

`resolveRoutingDecision` (`packages/shared/src/routing-rules.ts`) is the
single place that composes all three routing authorities:

1. **Bot policy (hard, non-negotiable).** A `BOT` classification always
   resolves to `SAFE_PAGE`. Routing rules are **never evaluated** for
   `BOT` traffic — there is no way to write a rule that "rescues" bot
   traffic back to a real destination. This preserves Phase 5's original
   decision that `BOT`/`HUMAN` are not configurable.
2. **Routing rules.** Consulted for every other classification (`HUMAN`,
   `SUSPICIOUS`, `UNKNOWN`). If a rule's conditions match, its action
   wins — this is genuinely new capability: `HUMAN` traffic, which before
   Phase 8 could only ever go to the transparent destination, can now be
   segmented by geo/device/browser/referrer into `TARGET`/`SAFE_PAGE`/
   `BLOCK`.
3. **Campaign default.** If no rule matches (including the common case of
   a campaign with zero rules configured), falls back to
   `resolveBotRoutingAction` exactly as Phase 5 defined it — `HUMAN`'s
   hard `TARGET` default, and `SUSPICIOUS`/`UNKNOWN`'s existing
   `suspiciousTrafficPolicy`/`unknownTrafficPolicy` campaign fields.

**A campaign with no routing rules behaves byte-for-byte identically to
how it behaved before Phase 8 existed** — this is asserted directly in
`packages/shared/src/routing-rules.test.ts`
("a campaign with zero rules behaves exactly like pre-Phase-8
resolveBotRoutingAction").

`resolveRoutingDecision` composes `resolveBotRoutingAction` rather than
reimplementing bot-policy logic — Phase 5's own module doc named this
function as the intended extension point, and this phase does not
duplicate bot detection or its routing.

## Country signal: trust boundary

The Rules & Routing Engine's evaluator must be pure, synchronous, and add
no latency to the redirect (see "Evaluation engine" below) — but
`GeoLocationProvider` (Phase 4) is explicitly async/best-effort and is
**never awaited** on the redirect path; its result is applied to the Click
row via a background update, often after the redirect response has
already been sent. Awaiting it here, even only when a `COUNTRY` rule
exists, would either violate that latency guarantee or make evaluation
depend on incomplete data mid-flight. So `country` has to come from
something synchronous — and the only synchronous source available is a
request header, which raises a real question a first version of this
module got wrong: **an HTTP header is not identity.** Any direct client
can set `cf-ipcountry: US` on its own request; validating that the
*value* looks like a well-formed 2-letter code proves nothing about who
*sent* it. Trusting a geo header's mere presence — this module's original
implementation — is not a security boundary, it's a spoofable input an
attacker fully controls, and was rejected as such in PR #9's review.

### The real boundary: a shared secret, not a header name

`packages/shared/src/routing-signals.ts` now gates `country` extraction
behind `isTrustedEdgeRequest`, which is true only when the request carries
the exact value of a server-side-configured secret
(`TRUSTED_EDGE_SECRET`, `packages/config`) as its
`x-adstrackio-edge-secret` header, compared in constant time
(`crypto.timingSafeEqual` over SHA-256 digests of both sides, so the
comparison always operates on two fixed-length buffers regardless of the
inputs' own lengths — no early-return timing side channel on a length
mismatch). Only once that check passes does `extractCountrySignal` even
look at `cf-ipcountry` / `x-vercel-ip-country` /
`cloudfront-viewer-country`.

This is real authentication, not "check whether a header exists": a
client without knowledge of `TRUSTED_EDGE_SECRET` cannot produce a
matching value for `x-adstrackio-edge-secret`, no matter what other
headers it sends. It is the same pattern AWS's own documentation
recommends for restricting an origin to traffic that actually passed
through CloudFront (a custom secret header CloudFront is configured to
inject, checked at the origin) — not something invented for this
codebase.

**`TRUSTED_EDGE_SECRET` is unset by default** (`packages/config`'s schema
makes it optional, mirroring `NullGeoLocationProvider`'s own
off-by-default precedent). With it unset, `isTrustedEdgeRequest` is
`false` for every request and `extractCountrySignal` always returns
`null` — **COUNTRY routing is completely inert out of the box**, geo
header present or not. A deploying operator must explicitly do two
things before any `COUNTRY` condition can ever match:

1. Set `TRUSTED_EDGE_SECRET` to a long random value in this service's own
   environment.
2. Configure their CDN/edge to inject that exact value as the
   `x-adstrackio-edge-secret` request header on every request it forwards
   to the tracker, AND to strip or overwrite any client-supplied copy of
   that header first (a CDN that merely *adds* the header without
   clearing an existing one would let a client's own forged copy survive
   if the CDN appends rather than replaces — check your specific CDN's
   header-manipulation semantics).

Per-CDN configuration sketch (exact UI/API details are the operator's own
CDN's documentation, not this codebase's concern):

- **Cloudflare**: a Transform Rule (Rules → Transform Rules → Modify
  Request Header) that sets `x-adstrackio-edge-secret` to the configured
  value on requests routed to the tracker's origin, positioned so it runs
  on every request regardless of any client-supplied header of the same
  name.
- **Vercel**: Edge Middleware that sets the header on the outgoing
  request to the origin (`NextResponse.next({ request: { headers } })` or
  equivalent), or a rewrite rule if the deployment topology allows it.
- **AWS CloudFront**: a CloudFront Function (or Lambda@Edge) on the
  viewer-request or origin-request event that sets the header before the
  request reaches the tracker's origin — the same pattern AWS's own
  "restrict access to your ALB with a custom header" guidance describes.

Operators who complete both steps get real `COUNTRY` rule matching;
everyone else's `COUNTRY` rules are simply inert until they do. Per
requirement, this codebase does not implement a partial/fake boundary
(e.g. "trust it if a CDN-shaped header exists") as a stand-in for actual
verification — the shared-secret check above is the whole mechanism,
synchronous and dependency-free (no IP-range lists to fetch or maintain),
and COUNTRY routing stays disabled until an operator deliberately
completes it.

See "Security controls" below and `docs/architecture/security.md`'s Rules
& Routing Engine section for the full threat-model writeup, and
`packages/shared/src/routing-signals.test.ts` for the spoofing-resistance
test suite (direct request + each of the three geo headers → null;
wrong/missing secret + a real geo header → null; matching secret + a
well-formed geo header → the value).

## Evaluation engine

`evaluateRules(rules, context)` (`packages/shared/src/routing-rules.ts`)
is pure and synchronous: no I/O, no database lookups, no network calls, no
`eval`. It is always safe to call unconditionally on the tracker's
redirect hot path. It:

- Sorts the given rules by ascending priority and returns the first
  match, or `null` if none match.
- Is defensively bounded to `MAX_ACTIVE_RULES_PER_CAMPAIGN` (50) even if
  handed more — this is a second, redundant bound on top of the real
  limit enforced where rules are written (see "Max active rules" below)
  and the resolver's own bounded query (see below), so a bug anywhere
  upstream can never turn rule evaluation into an unbounded loop on the
  hot path.

`PrismaTrackingResolver.resolve` (`apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts`)
fetches a campaign's `ACTIVE` rules with `ORDER BY priority ASC LIMIT 50`
— the bound is applied at the database query itself, not just
defensively re-applied after fetching everything. A rule beyond that
bound is never fetched, never evaluated, and cannot silently "come back"
once more low-priority-number rules are added under it — verified by a
dedicated tracker integration test that creates 51 rules and asserts the
51st is never considered.

`browser`/`os`/`deviceType` come from a second, separate, synchronous
`UserAgentParser.parse()` call inside `tracker.routes.ts` — deliberately
not threaded through from `recordClick`'s own parse, since routing must
be decided before the click write happens and parsing a UA string twice
is cheap and keeps the two call sites independent. `referrerHost` comes
from parsing the `Referer` header (`extractReferrerHost`, never throws).

## Max active rules per campaign

`MAX_ACTIVE_RULES_PER_CAMPAIGN = 50` is enforced when creating a rule
directly as `ACTIVE` or activating an existing one
(`apps/api/src/modules/routing-rules/routing-rules.service.ts`). This
check is **advisory, not a hard security invariant**: it has a narrow
TOCTOU window under two concurrent activate/create calls for *different*
rules (both could observe a count under the limit before either commits).
That's an accepted trade-off, not an oversight — unlike Conversion's
approve/reject/reverse (PR #8's review explicitly required provable
same-target concurrency there), a count briefly landing at 51 instead of
50 has no correctness impact, because `evaluateRules`/the resolver's
bounded query independently re-bound to 50 by priority order regardless
of how many `ACTIVE` rows actually exist. The check exists purely to give
an operator a clear 409 instead of a rule that silently never gets
evaluated because it fell outside the bound.

## Concurrency: activate/deactivate

`RoutingRuleStatus` is a plain two-state toggle — unlike
Campaign/TrackingLink/Conversion's larger state machines, both directions
(`ACTIVE <-> INACTIVE`) are always legal, so there is no illegal
transition to reject. Even so, `transitionRoutingRuleStatus` uses the same
`SELECT ... FOR UPDATE` row-lock pattern PR #8's review established for
`Conversion`, not a conditional-updateMany: a conditional-updateMany
guarded on "the status I read a moment ago" cannot prove idempotency for
two concurrent calls that both want the **same** target status (e.g.
activate+activate on an already-INACTIVE rule) — exactly one would win the
updateMany and the other would incorrectly 409, even though both callers
asked for exactly the state the row ends up in. Locking the row and
re-reading its status *after* the lock is held means the loser of the race
observes the winner's already-committed result before deciding, so
"already at target" is always idempotent success. Covered by dedicated
concurrent activate+activate, deactivate+deactivate, and
activate+deactivate integration tests in
`apps/api/test/rules-routing.test.ts`.

## Database enforcement

`enforce_routing_rule_campaign_organization`
(migration `20260902170000_rules_routing_engine`) mirrors
`enforce_conversion_click_attribution` (Phase 7): a `RoutingRule`'s
`organizationId` must match its `campaignId`'s actual organization at
insert time, and both columns are immutable after creation. Verified
directly against Postgres (not just unit-tested) before any API code was
built on top of it: a mismatched-organization insert, a `campaignId`
mutation attempt, and a duplicate-priority insert were each confirmed to
be rejected with the expected error before this phase's service layer was
written.

## API surface and RBAC

```
GET    /organizations/:organizationId/campaigns/:campaignId/rules
POST   /organizations/:organizationId/campaigns/:campaignId/rules
GET    /organizations/:organizationId/campaigns/:campaignId/rules/:ruleId
PATCH  /organizations/:organizationId/campaigns/:campaignId/rules/:ruleId
DELETE /organizations/:organizationId/campaigns/:campaignId/rules/:ruleId
POST   /organizations/:organizationId/campaigns/:campaignId/rules/:ruleId/activate
POST   /organizations/:organizationId/campaigns/:campaignId/rules/:ruleId/deactivate
```

RBAC: `VIEWER` can read; `MEMBER` can create/update/delete; `ADMIN` is
required for the explicit activate/deactivate actions — the same
"bigger blast radius needs a higher bar" reasoning
`campaigns.routes.ts` already documents for its own
activate/pause/archive endpoints. `PATCH` has no `status` field (the same
"no generic PATCH for status" convention Campaign/TrackingLink/Conversion
already established) — a `status` key in a PATCH body is silently
ignored, never rejected, matching those modules' own precedent.

Every route is nested under `:campaignId` — there is no flat
`/organizations/:organizationId/rules` listing, since a rule only ever
makes sense in the context of the one campaign it targets. A rule
accessed via the right organization but the wrong campaign 404s, the same
uniform-not-found IDOR convention every other nested resource
(tracking-links, conversions) uses.

## Audit events

`routing_rule.created`, `.updated`, `.deleted`, `.activated`,
`.deactivated` — written inside the same transaction as the mutation they
describe, via the existing `writeAuditLog` helper.

## Tracker observability

Each redirect decision logs `routingAction`, `routingSource`
(`BOT_POLICY` | `ROUTING_RULE` | `CAMPAIGN_DEFAULT`), and `matchedRuleId`
alongside the existing bot-classification log line — an operator can see
exactly why a given request was routed the way it was without guessing.

`tracker.routes.ts` additionally logs a `warn`-level line whenever a
request carries one of the recognized geo headers but fails the trusted-
edge check (`isTrustedEdgeRequest`) — this is defense-in-depth
observability, not enforcement (`extractCountrySignal` already refuses to
read the header regardless), but it's exactly the shape a client
attempting to spoof `COUNTRY` routing would produce, so an operator
monitoring tracker logs can see the attempt.

## Transparent tracker safety

Nothing about Phase 8 changes how `TARGET`/`SAFE_PAGE`/`BLOCK` are
*executed* — `tracker.routes.ts`'s redirect `switch` is untouched. Phase 8
only changes how the *choice* between those three is made
(`resolveRoutingDecision` replaces a direct call to
`resolveBotRoutingAction`, itself now one path `resolveRoutingDecision`
still calls as the campaign-default fallback). `TARGET` is not, and
cannot become, "redirect to a rule-configured URL" — there is no field on
`RoutingRule` capable of expressing that. Verified directly by a tracker
integration test ("a matching TARGET rule still follows the request's own
transparent redirection_url, never a rule-configured URL").

## Dashboard

The campaign detail page (`apps/dashboard/src/app/campaigns/[id]/page.tsx`)
gained a "Routing rules" card: a structured (dropdown-driven, not
freeform-JSON) condition builder — field/operator/value pickers, an
"Add condition" button building up a list, then name/priority/action to
create the rule — and a table of existing rules with
activate/deactivate/delete actions gated the same way the API gates them
(`canManage` for create/update/delete, `canRunLifecycle` for
activate/deactivate). No arbitrary JSON text box exists anywhere in this
UI.

## Tests

- `packages/shared/src/routing-rules.test.ts` (24 tests) — the pure
  evaluator and `resolveRoutingDecision`: matching semantics for all four
  operators, AND-only condition combination, fail-closed-on-unknown for
  every operator, priority ordering and array-order independence, the
  `MAX_ACTIVE_RULES_PER_CAMPAIGN` bound, and the full BOT_POLICY ->
  ROUTING_RULE -> CAMPAIGN_DEFAULT precedence including the
  zero-rules-is-backward-compatible guarantee.
- `packages/shared/src/routing-signals.test.ts` (20 tests) — the
  trusted-edge secret check and CDN-header country extractor
  (`isTrustedEdgeRequest`, malformed/absent/wrong/duplicated secret
  headers, constant-time comparison edge cases) and the referrer-host
  parser, including the spoofing-resistance suite: a direct request
  supplying each of the three geo headers with no secret configured
  resolves to null, a request that guesses the secret header's *name* but
  not its value still resolves to null, and only an exact secret match
  lets a well-formed geo header through.
- `packages/validation/src/routing-rules.test.ts` (35 tests) — schema
  validation, including the per-field value checks (typo'd
  `BOT_CLASSIFICATION`/`DEVICE_TYPE`/`COUNTRY` values rejected) and the
  IN/NOT_IN array-vs-single-value pairing.
- `apps/api/test/rules-routing.test.ts` (25 tests) — CRUD, RBAC,
  cross-org/cross-campaign IDOR, the `(campaignId, priority)` unique
  constraint on both create and update, the no-generic-PATCH-for-status
  convention, the max-active-rules budget, audit logging, and the
  activate/deactivate concurrency suite (duplicate concurrent
  activate+activate, deactivate+deactivate, and conflicting
  activate+deactivate).
- `apps/tracker/test/tracker.routes.test.ts` — 18 new tests: a matching
  rule overriding the campaign default for each action, the
  TARGET-stays-transparent safety test above, BOT traffic never being
  subject to a rule, priority ordering end-to-end, INACTIVE rules never
  evaluated, cross-campaign isolation, `DEVICE_TYPE`/`REFERRER_HOST`
  condition matching against real headers, the resolver-level 50-rule
  bound, and a dedicated "COUNTRY trust boundary" block: a direct request
  spoofing each of the three geo headers with no `TRUSTED_EDGE_SECRET`
  configured never matches; a request that guesses the secret header's
  name but supplies the wrong value never matches even on a deployment
  that HAS a secret configured; a request with no secret header at all
  never matches; and a request carrying the exact matching secret alongside
  a well-formed geo header does match end-to-end through the real
  redirect flow.

## Known limitations

- `COUNTRY` conditions only match once an operator has both configured
  `TRUSTED_EDGE_SECRET` and their CDN/edge to inject it — see "Country
  signal: trust boundary" above. This is a deliberate, documented,
  fail-closed default (unset means COUNTRY is always inert), not a bug —
  and unlike the module's original, rejected design, this is a real
  verified boundary, not merely "no CDN is present by default."
- The `MAX_ACTIVE_RULES_PER_CAMPAIGN` budget check has a narrow TOCTOU
  window under concurrent activation of *different* rules — see "Max
  active rules per campaign" above for why this is an accepted,
  documented trade-off rather than a correctness gap.
- A condition's `value` for `BROWSER`/`OS`/`REFERRER_HOST` is not
  validated against a closed list (unlike `BOT_CLASSIFICATION`/
  `DEVICE_TYPE`/`COUNTRY`) — the real-world set of browser/OS/hostname
  strings has no fixed enumeration, so a typo there fails silently as
  "never matches" rather than a write-time 400. This mirrors how
  free-text fields are already handled elsewhere in this codebase (e.g.
  `Conversion.eventName`).
