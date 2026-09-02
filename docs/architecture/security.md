# Security

## Password storage

Passwords are hashed with **argon2id** (`packages/auth/src/password.ts`,
via the `argon2` package), the OWASP-recommended default for new
applications. Plaintext passwords are never logged or stored; the
`registerSchema`/`loginSchema` Zod schemas (`packages/validation`) enforce
a minimum-strength password at registration (10+ characters, upper/lower
case, and a digit).

## Session model

Sessions are **stateless JWTs** (`packages/auth/src/session.ts`, HS256,
signed with `AUTH_SECRET`), delivered as an httpOnly, `SameSite=Lax`
cookie (`secure` in production) with a 7-day expiry.

Tradeoffs this accepts, deliberately, for Phase 1:

- **No server-side revocation list.** Logout clears the client's cookie
  but cannot invalidate a token that was copied elsewhere before logout.
  A stolen token remains valid until it expires (max 7 days) or
  `AUTH_SECRET` is rotated (which invalidates every session at once — a
  blunt but effective break-glass option). A future phase can add a
  revocation list (e.g. Redis-backed, checked in the `authenticate`
  preHandler) if this tradeoff stops being acceptable; it was not built
  now because it was not needed to satisfy any Phase 1 requirement and
  would have added a Redis dependency to every authenticated request.
- **Role is not embedded in the token.** The session JWT only carries
  `userId` and (optionally) `activeOrganizationId`. Role/membership is
  looked up from the database on every request that needs it
  (`fastify.requireOrganizationMember`), specifically so a role change or
  membership removal takes effect immediately instead of waiting for the
  token to expire.
- **The dashboard does not do server-side rendering against the
  authenticated API.** apps/api and apps/dashboard are separate origins;
  the session cookie is scoped to the API's origin. The dashboard's
  authenticated pages are client components that call the API directly
  from the browser with `credentials: "include"`, which works because
  same-site (same registrable "site", different port) requests still
  carry `SameSite=Lax` cookies. This keeps Phase 1 simple; a future phase
  could add a Next.js route-handler proxy (BFF pattern) if server-side
  rendering of authenticated pages becomes a requirement.

## Authorization

Role checks (`OWNER > ADMIN > MEMBER > VIEWER`, a flat linear hierarchy —
see `packages/auth/src/roles.ts`) are enforced **server-side**, per route,
via the `fastify.requireOrganizationMember(minimumRole)` preHandler
(`apps/api/src/plugins/auth.ts`). Every organization-scoped route declares
its own minimum role; there is no client-side-only enforcement of any
authorization rule.

**The OWNER role has an additional guard beyond the linear hierarchy.**
`requireOrganizationMember("ADMIN")` is satisfied by both ADMIN and OWNER,
which would otherwise let an ADMIN grant themselves (or anyone else)
OWNER, or demote/remove the real OWNER — a straightforward privilege
escalation, found and fixed during the Phase 1 CTO review. The service
layer (`assertActorCanManageOwnerRole` in
`apps/api/src/modules/organizations/organizations.service.ts`) now
requires the *actor* to already be an OWNER before any of `addMember`,
`updateMemberRole`, or `removeMember` can touch the OWNER role in either
direction (granting it, revoking it, or acting on a member who already
holds it). Covered by
`apps/api/src/modules/organizations/organizations.routes.test.ts` (see
"OWNER role privilege escalation guards").

The one non-trivial business rule in Phase 1 — a `CUSTOM_PARTNER_ATTRIBUTION`
referral configuration cannot become `ACTIVE` without an `APPROVED`
`ReferralProof` — is enforced in the **service layer**
(`activateReferralConfiguration` in
`apps/api/src/modules/referrals/referral-configurations.service.ts`), not
only validated in the dashboard UI. This means the rule holds even if a
future API client, script, or admin tool calls the endpoint directly. It
is additionally enforced by a **Postgres trigger**
(`enforce_referral_configuration_activation`, migration
`20260901204759_enforce_referral_activation_gate`) as a backstop against
any write that bypasses the service layer entirely — a raw SQL statement,
a future admin tool, or a data migration. Both layers are covered by
`apps/api/test/referral-workflow.test.ts`, including a test that attempts
the raw-SQL bypass directly and asserts the trigger rejects it.

## Domain activation invariant

A `TrackingDomain` cannot become `isActive = true` without first reaching
`verificationStatus = VERIFIED` (Phase 2: Domain Manager). Like the referral
activation gate above, this is enforced at two layers:

- **Service layer**: `activateTrackingDomain`
  (`apps/api/src/modules/domains/domains.service.ts`) performs the check and
  the write in a single conditional `updateMany` (`WHERE id = ... AND
  verificationStatus = 'VERIFIED'`) rather than a separate read-then-write,
  so a concurrent verification-status change can't open a window where an
  unverified domain gets activated; a zero-row update result is surfaced as
  `409 Conflict`.
- **Database layer**: a `CHECK` constraint,
  `tracking_domains_active_requires_verified` (migration
  `20260902061926_domain_manager_verification_fields`), rejects any row
  where `isActive` is true and `verificationStatus` isn't `VERIFIED` —
  including a raw SQL statement that bypasses the API entirely. See
  `apps/api/test/domains-lifecycle.test.ts` ("database-level activation
  invariant") for a test that performs exactly that raw-SQL bypass and
  asserts it's rejected.

Verification itself is never client-asserted: `POST
.../domains/:domainId/verify` performs a real DNS TXT-record lookup
(`apps/api/src/modules/domains/dns-verification.ts`, using Node's built-in
`dns/promises` resolver) against a token the server generated — there is no
request field a client can set to force `verified: true` or
`status: VERIFIED/ACTIVE`; the verify/activate/deactivate endpoints don't
even parse a request body. The DNS check is a lookup only, never an HTTP
fetch to a client-influenced URL, so it carries no SSRF risk.

**Verification token lifecycle.** The token is generated once, at domain
creation, and is never rotated by a retry: `verifyTrackingDomain` reuses
`domain.verificationToken` on every subsequent call rather than generating
a fresh one, because regenerating it on retry would invalidate whatever DNS
TXT record the customer just published for the original value — a token
should only ever change if the domain itself does (a new domain, a new
token). `verificationRequestedAt` is stamped on every attempt and doubles
as a per-domain retry cooldown (`VERIFICATION_RETRY_COOLDOWN_MS`, currently
10s): calling `/verify` again before the cooldown elapses returns `429
RATE_LIMITED` without touching status or token. This exists to stop the
endpoint from being hammered — each call performs a real DNS lookup and
writes two audit log entries — not for any correctness reason. See
`apps/api/test/domains-lifecycle.test.ts` ("verification retry/regeneration
semantics") for the tests pinning this down.

The raw token itself is not treated as a secret in the sense of "must never
be disclosed to its own organization" (it's designed to be published in
public DNS), but it is kept out of every API response except wrapped inside
`verificationInstructions.recordValue`, and out of audit log metadata
entirely (only `hostname` is recorded). It is also an explicit entry in
`packages/logger`'s redaction list (`verificationToken`) — necessary
because pino/fast-redact paths match an exact property name per segment,
so the existing `"token"` entry does **not** catch a field named
`verificationToken`; a field like this needs its own explicit entry rather
than assuming a broader existing one covers it.

## Input validation

Every mutating endpoint validates its body with a Zod schema from
`packages/validation` before touching the database (see the error
handler's `ZodError` branch in `apps/api/src/plugins/error-handler.ts`,
which turns validation failures into a consistent `400 VALIDATION_ERROR`
response rather than leaking a raw stack trace).

## SQL injection

Nearly all database access goes through Prisma's generated client
(`packages/database`), which parameterizes queries automatically. The
test-only `resetDatabase()` helper (`apps/api/test/db-reset.ts`), which
truncates tables between test runs, uses raw SQL but is never reachable
from application code or any HTTP route.

**Click Analytics (Phase 4)** is the first application-code use of raw
SQL, via `prisma.$queryRaw` with `Prisma.sql`/`Prisma.join` in
`apps/api/src/modules/analytics/analytics.service.ts` — needed for
aggregation (`COUNT`/`GROUP BY`/`date_trunc`) Prisma's query builder
doesn't expose. Every value that varies per request (`organizationId`,
the date range, filter IDs, `timezone`, the `bucket` unit) is passed as a
tagged-template parameter, never string-concatenated into the query text,
so it is parameterized exactly the same way Prisma's own query builder
would parameterize it. `$queryRawUnsafe` (which takes a plain string and
would require the caller to parameterize by hand) is not used anywhere in
this module.

## Consistent API error format

