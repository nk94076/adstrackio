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
| `Campaign` | Groups tracking links under a name/status/budget; also carries the Safe Page URL and bot-traffic policy | IMPLEMENTED (CRUD + Phase 6 status lifecycle). `safePageUrl` (Phase 3) + `suspiciousTrafficPolicy`/`unknownTrafficPolicy` (Phase 5) are a minimal, explicit bot-routing policy, not a general routing-rules engine (FUTURE PHASE: Rules & Routing Engine) |
| `TrackingLink` | A routable slug on a domain | IMPLEMENTED (Phase 3, status lifecycle Phase 6) — `apps/tracker`'s `GET /:slug` resolves and redirects through this |
| `Click` | An individual inbound tracking event | IMPLEMENTED (Phase 3, enriched Phase 4) — written by the tracker on every resolved request; Phase 4 added real browser/OS enrichment and an optional geo-location provider (see `docs/architecture/click-analytics.md`) |
| `Conversion` | A reported conversion event, attributed through a `Click` | IMPLEMENTED (Phase 7) — always click-attributed (campaign/tracking-link IDs derived server-side, database-trigger-enforced), deduplicated via an optional unique `externalConversionId`, own status lifecycle (see `docs/architecture/conversion-tracking.md`) |
| `BotEvent` | A bot-detection verdict for a click | IMPLEMENTED (Phase 3, integrated into routing Phase 5) — written by the tracker via the explicitly-provisional, multi-signal `HeuristicBotDetectionEngine`; not a production-grade or ML-based detector (see `docs/architecture/bot-detection.md`) |
| `ReferralConfiguration` | How referral/attribution is labeled for a campaign | IMPLEMENTED, including the approval gate (app + database level) |
| `ReferralProof` | Evidence supporting a custom partner attribution config | IMPLEMENTED |
| `RoutingRule` | A campaign-scoped, priority-ordered TARGET/SAFE_PAGE/BLOCK rule | IMPLEMENTED (Phase 8) — composes rather than duplicates Phase 5's bot-traffic policy (see `docs/architecture/rules-routing.md`) |
| `AffiliatePartner` | A real business entity an organization tracks affiliate traffic for | IMPLEMENTED (Phase 9) — explicit PENDING/ACTIVE/PAUSED/ARCHIVED lifecycle (see `docs/architecture/affiliate-partners.md`) |
| `CampaignAffiliatePartner` | Join table: which partners may work with a campaign | IMPLEMENTED (Phase 9) |
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
  `TrackingDomain` and `Destination`, and carries `safePageUrl` (Phase 3)
  — the server-configured destination for traffic the tracker classifies
  as `BOT` — plus `suspiciousTrafficPolicy`/`unknownTrafficPolicy` (Phase
  5, Prisma enum `BotTrafficPolicyAction`: `SAFE_PAGE`/`TARGET`/`BLOCK`,
  both defaulting to `TARGET`) governing where `SUSPICIOUS`/`UNKNOWN`
  traffic goes — see `docs/architecture/bot-detection.md`. `status`
  (`CampaignStatus`: `DRAFT`/`ACTIVE`/`PAUSED`/`ARCHIVED`) now follows an
  explicit lifecycle enforced by the service layer (Phase 6 — see
  `docs/architecture/campaign-manager.md`), but — deliberately, a Phase 6
  boundary rather than an oversight — it still does not itself gate
  traffic at the tracker: only `TrackingDomain` verification/activation
  and `TrackingLink.status` do. Assigning a `trackingDomainId` (create or
  update) now requires that domain to be `VERIFIED` and active, and it can
  no longer be changed at all while the campaign is `ACTIVE` (pause first)
  — closing a gap where Phase 1-5 let a campaign point at a domain that
  could never actually serve its traffic.
