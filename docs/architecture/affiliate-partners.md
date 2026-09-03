# Affiliate / Partner System (Phase 9)

## Status and scope

Phase 9 adds an **affiliate/partner** control plane on top of Phases 1-8:
organizations can register partners, assign them to campaigns, and get
deterministic clicks/conversions attribution back out. It is deliberately a
foundation, not a full affiliate network:

**Explicitly NOT part of Phase 9**: payouts, payment processing, commission
calculation, postback/webhook delivery to partners, a partner-facing
portal, multi-touch/multi-partner attribution, and click-level fraud
scoring specific to affiliate traffic (Phase 5's existing bot detection is
the only fraud signal in play). These are left for a later phase to build
on top of the attribution this phase establishes — see "Known limitations"
below.

```
Organization -> Campaign -> TrackingLink -> AffiliatePartner -> Click -> Conversion
```

## What existed before this phase (audit summary)

Before writing any Phase 9 code, the following were inspected directly:

- `packages/database/prisma/schema.prisma` — `Campaign`, `TrackingLink`,
  `Click`, `Conversion`, and their existing relations/indexes/triggers;
  the `enforce_conversion_click_attribution` and
  `enforce_routing_rule_campaign_organization` trigger patterns (Phase 7/8)
  used as the template for this phase's own triggers.
- `apps/tracker/src/modules/tracker/tracker.routes.ts` and
  `tracker.service.ts` — the transparent redirect handler and
  `recordClick`, to confirm where a Click row is actually written and what
  data is already available on that write path with zero extra queries.
- `packages/shared/src/tracking-resolver.ts` and
  `apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts` — the
  `TrackingResolutionResult` contract the tracker's hot path already
  depends on, and the single `findUnique` query that resolves a request's
  domain/link/campaign.
- `apps/api/src/modules/campaigns/campaigns.service.ts`,
  `tracking-links/tracking-links.service.ts`,
  `conversions/conversions.service.ts`,
  `routing-rules/routing-rules.service.ts` — the existing lifecycle
  state-machine pattern (`packages/shared/src/*-lifecycle.ts`), the
  `SELECT ... FOR UPDATE` concurrency pattern PR #8's review established,
  RBAC tiering, and organization-scoped-reference validation
  (`apps/api/src/modules/shared/org-scoped-refs.ts`).
- `ReferralConfiguration`/`ReferralProof` (Phase 1) — inspected and
  confirmed **unrelated**: that system controls how an internal
  `Referer`-header value is labeled/hidden for a campaign's own analytics
  (`NORMAL`/`HIDE`/`CUSTOM_PARTNER_ATTRIBUTION`), not a real business
  entity with a lifecycle, campaign roster, or click/conversion
  attribution. Phase 9 does not touch it, reuse it, or rename it.
- `apps/api/src/modules/audit-logs/audit-log.service.ts`,
  `apps/dashboard/src/app/campaigns/[id]/page.tsx` — the existing audit
  event and dashboard patterns this phase's own UI/audit events follow.

## Partner model

```prisma
enum AffiliatePartnerStatus { PENDING ACTIVE PAUSED ARCHIVED }

model AffiliatePartner {
  id             String
  organizationId String                 // set once from the URL path, never client body
  name           String
  externalId     String?
  email          String?
  status         AffiliatePartnerStatus @default(PENDING)
  metadata       Json?
  ...
  @@unique([organizationId, externalId])
  @@index([organizationId, status])
}
```

`organizationId` is taken only from the authenticated,
membership-checked URL path
(`/organizations/:organizationId/affiliate-partners/...`) — the same IDOR
boundary every other organization-scoped module in this codebase already
enforces; it is never read from the request body.
`createAffiliatePartnerSchema`/`updateAffiliatePartnerSchema`
(`packages/validation/src/affiliate-partners.ts`) simply don't define an
`organizationId`, `createdBy`, or `affiliatePartnerId` field, so a client
that sends one gets it silently stripped by Zod, not honored — verified by
an explicit mass-assignment test.