Every error response from apps/api has the shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```

defined in `packages/shared/src/api-error.ts` and enforced centrally by
`apps/api/src/plugins/error-handler.ts`. Unexpected (non-`ApiError`)
exceptions are logged in full server-side but returned to the client as a
generic `500 INTERNAL_ERROR` with no stack trace or internal detail.

## Transparent Click Tracker (apps/tracker, Phase 3)

`apps/tracker`'s `GET /:slug` is the first unauthenticated, public,
high-volume endpoint in this codebase — different threat model from
apps/api's authenticated admin surface. Full architectural rationale is in
`docs/compliance/google-transparent-tracker.md`; this section covers its
security properties specifically.

- **Domain gating reuses Phase 2's invariant, doesn't re-implement it.**
  `PrismaTrackingResolver` (`apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts`)
  requires `TrackingDomain.verificationStatus = VERIFIED` and
  `isActive = true` before ever looking at the slug. Unknown, unverified,
  and inactive domains all return the same `404` — distinguishing them to
  an anonymous caller would leak which hostnames are registered tracking
  domains. An inactive/unknown `TrackingLink` gets `404`; a
  `PAUSED`/`ARCHIVED` one gets `410`, since revealing "this slug used to
  work" is materially less sensitive than domain enumeration.
- **Organization isolation is structural, then re-checked.** A
  `TrackingLink` is looked up by the compound key `(trackingDomainId,
  slug)`, so one organization's link can never be returned for another
  organization's domain by construction of the query — not by an
  app-level `WHERE organizationId = ...` filter that a bug could omit.
  `PrismaTrackingResolver` additionally asserts
  `campaign.organizationId === domain.organizationId` before returning,
  purely as defense in depth against a data-integrity mistake (`apps/api`'s
  `createTrackingLink` already guarantees this at write time — see
  `apps/api/test/tracking-foundation.test.ts`). Covered by
  `apps/tracker/test/tracker.routes.test.ts` ("cross-organization
  isolation"), including a test that manually constructs the mismatched-org
  row this check exists to catch.
- **The transparent redirect target is deliberately open by design — read
  this as a tradeoff, not an oversight.** `redirection_url` is validated
  by `validateTransparentRedirectUrl`
  (`packages/shared/src/transparent-redirect.ts`) — http(s) only, no
  userinfo, no control characters (defends against `Location`-header CRLF
  injection independent of Node's own header-value validation), bounded
  length — using the exact same parsed value for both the check and the
  redirect (no two-parser confusion). It does **not** restrict which
  http(s) host the URL points to: that's the point of "transparent," and
  restricting it would reintroduce the opaque-backend-destination pattern
  this design exists to avoid. See
  `docs/compliance/google-transparent-tracker.md` for the full reasoning
  and its operational implications.
- **No server-side fetch of any redirect target.** The tracker's only
  network action on a redirect decision is setting a `Location` header —
  never an outbound HTTP request to `redirection_url` or to a Safe Page
  URL, which is what would turn this into an SSRF vector rather than "just"
  an open redirect.
- **Bot classification cannot be influenced by the client.**
  `HeuristicBotDetectionEngine` computes its verdict solely from
  server-observed request data — the `User-Agent` header and a small,
  explicit whitelist of other headers (`Accept`, `Accept-Language`,
  `Sec-Fetch-Mode/Site/Dest`, Phase 5); no query parameter, arbitrary
  custom header, or other client-supplied value is ever read for this
  decision. Covered by tests that send `?isBot=false&bot=false` (and,
  Phase 5, `classification=HUMAN&score=0&safePageUrl=...`) alongside a
  known-bot UA and assert the Safe Page still fires unchanged, and a test
  confirming arbitrary out-of-whitelist headers (e.g. `X-Bot-Override`)
  have no effect. See `docs/architecture/bot-detection.md` for the full
  detection architecture and Phase 5's routing integration.
- **Click IDs are not sequential or guessable.** Generated with
  `crypto.randomUUID()` (`apps/tracker/src/modules/tracker/click-id.ts`)
  rather than relying on the `Click` model's default `cuid()`, and never
  appended to the outward-facing redirect URL — it exists purely for the
  `Click` row and internal log correlation.
- **No raw IP is ever stored.** `hashIp` (`packages/shared/src/ip-hash.ts`)
  salts and one-way-hashes the request IP before it reaches `Click.ipHash`.

## Bot Detection Integration (apps/tracker, Phase 5)

Full design rationale is in `docs/architecture/bot-detection.md`; this
section covers its security-relevant properties specifically.

- **The Safe Page destination is never client-controlled, for any
  classification.** `resolveBotRoutingAction`
  (`packages/shared/src/bot-traffic-policy.ts`) only ever reads
  `resolution.safePageUrl`, sourced from `Campaign.safePageUrl` — never
  from `redirection_url`, a query parameter, or a header. Covered by
  regression tests for `BOT` (always routed to `SAFE_PAGE`) and for
  `SUSPICIOUS`/`UNKNOWN` when a campaign's policy resolves to `SAFE_PAGE`,
  each asserting an attacker-controlled `redirection_url`
  (`https://attacker.example/phish`) never reaches the response's
  `Location` header.
