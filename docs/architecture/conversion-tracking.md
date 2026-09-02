# Conversion Tracking (Phase 7)

## Status and scope

Phase 7 lets an advertiser/partner report that a conversion happened and
attribute it — safely, never by client assertion — to the click that
produced it. It is a **reporting/event plane**, not a redirect mechanism:
it adds no new traffic-serving code path and does not touch
`apps/tracker`. No affiliate/partner payout system, no attribution engine
beyond "this conversion's click tells us its campaign/tracking link," and
no Rules & Routing Engine integration — all remain out of scope, unchanged
from Phase 1-6.

```
Tracking Link -> Click -> clickId -> Conversion -> Campaign/TrackingLink attribution -> analytics
```

## What existed before this phase (audit summary)

The `Conversion` model was Phase 1 foundation-only — no service, no route,
no test, ever created one. Its shape, audited before any Phase 7 code was
written:

- `campaignId` was required but `trackingLinkId`/`clickId` were both
  optional — the opposite of what a click-first design needs. Nothing
  stopped a conversion from being created with `campaignId` set directly
  and no `clickId` at all, which is exactly the "client asserts its own
  attribution" shape this phase exists to close off.
- `payoutAmount`/`payoutCurrency` (Decimal(12,2)/VarChar(3)) already
  established this codebase's monetary-value convention (via
  `Campaign.budgetAmount`/`budgetCurrency`) — reused here as `value`/
  `currency` rather than inventing a second representation. See
  "Monetary representation" below for why the names changed.
- No `externalConversionId` or any other idempotency key existed — nothing
  prevented a retried submission from creating a duplicate conversion.
- Indexes existed on `organizationId+occurredAt`, bare `campaignId`, bare
  `trackingLinkId`, and `clickId` — none combined a foreign key with
  `occurredAt`, which every analytics-style query in this phase needs.

Click's own design was already sound for this purpose and needed no
changes: `Click.id` is generated via `crypto.randomUUID()`
(`apps/tracker/src/modules/tracker/click-id.ts`), not the Prisma-default
`cuid()` most other IDs in this codebase use — already unguessable enough
to serve as the identifier a conversion is reported against. See "Click ID
format" below.

## Click attribution

A conversion always references a real `Click`; `campaignId`/
`trackingLinkId`/`organizationId` are read from that `Click` row, never
accepted as request fields at all:

```json
POST /api/v1/organizations/:organizationId/conversions
{
  "clickId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "eventName": "purchase",
  "value": 49.99,
  "currency": "USD",
  "externalConversionId": "order-8241",
  "occurredAt": "2026-09-02T10:15:00Z",
  "metadata": { "orderId": "8241" }
}
```

`createConversionSchema` (`packages/validation/src/conversions.ts`) has no
`campaignId`/`trackingLinkId`/`organizationId` fields — a request that
includes them has those keys silently stripped by Zod's default parsing,
the same non-strict behavior established for campaign/tracking-link PATCH
bodies in Phase 6. `createConversion`
(`apps/api/src/modules/conversions/conversions.service.ts`) does one
organization-scoped Click lookup (`clicks.findFirst({ where: { id, organizationId } })`)
and copies `campaignId`/`trackingLinkId` from that row. A `clickId`
belonging to another organization is indistinguishable from one that
doesn't exist — both `404` — the same uniform-not-found convention this
codebase already uses for campaign/tracking-domain lookups, so a caller
can never use this endpoint to confirm whether a given click ID is real
in someone else's organization.

### Enforced twice: service layer and database trigger

The service layer deriving attribution correctly is necessary but, on its
own, only as reliable as that one code path. `campaignId`/`trackingLinkId`/
`organizationId` are still persisted as real columns on `conversions`
(denormalized from `click` for query performance — every analytics query
in this phase filters/aggregates by them directly, without a join), and
the brief for this phase was explicit that they "can NEVER disagree with
Click." So migration `20260902155750_conversion_tracking_foundation` adds
`enforce_conversion_click_attribution`, a `BEFORE INSERT OR UPDATE`
trigger that:

- On insert, looks up the referenced click's own `organizationId`/
  `campaignId`/`trackingLinkId` and raises an exception (Postgres
  `23514`, check_violation) if the row being inserted doesn't match, or if
  `clickId` doesn't resolve to a real click at all.