`externalId` is unique **per organization**, not globally
(`@@unique([organizationId, externalId])`), reusing the exact
`Conversion.externalConversionId` precedent (Phase 7): Postgres treats
`NULL` as distinct from every other `NULL` for uniqueness purposes, so any
number of partners with no `externalId` coexist freely, and the same
`externalId` string is free to reuse across two different organizations.

**No generic PATCH-for-status.** `updateAffiliatePartnerSchema` has no
`status` field at all — the same convention Campaign/TrackingLink/
Conversion/RoutingRule already established. Lifecycle only changes through
the explicit `POST .../activate`/`.../pause`/`.../archive` endpoints.

## Partner assignment: one join table, one attribution column

The brief's own diagram (`Campaign -> TrackingLink -> AffiliatePartner`)
and its API section (campaign-scoped assign/unassign endpoints) describe
two different concerns, which Phase 9 deliberately keeps as two different
mechanisms rather than one:

1. **Roster/authorization** — which partners are allowed to work with a
   campaign at all. This is the **one** join table Phase 9 adds:

   ```prisma
   model CampaignAffiliatePartner {
     id                 String
     organizationId     String
     campaignId         String
     affiliatePartnerId String
     ...
     @@unique([campaignId, affiliatePartnerId])
   }
   ```

   Exactly matches the campaign-scoped assign/unassign API
   (`POST/DELETE .../campaigns/:campaignId/affiliate-partners/:partnerId`).

2. **Attribution** — which *one* partner a given tracking link's clicks
   belong to. This is **not** a second join table
   (`TrackingLinkAffiliatePartner`) — it's a plain nullable foreign key:

   ```prisma
   model TrackingLink {
     ...
     affiliatePartnerId String?
     affiliatePartner   AffiliatePartner? @relation(...)
   }
   ```

   validated to reference a partner already on the link's own campaign's
   roster (`assertAffiliatePartnerAssignable`,
   `apps/api/src/modules/shared/org-scoped-refs.ts`, called from inside
   the same transaction as `tracking-links.service.ts`'s create/update
   writes — see "Concurrency" under Partner lifecycle below for why this
   must not run before that transaction starts).

This satisfies the letter of "do not blindly create both [join tables]"
(only `CampaignAffiliatePartner` exists) while still giving every
tracking link a single, deterministic attribution point — a link either
has no affiliate partner (`null`) or exactly one.

