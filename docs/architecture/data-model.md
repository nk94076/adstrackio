# Data Model

Source of truth: `packages/database/prisma/schema.prisma`. This document
explains the *why* behind the schema; read the Prisma file for exact field
types, defaults, and indexes.

## Entity overview

Status legend: **IMPLEMENTED** — working end-to-end, covered by tests, safe
to build on as-is. **FOUNDATION ONLY** — the schema/model exists and is
deliberately shaped for what comes later, but the behavior that would make
it "live" isn't built yet. **FUTURE PHASE** — not started; named here only
so the roadmap this schema was designed against is explicit.

| Model | Purpose | Status |
| --- | --- | --- |
| `User` | An individual account (email + password hash) | IMPLEMENTED |
| `Organization` | A workspace/tenant | IMPLEMENTED |
| `OrganizationMember` | Join table: user ↔ organization, with a role | IMPLEMENTED |
| `TrackingDomain` | A hostname an organization tracks clicks on | IMPLEMENTED (Phase 2) — real DNS TXT verification; activation gated on it. Phase 3's tracker requires VERIFIED + active before serving traffic |
| `Destination` | The business URL a campaign/link points to | IMPLEMENTED (CRUD + URL validation). Administrative/informational only for tracker purposes as of Phase 3 — see `TrackingLink` below |
| `Campaign` | Groups tracking links under a name/status/budget; also carries the Phase 3 Safe Page URL | IMPLEMENTED (CRUD). `safePageUrl` is Phase 3's minimal bot-routing foundation, not a routing-rules engine (FUTURE PHASE: Rules & Routing Engine) |
| `TrackingLink` | A routable slug on a domain | IMPLEMENTED (Phase 3) — `apps/tracker`'s `GET /:slug` resolves and redirects through this |
| `Click` | An individual inbound tracking event | IMPLEMENTED (Phase 3, enriched Phase 4) — written by the tracker on every resolved request; Phase 4 added real browser/OS enrichment and an optional geo-location provider (see `docs/architecture/click-analytics.md`) |
| `Conversion` | A recorded conversion event | FOUNDATION ONLY — schema only, no postback ingestion (FUTURE PHASE: Conversion Tracking) |
| `BotEvent` | A bot-detection verdict for a click | IMPLEMENTED (Phase 3) — written by the tracker via the explicitly-provisional `HeuristicBotDetectionEngine`; a real detection engine is FUTURE PHASE: Bot Detection Integration |
| `ReferralConfiguration` | How referral/attribution is labeled for a campaign | IMPLEMENTED, including the approval gate (app + database level) |
| `ReferralProof` | Evidence supporting a custom partner attribution config | IMPLEMENTED |
| `AuditLog` | Append-only record of administrative actions | IMPLEMENTED |

## Identity & organizations

`User` and `Organization` are connected through `OrganizationMember` rather
than an implicit many-to-many, specifically so a membership can carry a
`role` (`OWNER | ADMIN | MEMBER | VIEWER`) today and additional per-membership
attributes later (e.g. a per-member permission override) without a schema
rewrite. A user can belong to multiple organizations; the API resolves
"active organization" per-request from the URL (`/organizations/:id/...`),
not from a single "current org" column on `User` — see
`docs/architecture/security.md` for how the client tracks which
organization is active.

## Tracking domain, destination, campaign, tracking link

These four models are deliberately kept as separate concerns:

- **TrackingDomain** — a hostname the organization controls and intends to
  serve tracking traffic from. `verificationStatus` starts `PENDING` and is
  moved to `VERIFIED` only by a real, server-performed DNS TXT-record lookup
  (Phase 2: Domain Manager — see `docs/architecture/security.md#domain-activation-invariant`
  and `apps/api/src/modules/domains/dns-verification.ts`). `isActive`
  defaults to `false` and can only become `true` via the `/activate`
  endpoint once `verificationStatus = VERIFIED`; this is enforced both in
  the service layer and by a Postgres `CHECK` constraint
  (`tracking_domains_active_requires_verified`, migration
  `20260902061926_domain_manager_verification_fields`). `sslStatus` remains
  `NOT_CONFIGURED` — certificate provisioning is not part of Phase 2 and is
  left for a future phase to implement for real rather than being faked
  here. Domain Manager deliberately does not implement any redirect,
  destination-resolution, click-logging, or bot-routing behavior — a
  verified/active `TrackingDomain` is only ever a row in this table until
  Phase 3 (Transparent Click Tracker) builds the actual redirect path; see
  `docs/compliance/google-transparent-tracker.md`.
- **Destination** — the actual business URL (e.g. an offer page or app
  store link). Stored and normalized independently of any campaign so the
  same destination can be reused across campaigns/tracking links, and so
  future attribution reporting can group by destination. **As of Phase 3,
  a `TrackingLink.destinationId` is administrative/informational only** —
  the live tracker route does not use it to choose a redirect target. See
  "The transparent redirect parameter" below and
  `docs/compliance/google-transparent-tracker.md` for why.