- On update, raises an exception if `clickId`/`organizationId`/
  `campaignId`/`trackingLinkId` are changed at all — a conversion's
  attribution is immutable once created; there's no legitimate reason to
  repoint an existing conversion at a different click.

This mirrors the pattern `enforce_referral_configuration_activation`
established for the referral-activation gate (Phase 1): a service-layer
check for the normal path, plus a database-level backstop for anything
that bypasses it (a raw SQL statement, a future admin tool, a bug). It is
not a substitute for the service-layer check, which produces a clean `404`/
`409` instead of a raw database error.

### Click ID format

`clickIdSchema` (`packages/validation/src/conversions.ts`) validates
`clickId` as a UUID — `z.string().uuid()` — deliberately *not* the
`.cuid()` validator used for every other ID in this API. This matches
what `Click.id` actually is in production: `apps/tracker` always
explicitly generates it via `randomUUID()` before insert, never relying on
`Click.id`'s schema-level `@default(cuid())` fallback (kept only as a
defensive default for a hypothetical future insert path that doesn't set
it explicitly). Using the wrong validator here would either reject every
real clickId (too strict) or accept a format no real click actually has
(too loose) — this was caught by auditing `click-id.ts` before writing the
schema, not left implicit.

`clickId` is not, and must not become, an authorization credential:
knowing a click ID is not sufficient to create a conversion against it —
the caller must also be an authenticated, organization-scoped member (see
RBAC below). A click ID leaking (e.g. in a log, a URL) is a privacy
concern already addressed by Phase 3/4 (click IDs are never appended to
the outward, Google-facing redirect URL — see
`docs/compliance/google-transparent-tracker.md`), not a new authorization
boundary this phase introduces.

## Deduplication