A partner from Organization A can never be assigned to Organization B's
campaign: `assignAffiliatePartnerToCampaign`
(`apps/api/src/modules/affiliate-partners/campaign-affiliate-partners.service.ts`)
looks the partner up scoped to the same `organizationId` the campaign
itself was already confirmed to belong to; if no such row exists, it 400s
before ever touching the join table. Backstopped at the database level by
`enforce_campaign_affiliate_partner_organization` (see "Database
enforcement" below).

## Click attribution

`Click.affiliatePartnerId` is a **denormalized snapshot**, copied from the
resolving `TrackingLink.affiliatePartnerId` at the moment
`apps/tracker`'s `recordClick` writes the row — never accepted from
request input:

```
TrackingResolver.resolve() -> TrackingResolutionResult.affiliatePartnerId
                             -> tracker.routes.ts (resolution.affiliatePartnerId)
                             -> recordClick(..., affiliatePartnerId)
                             -> Click.affiliatePartnerId
```

`PrismaTrackingResolver` already fetches the `TrackingLink` row via a
single `findUnique` to resolve domain/link/campaign identity — Phase 9
adds `affiliatePartnerId` to that same query's selected columns, so
attribution is **free**: zero extra database queries on the tracker's
redirect hot path (see "Tracker performance" below). There is no field in
the tracker's request handling (query string, header, body) that can set
or override this value — the tracker route handler reads it only from
`resolution.affiliatePartnerId`, a field `TrackingResolutionResult` only
ever gets from the database-backed resolver.

## Conversion attribution

`Conversion` gains **no new column**. Per the brief's explicit
instruction, "which affiliate partner generated this conversion" is
answered by joining through the click every conversion already
references:

```
Conversion.clickId -> Click.affiliatePartnerId
```

`createConversionSchema` (`packages/validation/src/conversions.ts`) has no
`affiliatePartnerId` field — a client that includes one in a `POST
.../conversions` body has it silently stripped by Zod, same as the
mass-assignment protection on `AffiliatePartner` itself. There is no code
path anywhere that lets conversion creation set or influence a Click's
attribution; `Click` remains the single source of truth, exactly
preserving Phase 7's own "Click is the source of truth, Conversion derives
from it" design and its existing `enforce_conversion_click_attribution`
trigger (untouched by this phase).

`apps/api/src/modules/analytics/analytics.service.ts`'s
`getAffiliatePartnerPerformance` is the concrete implementation of this
join — see "Analytics" below.

## Partner lifecycle

```
PENDING -> ACTIVE -> PAUSED -> ACTIVE -> ARCHIVED
PENDING -> ARCHIVED
PAUSED  -> ARCHIVED
```

`packages/shared/src/affiliate-partner-lifecycle.ts` is a direct structural
mirror of `campaign-lifecycle.ts`: an explicit transition table,
`assertValidAffiliatePartnerStatusTransition`/
`InvalidAffiliatePartnerStatusTransitionError`, and
`CREATABLE_AFFILIATE_PARTNER_STATUSES = ["PENDING", "ACTIVE"]` (a partner
can be created directly as `ACTIVE`, skipping `PENDING`, but never created
already `PAUSED`/`ARCHIVED`). `ARCHIVED` is terminal — no transition leads
out of it.

**Archived partners cannot receive new assignments — at either level.**
`assignAffiliatePartnerToCampaign` (campaign roster) and
`assertAffiliatePartnerAssignable` (tracking-link attribution, called from
inside `createTrackingLink`/`updateTrackingLink`'s own transaction — see
"Partner assignment" above) both lock the partner row
(`SELECT ... FOR UPDATE`) and 409 if its status is `ARCHIVED` before
writing. The tracking-link path was the subject of a CTO review finding on
PR #10: it originally validated the partner against the top-level
`PrismaClient` *before* the transaction that wrote the `TrackingLink` row
— a check-then-act race under which a concurrent `archiveAffiliatePartner`
could commit between the check and the write (and the check didn't verify
`ARCHIVED` status at all, so even the non-concurrent case could slip
through). Fixed by moving the check inside the same transaction and
locking the same `AffiliatePartner` row the other two lock sites already
lock — see "Concurrency" immediately below.

**Historical attribution survives archival.** Archiving a partner never
touches `CampaignAffiliatePartner` rows or any `Click`/`TrackingLink` that
already reference it — there is no cascade, cleanup job, or nulling-out of
historical foreign keys. A `Click` written while a partner was `ACTIVE`
keeps that `affiliatePartnerId` forever (also enforced immutable at the
database level — see below); `GET .../affiliate-partners/:partnerId`
continues to return the partner (now `status: "ARCHIVED"`) exactly as
before. Verified by a dedicated integration test that archives a partner
with an existing assignment and click, then re-reads all three.

**Concurrency.** `transitionAffiliatePartnerStatus`
(`apps/api/src/modules/affiliate-partners/affiliate-partners.service.ts`)
uses the same `SELECT ... FOR UPDATE` row-lock pattern PR #8's review
established for `Conversion`/`RoutingRule` — applied here proactively,
not rediscovered as a bug: a conditional-`updateMany` guarded on "the
status I read a moment ago" cannot prove idempotency for two concurrent
calls that both want the *same* target status (e.g. activate+activate on
a `PENDING` partner) — exactly one would win the `updateMany` and the
other would incorrectly `409`, even though both callers asked for exactly
the state the row ends up in. Locking the row and re-reading its status
*after* the lock is held means the loser of the race observes the
winner's already-committed result before deciding, so "already at target"
is always idempotent success. The same lock also serializes a concurrent
`archiveAffiliatePartner` against a concurrent
`assignAffiliatePartnerToCampaign` call on the *same* partner (the
"archive + assignment" race) — `assignAffiliatePartnerToCampaign` takes
its own `SELECT ... FOR UPDATE` on the partner row before deciding whether
the assignment is allowed, so whichever transaction commits first is
authoritative and the other observes its result, never a stale read.

**A third lock site closes the same race for tracking-link attribution.**
`assertAffiliatePartnerAssignable` (`org-scoped-refs.ts`) takes the
identical `SELECT ... FOR UPDATE` lock on the same `AffiliatePartner` row,
called from inside `createTrackingLink`/`updateTrackingLink`'s own
transaction before the `TrackingLink` write. All three lock sites —
partner lifecycle transitions, campaign-roster assignment, and
tracking-link attribution — target the same row, so Postgres serializes
any two of them that race on the same partner: whichever transaction's
lock is granted first runs to completion before the other's `SELECT ...
FOR UPDATE` can even return, so the loser always observes the winner's
already-committed status, never a stale read from before the lock was
acquired. There is no interleaving under which a concurrent archive and a
concurrent tracking-link attribution can both believe the partner is
`ACTIVE`.

Covered by dedicated concurrent activate+activate, pause+pause,
activate+pause, duplicate-assignment, archive+assignment, and (the fix
above) archive-vs-tracking-link-attribution (both create and update, plus
a fully deterministic sequential proof) integration tests
(`apps/api/test/affiliate-partners.test.ts`).

**Duplicate assignment is idempotent, not a 409.** A second concurrent (or
sequential) "assign partner X to campaign Y" call, when X is already
assigned to Y, returns the existing row rather than erroring — the
semantic intent of the caller is "ensure this fact is true," and this
generalizes the same same-target-duplicate-is-success lesson PR #8's
review established for status transitions to a structurally similar
problem (a duplicate resource-creation request).

## RBAC

Mirrors `Campaign`'s own established asymmetry — no new role system:

- **VIEWER** — read partners, read assignments (`GET` routes).
- **MEMBER** — create/update partners, assign/unassign to a campaign.
- **ADMIN** — activate/pause/archive (the same "bigger blast radius needs
  a higher bar" reasoning `campaigns.routes.ts` already documents for its
  own activate/pause/archive endpoints).
- **OWNER** — unrestricted, as it already is everywhere else in this
  codebase.

## API surface

```
GET    /organizations/:organizationId/affiliate-partners
POST   /organizations/:organizationId/affiliate-partners
GET    /organizations/:organizationId/affiliate-partners/:partnerId
PATCH  /organizations/:organizationId/affiliate-partners/:partnerId
POST   /organizations/:organizationId/affiliate-partners/:partnerId/activate
POST   /organizations/:organizationId/affiliate-partners/:partnerId/pause
POST   /organizations/:organizationId/affiliate-partners/:partnerId/archive

GET    /organizations/:organizationId/campaigns/:campaignId/affiliate-partners
POST   /organizations/:organizationId/campaigns/:campaignId/affiliate-partners/:partnerId
DELETE /organizations/:organizationId/campaigns/:campaignId/affiliate-partners/:partnerId
```

The assign/unassign endpoints carry no request body — the campaign and
partner are both fully identified by the URL path, and assignment carries
no configuration of its own, so there is nothing for a client to forge.

## Organization isolation / IDOR

Every entry point re-derives ownership from the authenticated URL path,
never trusts a client-asserted ID, and 404s (never leaks existence) on a
mismatch — the same uniform convention every other nested resource in this
codebase (tracking-links, conversions, routing rules) uses:

- Reading a partner requires it to belong to the URL's `organizationId`
  (`getAffiliatePartner`).
- Assigning requires the campaign to belong to the URL's `organizationId`
  (`getCampaign`, checked first) **and** the partner to belong to the same
  `organizationId` (checked via the locked `SELECT ... FOR UPDATE` query) —
  either mismatch is rejected before a roster row is ever created.
- A member of one organization gets `403` (not a leaked `404`) attempting
  to hit another organization's affiliate-partner routes at all —
  `requireOrganizationMember` runs before any service code.

Explicitly tested (`apps/api/test/affiliate-partners.test.ts`):
Org A reading Org B's partner via Org A's own URL fails (`404`); assigning
Org B's partner to Org A's campaign fails (`400`); assigning Org A's
partner to Org B's campaign fails (`404`, since the campaign lookup itself
fails first); a member of Org A hitting any Org B affiliate-partner route
fails (`403`).

## Database enforcement

Three triggers, added in migration `20260902190000_affiliate_partner_system`,
each chosen with a different cost/benefit trade-off appropriate to where
in the request path they run:

- **`enforce_campaign_affiliate_partner_organization`** — on
  `CampaignAffiliatePartner` insert, derives the campaign's actual
  `organizationId`, verifies the referenced partner's `organizationId`
  matches, and raises `23514` on mismatch; forbids changing
  `campaignId`/`affiliatePartnerId`/`organizationId` on any row afterward
  (assignments are create/delete, never mutated in place). Runs on the
  admin CRUD path (assigning a partner to a campaign), not the tracker hot
  path, so a cross-table check here is cheap relative to the operation.
- **`enforce_tracking_link_affiliate_partner`** — on
  `TrackingLink` insert/update of `affiliatePartnerId`/`campaignId` when
  `affiliatePartnerId IS NOT NULL`: verifies the partner exists, belongs to
  the same organization as the campaign, **and** is actually on that
  campaign's roster (`EXISTS (SELECT 1 FROM campaign_affiliate_partners
  WHERE ...)`). Also runs on the admin CRUD path (creating/updating a
  tracking link), never on the tracker's redirect hot path, so the
  cross-table `EXISTS` lookup is an acceptable, deliberate cost here.
- **`enforce_click_affiliate_partner_immutable`** — a deliberately
  minimal `BEFORE UPDATE OF "affiliatePartnerId"` trigger with **no
  cross-table lookup and no insert-time check at all**: it only rejects an
  `UPDATE` that changes the column, and only fires on `UPDATE` statements
  (never `INSERT`), so it adds zero overhead to the tracker's
  click-insert-heavy hot path. This is a deliberate trade-off, not an
  oversight — see "Tracker performance" below for why an insert-time
  cross-table check (the pattern `enforce_conversion_click_attribution`
  uses for `Conversion`) was rejected specifically for `Click`.

All three were verified directly against real Postgres (`BEGIN`/`ROLLBACK`
transaction blocks via `psql`) before any service code was written on top
of them, following the same practice Phase 7/8 established: a
cross-organization assignment insert, a duplicate assignment, an
assignment-column mutation attempt, a non-roster tracking-link
attribution (both the cross-org case and the same-org-but-unassigned
case), and a `Click.affiliatePartnerId` update were each confirmed
rejected with the expected error. Two of the three
(`enforce_campaign_affiliate_partner_organization`,
`enforce_click_affiliate_partner_immutable`) are additionally exercised by
dedicated integration tests that bypass the service layer entirely (a raw
`prisma.campaignAffiliatePartner.create`/`prisma.click.update` call) to
prove the database boundary holds independently of application code.

## Tracker performance

Phase 9 adds **zero** synchronous database or network calls to the
tracker's redirect path. `Click.affiliatePartnerId` is populated from data
`PrismaTrackingResolver` already fetches via its existing single
`findUnique` query — no new query, no new round trip.

A deliberate choice was made **not** to add an insert-time cross-table
verification trigger for `Click.affiliatePartnerId` (unlike
`Conversion`'s `enforce_conversion_click_attribution`, which does perform
such a check): `Click` writes are the tracker's literal hot path, and the
brief explicitly directs "DO NOT introduce unnecessary synchronous DB/
network calls into the tracker redirect path." Instead, `Click` relies on
the same trust model already used for its other foreign-key columns
(`campaignId`, `trackingLinkId`, `organizationId`) — there is exactly one
code path that ever writes a `Click` row in this codebase
(`apps/tracker`'s `recordClick`), and it always derives
`affiliatePartnerId` from `TrackingResolver`'s already-resolved,
server-controlled result, never from client input. The only database-level
protection on `Click.affiliatePartnerId` is the cheap, lookup-free
immutability trigger described above.

## Bot policy and Phase 8 routing precedence — unchanged

Affiliate functionality does not add a fourth routing outcome, does not
introduce a rule field capable of naming a URL, and does not participate
in `resolveRoutingDecision` (`packages/shared/src/routing-rules.ts`) at
all. `BOT_CLASSIFICATION`/`COUNTRY`/`DEVICE_TYPE`/`BROWSER`/`OS`/
`REFERRER_HOST` conditions and `TARGET`/`SAFE_PAGE`/`BLOCK` actions behave
exactly as Phase 8 defined them; a `BOT` classification still always
routes to `SAFE_PAGE` regardless of any affiliate assignment on the
resolved tracking link — there is no code path where affiliate
attribution influences the routing decision at all, since attribution is
computed independently, after routing, purely for the `Click` row being
written.

## Transparent tracker safety — unchanged

`GET /:slug?redirection_url=<url>` behaves byte-for-byte as before this
phase: the visible `redirection_url` remains the only source of the
`TARGET` outcome's destination. There is no partner-specific hidden
destination, no partner-controlled redirect URL, and no field on
`AffiliatePartner`/`TrackingLink`/`CampaignAffiliatePartner` capable of
expressing a redirect target — affiliate attribution is purely a label
attached to the `Click` row after the (unchanged) routing decision is
made, never an input to it. Verified by a dedicated tracker test
("does not change the visible transparent redirect destination for an
affiliate-attributed link") alongside the full pre-existing transparent-
redirect regression suite, unmodified and still passing.

## Analytics

Reuses the existing analytics architecture
(`apps/api/src/modules/analytics/analytics.service.ts`) rather than
building a second one, per the brief's explicit instruction:

- `AnalyticsFilters` gained one optional field, `affiliatePartnerId`,
  applied by every existing click/conversion query
  (`buildWhere`/`buildConversionWhere`) exactly like `campaignId`/
  `trackingLinkId`/`trackingDomainId` already were — a caller can scope
  any existing endpoint (click summary, timeseries, by-campaign, etc.) to
  one partner's traffic with no new code path.
- `buildConversionWhere`'s new `affiliatePartnerId` condition is a
  subquery through `clicks` (`cv."clickId" IN (SELECT id FROM clicks
  WHERE "affiliatePartnerId" = ...)`) — the same style its existing
  `trackingDomainId` condition already uses — since `conversions` has no
  `affiliatePartnerId` column of its own (see "Conversion attribution"
  above).
- One new function, `getAffiliatePartnerPerformance`, is the minimum
  foundation the brief asked for (Partner / Clicks / Conversions /
  Conversion Rate): two parallel raw-SQL queries (clicks grouped by
  partner, conversions grouped by partner via the same click-join), joined
  in JS against the organization's partner list — the same two-parallel-
  queries-plus-JS-merge shape `getConversionSummary` already uses, applied
  per-partner instead of as one aggregate total.
- Exposed as `GET .../analytics/affiliate-partners/performance`, gated
  `VIEWER` like every other analytics endpoint.

## Dashboard

`/affiliate-partners` (`apps/dashboard/src/app/affiliate-partners/page.tsx`)
— a single page, not a full affiliate-network UI, per the brief's explicit
"do not overbuild" instruction:

- Partner list: name, external ID, email, status badge, inline edit,
  create form.
- Lifecycle action buttons (activate/pause/archive), gated the same way
  the API gates them (`canManage` for create/edit, `canRunLifecycle` for
  lifecycle actions).
- Campaign assignments: pick a campaign, see/manage its partner roster
  (assign from a dropdown of not-yet-assigned, non-archived partners;
  unassign with one click).
- A performance table (clicks, human clicks, conversions, approved
  conversions, conversion rate) sourced directly from
  `getAffiliatePartnerPerformance`.

Added to `apps/dashboard/src/components/app-shell.tsx`'s navigation
between "Tracking Links" and "Conversions."

## Tests

- `packages/shared/src/affiliate-partner-lifecycle.test.ts` (15 tests) —
  legal/illegal transitions, terminal `ARCHIVED`, creatable-status set.
- `packages/validation/src/affiliate-partners.test.ts` (15 tests) —
  schema validation including the explicit mass-assignment test
  (`organizationId`/`createdBy`/`affiliatePartnerId` in the request body
  are silently stripped, not honored).
- `apps/api/test/affiliate-partners.test.ts` (41 tests) — partner CRUD,
  externalId uniqueness (same-org rejected, cross-org allowed), RBAC
  (VIEWER/MEMBER/ADMIN/OWNER), organization isolation/IDOR (cross-org
  read, cross-org assign in both directions, cross-org route access),
  campaign assignment (valid, idempotent duplicate, cross-campaign 404,
  archived-partner-rejected), attribution (tracking-link roster
  enforcement, an explicit ACTIVE-partner success path via both create and
  update, click attribution via the tracker-simulating test helper,
  conversion attribution derived through click with forged-attribution
  attempt proven inert), historical attribution surviving archival,
  lifecycle/assignment/attribution concurrency (duplicate assignment race,
  activate+activate, pause+pause, activate+pause, archive+assignment race,
  and the archive-vs-tracking-link-attribution race fix — a deterministic
  sequential proof plus concurrent create and update races), and two
  direct-database trigger tests that bypass the service layer entirely.
- `apps/tracker/test/tracker.routes.test.ts` — 5 new tests: a click
  through an affiliate-attributed link carries that partner's id; a click
  through an ordinary link has `null`; a forged `affiliatePartnerId` query
  parameter has no effect; the visible transparent redirect destination is
  unchanged for an affiliate-attributed link; a BOT-classified request
  through an affiliate-attributed link still routes to `SAFE_PAGE` (never
  `TARGET`) while attribution still happens. The full pre-existing
  transparent-redirect, bot-routing, and Phase 8 routing-rule regression
  suites in the same file were re-run unmodified and still pass.
- `apps/tracker/test/fixtures.ts` gained an opt-in
  `withAffiliatePartner` fixture option (creates a partner, assigns it to
  the fixture's campaign roster, attributes the fixture's tracking link to
  it) — additive, every existing call site is unaffected.

## Known limitations

- **Payouts, payment processing, and commission calculation are not part
  of this phase** — `AffiliatePartner` has no rate, currency, or payout
  schedule field. A future phase would add these without needing to
  change the attribution model this phase establishes.
- **No postback/webhook delivery to partners** — Phase 7's own "postbacks/
  webhooks are Phase 11" boundary is unchanged; this phase does not add a
  partner-facing notification mechanism.
- **No partner-facing portal or authentication** — every endpoint in this
  phase is an organization-member-only control-plane surface; a partner
  cannot log in and see their own performance.
- **`getAffiliatePartnerPerformance` is bounded to
  `BREAKDOWN_ROW_LIMIT` (100) partners** per call, the same safety-valve
  convention every other analytics breakdown function already uses — not
  a pagination mechanism.
- **Conversion-to-partner attribution is a join, computed at query time,
  not a stored/cached value** — consistent with the brief's explicit
  instruction not to duplicate partner data onto `Conversion`, but means
  `getAffiliatePartnerPerformance` costs a join rather than a single
  indexed column read. Acceptable at today's expected volume; worth
  revisiting only if conversion-analytics query performance becomes a
  measured problem.