- **`BLOCK` never falls back to a guessed destination.** Even when a
  Safe Page *is* configured, a `BLOCK`-policy classification returns the
  same controlled `404` as "no Safe Page configured" — it does not
  silently degrade to `SAFE_PAGE` or `TARGET`. Covered by a dedicated
  test.
- **A detection engine failure degrades to `UNKNOWN`, never to `HUMAN`
  or `BOT`.** `classifyWithSafeFallback`
  (`apps/tracker/src/modules/bot-detection/classify-with-fallback.ts`)
  catches a throw, a rejected promise, or a 50ms timeout and always
  returns `UNKNOWN` — never assumes a failure means a request is
  trustworthy (`HUMAN`) or automatically blocks it (`BOT`) without
  evidence. The resulting `UNKNOWN` verdict is then routed through the
  campaign's own `unknownTrafficPolicy` like any other `UNKNOWN`
  classification, not a special-cased bypass.
- **No arbitrary request header reaches the detection engine.** Only five
  explicitly named headers are extracted
  (`extractDetectionHeaderSignals` in
  `apps/tracker/src/modules/tracker/tracker.routes.ts`) — a
  client-supplied header outside that whitelist (e.g.
  `X-Bot-Override: false`) is never read by the classification path at
  all. Covered by a dedicated test.
- **The routing-policy resolver is pure and synchronous.**
  `resolveBotRoutingAction` performs no I/O and cannot itself fail or
  hang; the only failure surface is the detection engine call that feeds
  it, which is independently guarded (above).

## Campaign Manager (apps/api, Phase 6)

Full design rationale is in `docs/architecture/campaign-manager.md`; this
section covers its security-relevant properties specifically.