If the caller supplies `externalConversionId`, it must be unique within
the organization — enforced by a real database unique constraint
(`conversions_organizationId_externalConversionId_key`, on
`(organizationId, externalConversionId)`), not a check-then-insert race.
`createConversion` attempts the insert directly and catches the specific
Postgres unique-violation (Prisma error code `P2002`), translating it to
`409 CONFLICT`. Two concurrent requests with the same
`externalConversionId` both reach the database; exactly one insert
succeeds and the other fails the constraint — there is no window where
both could succeed, unlike a "SELECT to check, then INSERT if absent"
approach. See `apps/api/test/conversion-tracking.test.ts` ("handles
concurrent duplicate submissions safely") for a test that actually fires
two requests concurrently via `Promise.all` and asserts exactly one
conversion exists afterward.

Postgres treats each `NULL` as distinct from every other value for
uniqueness purposes, so this constraint only applies to conversions that
actually supplied an `externalConversionId` — any number of conversions
with none coexist freely, and multiple conversions may reference the same
`clickId` (e.g. an "add to cart" event followed later by a "purchase" on
the same click) without restriction; there is no unique constraint on
`clickId` alone.

**If no `externalConversionId` is supplied, there is no deduplication at
all.** This is deliberate: inventing a uniqueness rule from
timestamp/value/eventName would be fragile (two legitimately distinct
conversions could easily collide, or a genuine retry could easily differ
by a few milliseconds and evade it). Callers that need reliable dedup
**must** supply their own idempotency key as `externalConversionId` — this
is the documented contract, not a gap to paper over with a weaker
heuristic.

## Status lifecycle

```
PENDING --approve--> APPROVED --reverse--> REVERSED (terminal)
   |
   +--reject--> REJECTED (terminal)
```

`packages/shared/src/conversion-lifecycle.ts`
(`assertValidConversionStatusTransition`) — same pure/synchronous
single-source-of-truth pattern as Phase 6's `campaign-lifecycle.ts` /
`tracking-link-lifecycle.ts`. Legal transitions: `PENDING -> APPROVED`,
`PENDING -> REJECTED`, `APPROVED -> REVERSED`. `REJECTED` and `REVERSED`
are both terminal — in particular `REJECTED` can never become `APPROVED`
(re-review means a new conversion, not resurrecting a rejected one) and
`REVERSED` can never become `APPROVED` again (a reversal is final, not a
pause). A transition to the same status is treated as a legal, idempotent
no-op (no duplicate audit entry).

Enforced exclusively through three explicit endpoints —
`POST .../conversions/:id/approve`, `.../reject`, `.../reverse`, each
taking no request body — never through a generic `PATCH`; there is no
`PATCH` endpoint for conversions at all (nothing about a conversion
besides its status changes after creation, and status has its own
explicit surface). Applied via the same conditional-`updateMany`
race-safety pattern Phase 6 established
(`transitionConversionStatus` in `conversions.service.ts`): the transition
is validated, then applied guarded on the status just read, so a
concurrent status change can't be silently clobbered — the loser gets a
`409` asking it to retry rather than corrupting state. See
`apps/api/test/conversion-tracking.test.ts` ("handles concurrent status
changes safely") for a test that fires `approve` and `reject` concurrently
against the same `PENDING` conversion and asserts exactly one wins.

## Monetary representation

`value` (`Decimal(12,2)`) and `currency` (`VarChar(3)`) reuse the exact
representation `Campaign.budgetAmount`/`budgetCurrency` already
established in this codebase — not a new convention. Renamed from the
model's old `payoutAmount`/`payoutCurrency` to `value`/`currency`: "payout"
specifically connotes an affiliate commission (Phase 9, not built), while
"value" is neutral about who eventually gets paid what — a conversion's
own reported value and a partner's payout on it are two different numbers
this phase deliberately doesn't conflate.

Both fields are nullable, and only together: an advertiser reporting a
non-monetary event (a signup, a lead) supplies neither; a monetary event
supplies both (`createConversionSchema` rejects one without the other).
Validation: `value` must be finite (rejects `NaN`/`Infinity`), non-negative
(negative values are rejected outright — see "Reversal, not negation"
below), and capped at `9,999,999,999.99` (the largest value
`Decimal(12,2)` can hold, so an out-of-range submission fails with a clean
`400` instead of a raw database error). `currency` is normalized to
uppercase and must be exactly 3 letters (an ISO-4217-shaped code, not
validated against the actual ISO-4217 list — same level of validation
`Campaign.budgetCurrency` already applies).

### Reversal, not negation

A `REVERSED` conversion's `value` is never modified, negated, or zeroed —
its status changes; the originally reported amount stays exactly as
reported. `approvedConversionValue` (see "Analytics" below) is computed by
filtering on `status = 'APPROVED'`, so a reversed conversion's value drops
out of that sum on its own once its status changes, without ever touching
the stored number. This keeps the conversion record an honest, unedited
account of what was originally reported — a future refund/chargeback
accounting system (out of scope here) can reconstruct "gross reported"
vs. "net after reversals" from status alone, without needing to trust that
`value` was never silently rewritten.

## Timestamps

`occurredAt` is caller-supplied (when did the conversion actually happen,
which may predate when it's reported) but never trusted as an
unconditionally authoritative clock: it must not be more than
`MAX_FUTURE_CLOCK_SKEW_MS` (5 minutes) ahead of the server's own clock at
request time. Five minutes is generous enough to absorb ordinary clock
drift between an external caller and this server while still catching
"absurd dates far in the future." There is no lower bound — a backfilled
conversion for an old click is legitimate and `occurredAt` may be
arbitrarily far in the past. If omitted, it defaults to the server's
current time at creation (`new Date()`), same as `Click.occurredAt`'s own
default. Stored as a naive Postgres `timestamp` whose wall-clock digits
are always UTC, matching `Click.occurredAt`'s existing storage convention
(see `docs/architecture/click-analytics.md` for the same pattern applied
to click timestamps) — never the client's own timezone.

## RBAC

| Action | Minimum role |
| --- | --- |
| List/get | `VIEWER` |
| Create (report a conversion) | `MEMBER` |
| `approve`/`reject`/`reverse` | `ADMIN` |

Matches this codebase's existing event-ingestion model: reporting that
something happened is a `MEMBER`-level action (same tier as creating a
campaign or tracking link), while a status decision that determines
whether a conversion counts as real, attributed revenue is gated one tier
higher — the same reasoning Phase 6 applied to campaign/tracking-link
lifecycle actions. No new role, no privilege expansion.

`createConversion`/`approveConversion`/`rejectConversion`/
`reverseConversion` are plain, HTTP-framework-independent functions
(`prisma`, `actorUserId`, `organizationId`, ...) — the same service-layer
shape every other module in this codebase uses. This is a deliberate,
pre-existing property this phase relies on rather than something new it
had to build: a future Phase 11 API/integrations layer (a machine caller
authenticating some other way) can call these same functions directly
without needing conversions.routes.ts to change.

## Organization isolation

Every conversion lookup — the click a new conversion references, an
existing conversion by ID, the list endpoint — is scoped to
`organizationId`, verified server-side, exactly like every other module.
A `clickId` from another organization is a uniform `404` at creation (see
"Click attribution" above); reading, approving, rejecting, or reversing
another organization's conversion by ID is a `403` (the organization
membership check runs before the conversion is even looked up, same
`requireOrganizationMember` preHandler every other route uses). See
`apps/api/test/conversion-tracking.test.ts` ("conversion security") for
the IDOR test matrix.

## Audit events

Using the existing `AuditLog` architecture, written inside the same
transaction as the mutation, never containing secrets/tokens/raw IPs:

- `conversion.created` — metadata: `{ eventName, clickId, campaignId }`.
- `conversion.approved`, `conversion.rejected`, `conversion.reversed` —
  metadata: `{ from, to }` (the previous and new status).

An idempotent repeated status action (e.g. calling `approve` twice) writes
**no** additional audit entry the second time — `transitionConversionStatus`
returns early once it observes `conversion.status === targetStatus`,
before ever reaching the audit-log write.

## Analytics

`GET /organizations/:organizationId/analytics/conversions/summary`
(`getConversionSummary`, `apps/api/src/modules/analytics/analytics.service.ts`)
reuses the exact `AnalyticsFilters` shape (organization + `[from, to)` +
optional campaign/link/domain) Phase 4's click analytics already
established — one more indexed aggregation query alongside the existing
click ones, not a new query language.

Metrics returned:

- `totalConversions` / `pendingConversions` / `approvedConversions` /
  `rejectedConversions` / `reversedConversions` — status breakdown, all
  conversions in range regardless of status.
- `totalConversionValue` — `SUM(value)` across every conversion in range,
  any status. A raw total, not a "trust this number" figure: a `PENDING`
  or `REJECTED` conversion's reported value counts here too.
- `approvedConversionValue` — `SUM(value)` filtered to `status = 'APPROVED'`
  only — the figure an advertiser would actually treat as attributed
  revenue.
- `humanClicksInRange` — `COUNT(*)` of clicks in the same window/filters
  whose `botClassification = 'HUMAN'`.
- `conversionRate` — see below.

### Conversion rate — precise definition

```
conversionRate = (approvedConversions / humanClicksInRange) * 100
```

Expressed as a percentage (0-100), matching `ClickSummary.botPercentage`'s
existing convention — not a 0-1 ratio. Returns `0` when
`humanClicksInRange` is `0` (never divides by zero).

**The denominator is HUMAN clicks specifically — not all clicks, and not
unique clicks.** Bot and suspicious traffic can never convert
legitimately; including it in the denominator would dilute the rate with
clicks that were never going to convert in the first place, understating
real performance for a campaign that happens to attract heavier bot
traffic. This is a deliberate choice, not an oversight — see "Do NOT
silently mix bot traffic into or out of the metric" in this phase's own
brief. `humanClicksInRange` is returned alongside `conversionRate` so a
caller can see the exact denominator used, not just the resulting ratio.

**This is a period-over-period ratio, not a cohort conversion rate.**
`humanClicksInRange` and every conversion count above are independently
filtered to the same `[from, to)` window by their *own* `occurredAt` — a
click on day 1 whose conversion is approved on day 5 contributes to day
1's click count and day 5's conversion count separately, not to "day 1's
conversion rate for clicks that eventually converted." A campaign with
meaningfully delayed conversions (click today, purchase next week) will
show this lag in its day-by-day numbers. This is a deliberate
simplification — Phase 7's brief is explicit that a full attribution
engine (which would track a click through to its eventual conversion
regardless of when that happens) is not in scope yet — not a bug to be
quietly worked around.

No timeseries/breakdown-by-dimension endpoint was added for conversions
(unlike clicks' `by-campaign`/`by-link`/`by-device`/etc. — Phase 4) since
nothing in this phase's brief asked for one and the summary endpoint
covers every metric explicitly requested.

## API endpoints

```
GET    /organizations/:organizationId/conversions
POST   /organizations/:organizationId/conversions
GET    /organizations/:organizationId/conversions/:conversionId
POST   /organizations/:organizationId/conversions/:conversionId/approve
POST   /organizations/:organizationId/conversions/:conversionId/reject
POST   /organizations/:organizationId/conversions/:conversionId/reverse

GET    /organizations/:organizationId/analytics/conversions/summary
```

The list endpoint supports optional `status`/`campaignId`/`trackingLinkId`
filters and cursor-based pagination (`take`, default 50, max 100;
`cursor`), the same shape `audit-logs.routes.ts` already established for
an event-log-like list, rather than inventing a second pagination
convention.

## Dashboard

A single `/conversions` page: a stat-tile row (pending/approved counts,
approved value, conversion rate), a status filter, and a table listing
event name, campaign, tracking link, a truncated click ID, value/currency,
status, and `occurredAt` — everything the brief asked to display. Status
action buttons (approve/reject/reverse, shown only for the transitions
legal from a conversion's current status) are visible only to
`ADMIN`/`OWNER`; a `VIEWER` sees the same table with no action column.
There is no conversion-creation form — reporting a conversion is
positioned as an API/integration action (see RBAC above), not a manual
dashboard workflow, so this deliberately stays a list-and-review surface
rather than growing into "a giant CRM-style conversion management UI."

## Relationship with the tracker and Google transparency

Nothing in `apps/tracker` changed. The redirect path is exactly what
Phase 3 established: `request -> transparent destination validation ->
domain/link resolution -> bot classification -> Click -> redirect`,
`GET /:slug?redirection_url=<validated-next-hop>` with the visible
next-hop semantics untouched — no conversion processing runs on this
path, and the tracker never waits on anything conversion-related.
Conversion reporting happens entirely after the fact, through
`apps/api`, on its own request.

If a destination page needs the `clickId` for its own attribution (e.g.
to later call this phase's `POST .../conversions` with it), that is
between the advertiser's landing page and their own systems — this phase
does **not** append `clickId` (or any other parameter) to the transparent
redirect's `Location` header. Doing so would modify the visible next-hop
the Google Transparent Click Tracker architecture depends on being exactly
the caller-supplied, validated `redirection_url` — see
`docs/compliance/google-transparent-tracker.md`. No undocumented tracker
domain, no hidden redirect, no change to what's visible in the redirect
response. A documented server/API mechanism (this phase's `POST
.../conversions` endpoint itself) is the only sanctioned way a `clickId`
flows into conversion reporting.

## Data model changes

Migration `20260902155750_conversion_tracking_foundation`:

- `Conversion.trackingLinkId`/`clickId` move from optional to required
  (the table had no writer before this phase, so no backfill was needed).
- `payoutAmount`/`payoutCurrency` renamed to `value`/`currency` (see
  "Monetary representation" above).
- New `eventName` (required) and `externalConversionId` (optional)
  columns.
- New unique index `(organizationId, externalConversionId)`.
- New indexes: `(campaignId, occurredAt)`, `(trackingLinkId, occurredAt)`,
  `(status, occurredAt)` — replacing the old bare `campaignId`/
  `trackingLinkId` indexes, which no query in this phase needs standalone.
  `clickId` keeps its existing bare index (point lookups by click, not a
  ranged/filtered scan).
- New trigger `enforce_conversion_click_attribution` (see "Click
  attribution" above).

## Known limitations

- No cohort/attribution-window conversion rate — see "Conversion rate"
  above.
- No timeseries or dimensional breakdown for conversions (by-campaign,
  by-day, etc.) — only the summary endpoint.
- No affiliate/partner payout calculation — `value`/`currency` describe
  the conversion event itself, not what any partner is owed for it
  (Phase 9).
- No bulk status operations — one API call per conversion.
- Deduplication only applies when `externalConversionId` is supplied — a
  caller that omits it gets no dedup guarantee at all (documented
  contract, not a gap — see "Deduplication" above).
- No webhook/callback delivery for conversion status changes — a future
  Phase 11 API/integrations layer would add that on top of the same
  service functions this phase already exposes.