- **Campaign** — the organizational/business grouping (name, status,
  budget, flight dates). A campaign optionally references a default
  `TrackingDomain` and `Destination`, and (Phase 3) carries `safePageUrl`
  — the server-configured destination for traffic the tracker classifies
  as a bot. `Campaign.status` does not currently gate traffic: only
  `TrackingDomain` verification/activation and `TrackingLink.status` do.
- **TrackingLink** — the actual routable unit: `(trackingDomainId, slug)`
  is unique. `apps/tracker`'s `GET /:slug` route resolves a request's
  hostname+slug to this row via `TrackingResolver`
  (`packages/shared/src/tracking-resolver.ts`,
  `PrismaTrackingResolver` in `apps/tracker`) to establish identity and
  organization ownership — but, per the Phase 3 architecture, does **not**
  use `destinationId` to pick where to redirect.

### The transparent redirect parameter (Phase 3)

`apps/tracker`'s `GET /:slug?redirection_url=<url>` redirects to the
**request's own `redirection_url` value** — validated by
`validateTransparentRedirectUrl` (`packages/shared/src/transparent-redirect.ts`:
http(s) only, no userinfo, no control characters, bounded length) — not to
`TrackingLink.destinationId`'s stored `Destination`. This is a deliberate
architectural choice for Google Transparent Click Tracker compliance
(the destination must be visible in the URL, not hidden behind a backend
ID) — see `docs/compliance/google-transparent-tracker.md` for the full
rationale and its accepted tradeoffs. A request classified as a bot is
redirected to `Campaign.safePageUrl` instead, or gets a controlled `404`
if none is configured — never a silently-substituted destination.

Splitting Destination from TrackingLink from Click matters for analytics:
a Destination can be reused across many links; a TrackingLink can accrue
many Clicks over time; and neither should have to change shape just
because the other does.

## Click, Conversion, BotEvent — event data

These three models were designed in Phase 1 so Phase 3 (Transparent Click
Tracker), Phase 4 (Click Analytics), Phase 5 (Bot Detection Integration),
and Phase 7 (Conversion Tracking) could be built against a stable schema.
Phase 3 now writes `Click` and `BotEvent` rows on every resolved tracker
request (`apps/tracker/src/modules/tracker/tracker.service.ts`);
`Conversion` remains schema-only — no postback ingestion exists yet
(Phase 7).

Privacy-by-design notes on `Click`:

- No raw IP address is stored — only `ipHash`, a one-way, salted hash
  computed by `packages/shared/src/ip-hash.ts` (salted with
  `CLICK_IP_HASH_SALT`, falling back to `AUTH_SECRET` if unset). This
  satisfies the "privacy-aware network identifier" requirement without
  ever persisting a directly-identifying value.
- `userAgent` and `referrer` are stored as-is because they're necessary
  for both analytics and bot detection, but are not linked to any other
  PII in this schema.
- `botClassification` / `botScore` on `Click` are a **denormalized
  snapshot** of the latest related `BotEvent`, kept for fast filtering in
  analytics queries (Phase 4 — `docs/architecture/click-analytics.md`).
  `BotEvent` remains the source of truth and can hold multiple historical
  classifications per click (e.g. if re-scored).
- `deviceType`/`browser`/`browserVersion`/`os`/`osVersion` are populated
  by `UserAgentParser` (Phase 4 — `packages/shared/src/user-agent.ts`,
  implemented by `UaParserUserAgentParser` in `apps/tracker`), written
  synchronously in the same transaction as the `Click` row, except that
  `deviceType` is forced to `BOT` when the click's `botClassification` is
  `BOT`, overriding whatever the UA parser derived. `country`/`region`/
  `city`/`timezone` are populated by the pluggable `GeoLocationProvider`
  (`packages/shared/src/geo-location.ts`) — `null` at write time and,
  unless an operator configures a real provider, permanently (the wired-in
  `NullGeoLocationProvider` performs no lookup at all). When a real
  provider is configured, its lookup runs **in the background, after** the
  `Click` row is written, and applies its result via a follow-up `UPDATE`
  if/when it resolves — so a `Click` row's geo fields are eventually
  consistent, not guaranteed populated at write time, even with a working
  provider. A failure or delay in either enrichment step degrades to
  "unknown"/`null` (UA) or simply leaves the fields `null` for longer (geo)
  rather than blocking the `Click` write — see
  `docs/architecture/click-analytics.md#data-enrichment-strategy-keeping-the-redirect-hot-path-safe`.
  `timezone` here is the click's *inferred location's* IANA zone from geo
  lookup — distinct from the analytics API's `timezone` query parameter
  used for time-bucketing.

`BotEvent.detectionSource` and `reasonCodes` are written by whichever bot
detection engine is wired in. Phase 3 wires in
`HeuristicBotDetectionEngine` (`apps/tracker/src/modules/bot-detection/`)
— an explicitly provisional user-agent heuristic (`detectionSource:
"tracker-heuristic-placeholder"`), not the product's existing/planned
bot-detection capability Phase 5 is expected to wire in through the same
`BotDetectionEngine` interface (`packages/shared/src/bot-detection.ts`).