- **TrackingLink** — the actual routable unit: `(trackingDomainId, slug)`
  is unique **per domain**, not per campaign — two links in different
  campaigns, or the same campaign, may reuse a slug as long as they're on
  different tracking domains. `apps/tracker`'s `GET /:slug` route resolves
  a request's hostname+slug to this row via `TrackingResolver`
  (`packages/shared/src/tracking-resolver.ts`,
  `PrismaTrackingResolver` in `apps/tracker`) to establish identity and
  organization ownership — but, per the Phase 3 architecture, does **not**
  use `destinationId` to pick where to redirect. `status`
  (`TrackingLinkStatus`: `ACTIVE`/`PAUSED`/`ARCHIVED`) follows the same
  kind of explicit, service-enforced lifecycle as `Campaign.status` (Phase
  6); creating or reactivating a link also requires its
  `trackingDomainId` to be `VERIFIED`+active, and requires its campaign to
  not be `ARCHIVED`.

### The transparent redirect parameter (Phase 3)

`apps/tracker`'s `GET /:slug?redirection_url=<url>` redirects to the
**request's own `redirection_url` value** — validated by
`validateTransparentRedirectUrl` (`packages/shared/src/transparent-redirect.ts`:
http(s) only, no userinfo, no control characters, bounded length) — not to
`TrackingLink.destinationId`'s stored `Destination`. This is a deliberate
architectural choice for Google Transparent Click Tracker compliance
(the destination must be visible in the URL, not hidden behind a backend
ID) — see `docs/compliance/google-transparent-tracker.md` for the full
rationale and its accepted tradeoffs. A request classified `BOT` is
redirected to `Campaign.safePageUrl` instead, or gets a controlled `404`
if none is configured — never a silently-substituted destination.
`SUSPICIOUS`/`UNKNOWN` requests (Phase 5) follow the campaign's own
configured policy instead of a hardcoded rule — see
`docs/architecture/bot-detection.md`.

Splitting Destination from TrackingLink from Click matters for analytics:
a Destination can be reused across many links; a TrackingLink can accrue
many Clicks over time; and neither should have to change shape just
because the other does.

## Click, Conversion, BotEvent — event data

These three models were designed in Phase 1 so Phase 3 (Transparent Click
Tracker), Phase 4 (Click Analytics), Phase 5 (Bot Detection Integration),
and Phase 7 (Conversion Tracking) could be built against a stable schema
— none of them required a schema change to `Click`/`BotEvent` beyond what
Phase 3/4 already added. Phase 3 writes `Click` and `BotEvent` rows on
every resolved tracker request
(`apps/tracker/src/modules/tracker/tracker.service.ts`); Phase 5 made the
classification those rows carry actually gate the routing decision
(see `docs/architecture/bot-detection.md`) without changing how they're
written. Phase 7 built `Conversion`'s actual ingestion — see below and
`docs/architecture/conversion-tracking.md`.

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
detection engine is wired in. `HeuristicBotDetectionEngine`
(`apps/tracker/src/modules/bot-detection/`) is wired in by default — a
multi-signal but explicitly provisional heuristic (`detectionSource:
"tracker-heuristic-placeholder"`; a safe-fallback wrapper produces
`detectionSource: "tracker-fallback"` if the engine itself fails or times
out), not a production-grade or ML-based detector. Phase 5 (Bot Detection
Integration) made the classification these fields carry actually drive
the tracker's routing decision for all four `BotClassification` values,
not just `BOT` — see `docs/architecture/bot-detection.md`. Both fields
remain internal: neither is exposed through the analytics API
(`docs/architecture/click-analytics.md`).

**Revised in Phase 7:** Phase 1 originally left `Conversion.clickId`/
`trackingLinkId` optional, anticipating a future pipeline that might need
to handle conversions arriving without a cleanly matched click (e.g.
view-through attribution, delayed postbacks with no click reference at
all). Phase 7's actual brief took the opposite, stricter position: "the
conversion must NEVER be allowed to invent or override its campaign,
tracking link, organization, or click relationship" — which only has an
enforceable answer if a click is mandatory. A `clickId`-less "conversion"
would have nothing to derive `campaignId`/`trackingLinkId` from except
direct client assertion, exactly the spoofing surface this phase exists to
close. `clickId` and `trackingLinkId` are therefore both `NOT NULL` as of
Phase 7 (migration `20260902155750_conversion_tracking_foundation`);
`campaignId` was already required. View-through/click-less attribution, if
ever built, is a deliberately different, harder problem (proving a
conversion happened *without* the identifying signal a click provides) —
left to a future phase rather than solved by quietly allowing every
conversion to skip attribution.