- **Status can never be forced through the generic `PATCH`.**
  `updateCampaignSchema`/`updateTrackingLinkSchema`
  (`packages/validation/src/campaigns.ts`, `tracking-links.ts`) have no
  `status` field at all — a `status` key in a `PATCH` body is silently
  stripped by Zod's default (non-strict) object parsing, the same as any
  other unrecognized field, and never reaches the database. The only way
  to change status is the explicit `POST .../activate`, `.../pause`,
  `.../archive` endpoints, each of which validates the transition against
  the state machine in `packages/shared/src/campaign-lifecycle.ts` /
  `tracking-link-lifecycle.ts` before writing anything — see
  `apps/api/test/campaign-manager.test.ts` ("mass assignment / status
  manipulation").
- **Lifecycle transitions are enforced once, in the domain layer — not
  duplicated per caller and not left to the dashboard.** Every path that
  can change a `Campaign`/`TrackingLink` status (the three explicit
  endpoints) routes through the same `assertValidCampaignStatusTransition`/
  `assertValidTrackingLinkStatusTransition` call, so there is exactly one
  place that decides "is this transition legal" — a future caller (a
  script, an internal tool, a future bulk-action endpoint) cannot bypass
  it by calling the service function directly.
- **A campaign/tracking link can only reference a domain that can actually
  serve traffic.** `assertTrackingDomainAssignable`
  (`apps/api/src/modules/shared/org-scoped-refs.ts`) requires the
  `TrackingDomain` to belong to the same organization (the existing IDOR
  boundary, unchanged) **and** to be `VERIFIED` and active — Phase 1-5 only
  checked organization ownership, so a campaign could previously be
  configured to point at a domain that would guarantee a `domain_not_
  verified`/`domain_inactive` failure at the tracker on first click. This
  closes that gap at configuration time instead of deferring it to a
  customer's first real click.
- **A campaign that serves live traffic cannot have its tracking domain
  swapped out from under it.** `updateCampaign`
  (`apps/api/src/modules/campaigns/campaigns.service.ts`) rejects any
  change to `trackingDomainId` while `status === "ACTIVE"` with a `409`;
  the campaign must be paused first. `destinationId` and `safePageUrl` are
  exempt from this restriction — neither is read by the tracker's actual
  redirect decision (Phase 3's request-supplied `redirection_url`
  architecture), so changing them cannot break an in-flight resolution the
  way `trackingDomainId` can.
- **No new active traffic infrastructure under a retired campaign.**
  Creating a `TrackingLink`, or reactivating a `PAUSED` one, under a
  `Campaign` whose `status` is `ARCHIVED` is rejected with a `409`
  (`assertCampaignAcceptsNewOrReactivatedLinks`). Config-only changes
  (e.g. updating a link's `destinationId`) are not gated by this — only
  creation and (re)activation are.
- **Tracking-link organization isolation extends to the campaign/link
  relationship, not just the organization.** The nested routes
  (`/campaigns/:campaignId/tracking-links/:trackingLinkId`) use
  `getTrackingLinkForCampaign`, which requires the link to belong to
  *that* campaign, not merely to *some* campaign in the organization — a
  link that exists, in-org, under a different campaign 404s rather than
  being returned or modified through the wrong campaign's URL. Covered by
  `apps/api/test/campaign-manager.test.ts` ("wrong campaign/link
  relationship").
- **Lifecycle endpoints require `ADMIN`, one tier above the `MEMBER` role
  that can create/edit configuration** — matching the precedent Phase 2
  set for domain `activate`/`deactivate`. Starting, stopping, or
  permanently retiring a campaign's live traffic is a bigger blast radius
  than editing its configuration.

## Conversion Tracking (apps/api, Phase 7)

Full design rationale is in `docs/architecture/conversion-tracking.md`;
this section covers its security-relevant properties specifically.

- **Campaign/tracking-link attribution can never be client-supplied, and
  is enforced twice.** `createConversionSchema`
  (`packages/validation/src/conversions.ts`) has no `campaignId`/
  `trackingLinkId`/`organizationId` fields at all — a request that
  includes them has those keys silently stripped, the same non-strict
  parsing Phase 6 relies on for its own PATCH bodies. `createConversion`
  reads them from the referenced `Click` row instead. As a database-level
  backstop, a trigger (`enforce_conversion_click_attribution`, migration
  `20260902155750_conversion_tracking_foundation`) re-derives and
  validates these fields at insert and forbids changing any of them
  (`clickId` included) afterward — a conversion's attribution can never
  disagree with its click even for a write that bypasses the service
  layer entirely (a raw SQL statement, a future admin tool, a bug).
  Covered by `apps/api/test/conversion-tracking.test.ts` ("ignores a
  client-supplied campaignId/trackingLinkId/organizationId override
  attempt").
- **Cross-org click attribution is a uniform 404, not a distinguishable
  403/400.** A `clickId` belonging to another organization is
  indistinguishable from one that doesn't exist — both fail the same
  `clicks.findFirst({ where: { id, organizationId } })` lookup and return
  the same `404`, so a caller can never use this endpoint to probe
  whether a given click ID is real in an organization they don't belong
  to. Same uniform-not-found convention this codebase already applies to
  campaign/tracking-domain lookups.
- **`clickId` is not an authorization credential.** Knowing a click ID is
  not sufficient to create a conversion against it — the caller must also
  be an authenticated, organization-scoped member with at least `MEMBER`
  role. Click IDs are UUIDs (`crypto.randomUUID()`, unguessable), but that
  property exists for Phase 3/4 reasons (never appended to the outward
  redirect URL — see `docs/compliance/google-transparent-tracker.md`),
  not because this phase treats possessing one as proof of authorization.
- **Duplicate submissions are prevented at the database level, not by a
  check-then-insert race.** The unique index
  `conversions_organizationId_externalConversionId_key` is the actual
  enforcement point; `createConversion` attempts the insert directly and
  translates the resulting unique-violation (Prisma `P2002`) to a `409`.
  Two concurrent requests with the same `externalConversionId` both reach
  the database — exactly one insert can succeed. Covered by a test that
  fires two identical requests concurrently via `Promise.all` and asserts
  exactly one conversion exists afterward.
- **Status can never be forced through a generic update endpoint** — there
  is no `PATCH` for conversions at all, only the three explicit
  `POST .../approve`, `.../reject`, `.../reverse` endpoints (no request
  body), each validated against `packages/shared/src/conversion-lifecycle.ts`
  before writing anything. Concurrent status changes are resolved by the
  same conditional-`updateMany` pattern Phase 6 established (loser gets a
  `409`, never a silently clobbered write).
- **Metadata has explicit size/depth limits** (`boundedMetadataSchema`,
  `packages/validation/src/conversions.ts`): serialized size capped at
  10,000 bytes, nesting depth capped at 5 levels. Unlike
  Campaign/Destination/TrackingLink's `metadata` fields (no such limit),
  a conversion is the first write path in this codebase callable by a
  potentially automated/machine caller — an advertiser's own
  conversion-reporting integration — rather than only a human filling out
  a dashboard form, making an unbounded JSON payload a more credible
  abuse vector here specifically.
- **Monetary value is validated, not trusted as opaque.** `value` must be
  finite (rejects `NaN`/`Infinity`, which JSON itself can't represent
  directly but a malformed numeric string could smuggle past a looser
  check), non-negative, and capped at the largest amount
  `Decimal(12,2)` can hold — an out-of-range submission fails with a
  clean `400` rather than a raw database error. A `REVERSED` conversion's
  `value` is never modified or negated; only its `status` changes — see
  `docs/architecture/conversion-tracking.md#reversal-not-negation`.
- **`occurredAt` is bounded, not an unconditionally trusted client
  clock.** Rejected if more than 5 minutes ahead of the server's own
  clock at request time (absorbs ordinary clock drift while catching
  absurd future dates); no lower bound, since a legitimately backfilled
  conversion may reference an old click.
- **RBAC gates status decisions above ingestion.** Reporting a conversion
  is `MEMBER`-level (same tier as creating a campaign/tracking link);
  `approve`/`reject`/`reverse` require `ADMIN` — a compromised or
  careless `MEMBER` account can report events but cannot single-handedly turn
  them into approved, revenue-counted conversions.

## Rules & Routing Engine (apps/api + apps/tracker, Phase 8)

Full design rationale is in `docs/architecture/rules-routing.md`; this
section covers its security-relevant properties specifically.

- **A rule can never specify an arbitrary redirect destination.**
  `RoutingRuleAction` is the exact same three-value type Phase 5's
  `BotTrafficPolicyAction` already established (`TARGET`/`SAFE_PAGE`/
  `BLOCK`) — there is no field anywhere on `RoutingRule` capable of
  encoding a URL. `TARGET` still means "follow the request's own
  validated `redirection_url`," never a rule-configured value — this is
  what keeps the Google Transparent Click Tracker architecture (Phase 3)
  intact even though routing decisions are now rule-driven. Covered by a
  dedicated tracker test asserting the exact request-supplied
  `redirection_url` is followed even when a `TARGET` rule matches.
- **No eval, no expression language.** A condition's `field` is a closed
  6-value enum, `operator` a closed 4-value enum, `value` a bounded string
  or bounded string array (max 25 entries) — validated by
  `packages/validation/src/routing-rules.ts`. There is no code path that
  interprets a rule's JSON as anything other than a fixed
  field/operator/value comparison; a malicious or malformed rule payload
  cannot cause arbitrary code execution or an unbounded computation.
- **`BOT` classification can never be overridden by a rule.** A `BOT`
  verdict always routes to `SAFE_PAGE`; routing rules are not even
  evaluated for `BOT` traffic. This preserves Phase 5's original decision
  that bot/human classification routing is not configurable, closing off
  any path where a crafted rule could route known-automated traffic to a
  real destination.
- **organizationId/campaignId can never be client-supplied, and is
  enforced twice** — the same pattern Phase 7 established for Conversion
  attribution. The service layer only ever takes these from the
  authenticated, membership-checked URL path; as a database-level
  backstop, `enforce_routing_rule_campaign_organization` (migration
  `20260902170000_rules_routing_engine`) re-derives and validates
  `organizationId` against the referenced campaign at insert time and
  forbids changing either column afterward.
- **Priority collisions are a real database constraint, not
  application-level tie-breaking.** `@@unique([campaignId, priority])`
  means two rules on one campaign can never share a priority — there is
  no ambiguous evaluation order to reason about or get wrong.
- **Status can never be forced through a generic update endpoint** — no
  `PATCH` accepts a `status` field (silently ignored, not rejected, the
  same convention Campaign/TrackingLink/Conversion already established);
  only the explicit `POST .../activate`/`.../deactivate` endpoints (no
  request body) change it. Concurrent duplicate activate/deactivate calls
  on the same rule are resolved by `SELECT ... FOR UPDATE` row locking
  (the same pattern PR #8's review established for Conversion, not the
  conditional-updateMany pattern earlier phases used) — a same-target
  concurrent retry is idempotent success, never a spurious `409`. Covered
  by concurrent activate+activate, deactivate+deactivate, and
  activate+deactivate integration tests.
- **Rule evaluation is bounded and cannot become a hot-path DoS vector.**
  The tracker's rule fetch itself is bounded (`LIMIT
  MAX_ACTIVE_RULES_PER_CAMPAIGN`, currently 50) and `evaluateRules`
  independently re-bounds defensively even if handed more — no request
  can trigger unbounded rule evaluation regardless of how many rules a
  campaign accumulates. `MAX_ACTIVE_RULES_PER_CAMPAIGN` is also enforced
  (advisory, with a documented narrow TOCTOU window — see
  `docs/architecture/rules-routing.md#max-active-rules-per-campaign`) when
  rules are created/activated, so an operator gets a clear error instead
  of silently-never-evaluated rules.
- **The `COUNTRY` condition is gated behind a real, verified trust
  boundary — not merely the presence of a CDN-shaped header name.** An
  earlier version of this code treated the mere presence of
  `cf-ipcountry`/`x-vercel-ip-country`/`cloudfront-viewer-country` as
  sufficient, which is not a boundary at all: any direct client can set
  those exact header names on its own request, and validating that the
  *value* looks like a well-formed 2-letter code proves nothing about who
  *sent* it (PR #9 review finding, fixed before merge). The actual
  boundary (`packages/shared/src/routing-signals.ts`'s
  `isTrustedEdgeRequest`) is a shared secret
  (`TRUSTED_EDGE_SECRET`, `packages/config`, unset by default): a request
  is only ever treated as having passed through a trusted edge if it
  carries that exact value as its `x-adstrackio-edge-secret` header,
  compared in constant time (SHA-256-digest `timingSafeEqual`, so a
  length mismatch or byte-by-byte guess can't be inferred from response
  timing). A geo header is read at all only after that check passes — an
  attacker who spoofs a geo header, or even spoofs the secret header name
  with the wrong value, or omits the secret header entirely, gets `null`
  regardless of how "real" the geo header itself looks. With
  `TRUSTED_EDGE_SECRET` unset (this codebase's own default), `country` is
  `null` for every request unconditionally — COUNTRY routing is inert
  until an operator deliberately configures both this service's secret
  AND their CDN/edge to inject it. See
  `docs/architecture/rules-routing.md#country-signal-trust-boundary` for
  the full mechanism and per-CDN setup, and
  `packages/shared/src/routing-signals.test.ts` for the spoofing-resistance
  test suite this claim is backed by.
- **RBAC mirrors Campaign's own asymmetry.** `VIEWER` reads; `MEMBER`
  creates/updates/deletes; `ADMIN` is required for activate/deactivate —
  a compromised or careless `MEMBER` account can draft/edit rules but
  cannot single-handedly put one into production traffic.

## Click Analytics (apps/api, Phase 4)

Full design rationale is in `docs/architecture/click-analytics.md`; this
section covers its security-relevant properties specifically.

- **No new authorization path.** Every analytics endpoint uses the same
  `[fastify.authenticate, fastify.requireOrganizationMember("VIEWER")]`
  preHandler pair as every other read endpoint — there is no
  analytics-specific role check, weaker default, or bypass.
- **Every query is unconditionally organization-scoped.** `buildWhere`
  (`apps/api/src/modules/analytics/analytics.service.ts`) always includes
  `organizationId = $1` before any optional filter is applied, so
  filtering by another organization's `campaignId`/`trackingLinkId`/
  `trackingDomainId` can only ever produce an empty result — never another
  tenant's data. Covered by `apps/api/test/analytics.test.ts`
  ("organization isolation").
- **All query parameters are validated before reaching SQL.**
  `packages/validation/src/analytics.ts` enforces: `from`/`to` are valid
  dates with `from <= to`; the resolved range is capped at 366 days;
  `campaignId`/`trackingLinkId`/`trackingDomainId` are well-formed cuids;
  `timezone` is a real IANA name (validated via `Intl.DateTimeFormat`,
  which also rejects injection-shaped strings); `bucket` is one of a fixed
  enum. Every value that reaches a raw SQL query
  (`analytics.service.ts`) does so as a `Prisma.sql`-parameterized value,
  never string-concatenated — including `timezone` and `bucket`, verified
  directly against Postgres to carry no injection risk despite going
  inside `date_trunc(...)`/`AT TIME ZONE ...`.
- **No raw IP, `ipHash`, or visitor fingerprint is ever returned.**
  Analytics responses are aggregate objects (`ClickSummary`/
  `ClickTimeseriesPoint`/`ClickBreakdownRow`) with no per-click identifying
  field. Covered by `apps/api/test/analytics.test.ts` ("privacy"), which
  asserts every endpoint's full response body never contains `ipHash` or
  anything matching `/fingerprint/i`.
- **No arbitrary HTTP requests to client-controlled URLs.**
  `GeoLocationProvider.lookup(ip)` (`packages/shared/src/geo-location.ts`)
  takes the server's own observed request IP, never a client-supplied URL
  or hostname — the default `NullGeoLocationProvider` makes no network
  call at all, and the interface gives no client-influenced input to a
  future implementation that could turn it into an SSRF vector.
- **Enrichment failures — and latency — cannot break the tracker's
  redirect path.** `UserAgentParser.parse` is synchronous and wrapped in
  try/catch in `apps/tracker/src/modules/tracker/tracker.service.ts`,
  degrading to "unknown" on any throw. `GeoLocationProvider.lookup` is
  never awaited on the redirect path at all: the `Click` row is written
  with geo fields null, `recordClick` returns, and the geo lookup runs
  afterward in the background, applying its result via a follow-up
  `UPDATE` if/when it resolves. A broken, slow, or even a permanently
  hanging geo provider can degrade analytics data quality (geo fields stay
  null) but can never delay or prevent a `Click` from being written or a
  redirect from being issued — proven directly by a regression test using
  a `GeoLocationProvider` whose promise never resolves during the test.
  See
  `docs/architecture/click-analytics.md#data-enrichment-strategy-keeping-the-redirect-hot-path-safe`.

## Secrets and logging

- `packages/logger` redacts `password`, `passwordHash`, `token`,
  `accessToken`, `refreshToken`, `verificationToken`, `authorization`,
  `cookie`, `secret`, `authSecret`, and `apiKey` fields (at any nesting
  depth pino's redact paths can reach) before anything is written to
  stdout.
- `AuditLog.metadata` must never contain secrets — this is a code-review
  convention today (every `writeAuditLog` call site is small and
  reviewable); nothing currently persists a raw password/token into an
  audit entry.
- No `.env` file is committed; `.env.example` documents every variable
  without real values. `packages/config` validates the environment eagerly
  at process startup (`getEnv()`/`loadEnv()`) and refuses to start if
  `AUTH_SECRET` is missing, too short, or still the placeholder value from
  `.env.example` — see `packages/config/src/schema.ts`.

## Transport-level protections

`apps/api` registers, via `@fastify/helmet`, `@fastify/cors`, and
`@fastify/rate-limit` (`apps/api/src/plugins/security.ts`):

- **Helmet** default security headers, with a restrictive
  `Content-Security-Policy` (`default-src 'none'`) since the API serves
  only JSON, never HTML.
- **CORS** restricted to `APP_URL` with `credentials: true` (not a
  wildcard origin — required for cookies to work at all, and prevents
  arbitrary origins from making authenticated requests).
- **Rate limiting**: a global baseline (300 requests/minute/IP), and a
  stricter limit on `/api/v1/auth/register` and `/api/v1/auth/login` (10
  requests/minute) to slow down credential-stuffing and brute-force
  attempts.

## Known limitations (tracked, not hidden)

- No server-side session revocation (see above).
- No email verification or password-reset flow yet (out of scope for
  Phase 1's auth foundation; add when a real transactional email provider
  is wired in).
- No CSRF token: the session cookie is `SameSite=Lax`, which blocks the
  cross-site `POST` requests CSRF relies on, but this hasn't been
  independently verified against a CSRF test suite. A future phase should
  add explicit CSRF protection if the cookie's `SameSite` policy is ever
  loosened (e.g. to support a genuinely cross-site embed).
- Rate limiting is in-memory per `@fastify/rate-limit`'s default store,
  which resets on restart and doesn't share state across multiple API
  instances. `REDIS_URL` is already part of the typed config for exactly
  this reason — swapping in a Redis-backed store is a small, isolated
  change when apps/api is horizontally scaled.
- **apps/tracker has no rate limiting at all** (Phase 3). Deliberately
  deferred: real ad-click traffic can legitimately arrive in high-volume
  bursts from a shared egress IP (corporate NAT, mobile carrier CGNAT), and
  a naive per-IP limit risks dropping real clicks more than it stops
  abuse. Revisit with real traffic data.
- **The transparent redirect endpoint is an open redirect by design** —
  see `docs/compliance/google-transparent-tracker.md` for why this is
  accepted rather than fixed, and what it does and doesn't restrict.
- **`HeuristicBotDetectionEngine` is a multi-signal but still
  explicitly-provisional heuristic** (Phase 5), not a production-grade or
  ML-based bot-detection system. It will misclassify some real traffic in
  both directions under adversarial conditions — see
  `docs/architecture/bot-detection.md` for the full scoring model and its
  limitations. A future non-heuristic engine can still be dropped in
  through the same `BotDetectionEngine` interface without touching the
  tracker route.
- **No tracker-level rate limiting, still** (Phase 5 did not add one —
  see `docs/architecture/bot-detection.md#rate-limiting--abuse-considerations`
  for the documented extension point).