`Conversion` has optional `clickId`/`trackingLinkId` (not required) because
a real-world conversion pipeline needs to handle conversions that arrive
without a cleanly matched click (e.g. view-through, delayed postbacks) —
Phase 7 will build the actual ingestion; Phase 1 only ensures the schema
doesn't have to change shape to support that later. Both are indexed
(`conversions_trackingLinkId_idx`, `conversions_clickId_idx`) since "did
this click convert" / "conversions for this link" are core attribution
lookups — Postgres doesn't auto-index foreign key columns, and Phase 1
CTO review found these two missing.

### Flagged for the phase that scales this up (not fixed now)

Reviewed for what could become a problem at real click volume — none of
this blocks Phase 3 or Phase 4 (Click Analytics still reads/writes this
same unpartitioned table, just with two added indexes — see
`docs/architecture/click-analytics.md#performance-strategy`), since click
volume in any near-term deployment is far below where these start to
matter, but it should inform a future high-volume-ingestion redesign
rather than being rediscovered under load:

- **Primary key strategy.** `Click.id` is explicitly generated as a
  `crypto.randomUUID()` (UUIDv4) by `apps/tracker`, not the model's
  `cuid()` default — the click-ID security requirement ("cryptographically
  safe / collision resistant... not predictable/sequential") took priority
  over insert-locality. `BotEvent` still uses its `cuid()` default. Both
  are effectively random-order keys from the index's perspective at
  sustained high-volume insert rates, a purely time-ordered key (e.g.
  UUIDv7/ULID prefixed, or a separate `bigint` identity column with the
  random UUID as a secondary unique column) indexes and partitions more
  efficiently. Worth an explicit decision if/when a future phase designs
  real high-volume ingestion — not a problem at today's expected volume.
- **No table partitioning.** A single unpartitioned `clicks` table will
  eventually need time-based partitioning (e.g. monthly) for both write
  throughput and the ability to cheaply drop/archive old data. Standard
  practice at scale, deliberately not built ahead of real volume.
- **Other foreign keys without an index**, lower priority than the two
  fixed above because they sit on control-plane tables bounded by org
  size, not click volume: `Campaign.trackingDomainId`,
  `Campaign.destinationId`, `TrackingLink.destinationId`,
  `ReferralConfiguration.campaignId`. Add if a specific query pattern
  needs them.

## Referral configuration & proof — the approval-gated model

This is the one piece of Phase 1 with real, enforced business logic (not
just a foundation schema):

- `ReferralConfiguration.type` is one of `NORMAL`, `HIDE`, or
  `CUSTOM_PARTNER_ATTRIBUTION`. This governs how AdstrackIO's **own**
  internal attribution pipeline records referral data for a campaign — it
  is explicitly not a mechanism for spoofing outbound HTTP `Referer`
  headers to third parties. See
  `docs/compliance/google-transparent-tracker.md`.
- Every configuration is created with `status = INACTIVE`, regardless of
  type.
- For `NORMAL` and `HIDE`, there's no additional gate — an org member can
  activate it once created.
- For `CUSTOM_PARTNER_ATTRIBUTION`, activation is blocked until at least
  one linked `ReferralProof` has `reviewStatus = APPROVED`. This is
  enforced in `apps/api/src/modules/referrals/referral-configurations.service.ts`
  (`activateReferralConfiguration`), not just in the dashboard UI, **and**
  backed by a Postgres trigger
  (`enforce_referral_configuration_activation`, migration
  `20260901204759_enforce_referral_activation_gate`) that rejects the same
  transition even for a write that bypasses the API entirely — see
  `docs/architecture/security.md` for why both layers exist, and
  `apps/api/test/referral-workflow.test.ts` for the tests that pin this
  behavior down (including: rejected proof still blocks activation; a
  second, approved proof unblocks it; a raw SQL `UPDATE` is rejected by the
  trigger until an approved proof exists).
- `ReferralProof` carries `documentReference` and/or `evidenceUrl`
  (external evidence), `submittedBy`, and a review trail (`reviewStatus`,
  `reviewedBy`, `reviewedAt`, `rejectionReason`). Review requires the
  `ADMIN` role or higher.

## Audit logging

`AuditLog` is intentionally schema-light: `action` is a free-text,
namespaced string (`"organization.created"`, `"referral_proof.approved"`,
etc.) rather than an enum, because the set of auditable actions will keep
growing across every future phase and an enum would need a migration for
every addition. `entityType`/`entityId` identify what changed;
`organizationId`/`actorUserId` identify the tenant/actor (both nullable —
some future system-initiated actions may have no human actor);
`metadata` is a JSON blob for action-specific context and **must never
contain secrets** (passwords, tokens, cookies) — this is enforced by
convention/code review today, and by the logger's redaction list
(`packages/logger`) for anything that also gets logged.