`campaignId`/`trackingLinkId`/`organizationId` are still stored as direct
columns on `Conversion` (not read via a join to `Click` on every query) —
denormalized for query performance, exactly as `Click.botClassification`/
`botScore` denormalize the latest `BotEvent`. Unlike that pair, though,
this phase's brief demanded these three "can NEVER disagree with Click,"
so a database trigger (`enforce_conversion_click_attribution`) derives
them from the referenced click at insert time and forbids changing any of
the four (`clickId` included) afterward — see
`docs/architecture/conversion-tracking.md#click-attribution` for the full
design, including why this is enforced at both the service layer and the
database.

Indexes were redesigned around the query patterns Phase 7's analytics
actually needs: `(campaignId, occurredAt)` and `(trackingLinkId,
occurredAt)` (composite, replacing Phase 1's bare `campaignId`/
`trackingLinkId` indexes — every real query filters by both dimensions
together), `(status, occurredAt)` (new), and a unique
`(organizationId, externalConversionId)` for deduplication (see
`docs/architecture/conversion-tracking.md#deduplication`). `clickId` keeps
its original bare index — point lookups by click, not a ranged scan.

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

## Routing rules — campaign-scoped, priority-ordered (Phase 8)

`RoutingRule` is scoped to exactly one campaign (`campaignId`, `NOT NULL`,
`onDelete: Cascade`) — there is no organization-wide rule. `priority` is a
plain positive integer made **unique per campaign** by a real database
constraint (`@@unique([campaignId, priority])`), not application-level
tie-breaking: two rules on the same campaign can never share a priority,
so evaluation order (ascending priority) is never ambiguous.

`conditions` is a `Json` column holding a bounded array (max 10) of
`{ field, operator, value }` objects — validated and bounded at write time
by `packages/validation/src/routing-rules.ts`, evaluated by the pure
`evaluateRules` function in `packages/shared/src/routing-rules.ts`. This
is deliberately a small closed schema, not an arbitrary expression
language: `field` is one of six enum values, `operator` is one of four,
and there is no way to encode anything that would need to be `eval`'d.

`action` reuses the same three-value `RoutingRuleAction` type Phase 5's
`BotTrafficPolicyAction` already established (`TARGET`/`SAFE_PAGE`/
`BLOCK`) — a rule cannot name an arbitrary redirect URL of its own; see
`docs/architecture/rules-routing.md` for the full design and why this
matters for the Google Transparent Click Tracker architecture.

`organizationId`/`campaignId` are set once by the service layer from the
authenticated URL path (never client-body-supplied) and never updated
afterward. `enforce_routing_rule_campaign_organization` (migration
`20260902170000_rules_routing_engine`) enforces both facts at the
database level as a backstop, mirroring the pattern
`enforce_conversion_click_attribution` established in Phase 7 — verified
directly against Postgres before any Phase 8 API code was built on top of
it.

Indexes: `@@index([campaignId, status, priority])` (the exact shape the
tracker's own rule-fetch query needs — filter by campaign + `ACTIVE`
status, sorted by priority) and `@@index([organizationId])` (dashboard/API
listing and IDOR-check queries).

## Affiliate partners and attribution (Phase 9)

`AffiliatePartner` follows the same shape as every other organization-owned
entity in this schema: `organizationId` (`NOT NULL`, `onDelete: Cascade`),
a closed `AffiliatePartnerStatus` enum (`PENDING`/`ACTIVE`/`PAUSED`/
`ARCHIVED`, default `PENDING`) following the same explicit,
service-enforced lifecycle pattern as `Campaign.status`/
`TrackingLink.status`, and `@@unique([organizationId, externalId])` —
reusing `Conversion.externalConversionId`'s exact NULL-is-distinct
uniqueness precedent so `externalId` is unique per organization, not
globally, and any number of partners may omit it entirely.

Assignment is deliberately split into two different mechanisms rather than
one, full rationale in `docs/architecture/affiliate-partners.md`:

- **`CampaignAffiliatePartner`** — the one join table this phase adds,
  `@@unique([campaignId, affiliatePartnerId])`, expressing "this partner
  may work with this campaign." `organizationId` is stored directly
  (denormalized, like `Conversion`'s own campaign/tracking-link columns)
  and re-derived/verified by `enforce_campaign_affiliate_partner_organization`
  at insert time, mirroring `enforce_conversion_click_attribution`'s
  pattern (Phase 7).
- **`TrackingLink.affiliatePartnerId`** — a plain nullable foreign key,
  not a second join table, giving each tracking link exactly one
  deterministic attributed partner (or none). Validated at write time to
  reference a partner already on the link's own campaign's
  `CampaignAffiliatePartner` roster, backstopped by
  `enforce_tracking_link_affiliate_partner`.
- **`Click.affiliatePartnerId`** — a denormalized snapshot copied from the
  resolving `TrackingLink.affiliatePartnerId` by `apps/tracker`'s
  `recordClick`, at zero extra query cost (`PrismaTrackingResolver`
  already fetches the `TrackingLink` row). Immutable after creation
  (`enforce_click_affiliate_partner_immutable`) — deliberately a
  lookup-free, `UPDATE`-only trigger, unlike the insert-time cross-table
  check `Conversion`/`CampaignAffiliatePartner`/`TrackingLink` each get,
  since `Click` writes sit on the tracker's redirect hot path where an
  extra synchronous cross-table check is not acceptable — see
  `docs/architecture/affiliate-partners.md#tracker-performance`.
  Indexed `@@index([affiliatePartnerId, occurredAt])`, matching the shape
  `getAffiliatePartnerPerformance`'s analytics query needs.

`Conversion` gains **no new column** for partner attribution — per Phase
9's explicit design instruction, "which partner generated this
conversion" is answered by joining through `Conversion.clickId ->
Click.affiliatePartnerId` at query time, not duplicating the value onto
`Conversion` itself. This keeps `Click` the single source of truth for
attribution, consistent with Phase 7's existing "Click is authoritative,
Conversion derives from it" design.

Archiving a partner touches no other table — no cascade, no nulling-out of
existing `CampaignAffiliatePartner`/`TrackingLink`/`Click` references — so
historical attribution is preserved by simply never being touched, not by
any special-cased "preserve on archive" logic.

## Attribution & Advanced Reporting (Phase 10) — no schema change

Phase 10 adds **no new model, no new column, no new migration**. Its
entire reporting layer (`docs/architecture/attribution-reporting.md`) is
PostgreSQL aggregation over columns Phase 3/4/7/9 already added to
`Click`/`Conversion`: `Click.country`/`deviceType`/`browser`/`os`/
`botClassification` (dimension breakdowns), `Click.ipHash`/`userAgent`
(the unchanged Phase 4 unique-visitor definition), and
`Conversion.status`/`value`/`campaignId`/`trackingLinkId`/`clickId`
(performance metrics and attribution). "First-click" attribution, as
Phase 10 documents it, is simply Phase 7's existing rule stated
precisely: a conversion is attributed to the one `Click` its `clickId`
names, and that click's own `campaignId`/`trackingLinkId`/
`affiliatePartnerId` are authoritative — nothing new to enforce here that
`enforce_conversion_click_attribution` (Phase 7) and
`enforce_click_affiliate_partner_immutable` (Phase 9) don't already
guarantee at the database level.

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
