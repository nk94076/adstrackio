# Attribution & Advanced Reporting (Phase 10)

## Status and scope

Phase 10 adds a reporting layer on top of Phases 1-9's existing source of
truth (`Click`, `Conversion`) — it introduces no new attribution
mechanism, no new event-recording path, and no schema change. Every
number this phase's endpoints return is a PostgreSQL aggregation over
`clicks`/`conversions` rows that Phase 3 (tracker), Phase 4 (enrichment),
Phase 7 (conversions), and Phase 9 (affiliate attribution) already write.

**Explicitly out of scope**: multi-touch attribution, CSV/Excel/PDF
export, Redis/materialized-view caching, and currency conversion — see
"Known limitations" below.

## What existed before this phase (audit summary)

Inspected directly before writing any code:

- `apps/api/src/modules/analytics/analytics.service.ts` (Phase 4/7/9) —
  `AnalyticsFilters`, `buildWhere`/`buildConversionWhere` (the two
  functions every click/conversion query in this codebase already
  filters through), `getClickSummary`, `getClickTimeseries`, the
  `getClicksByX` breakdown family, `getConversionSummary`, and
  `getAffiliatePartnerPerformance`. Phase 10 extends these functions and
  adds new ones in the same file, in the same style — it does not
  introduce a second, parallel query-building layer.
- `packages/database/prisma/schema.prisma` — `Click`'s columns
  (`botClassification`, `deviceType`, `browser`, `os`, `country`,
  `affiliatePartnerId`, `ipHash`, `userAgent`, `occurredAt`) and
  `Conversion`'s columns (`status`, `value`, `currency`, `campaignId`,
  `trackingLinkId`, `clickId`, `occurredAt`) — confirmed to already carry
  every column this phase's dimensions/metrics need. No migration was
  required (see "Migration" below).
- `docs/architecture/conversion-tracking.md` and
  `docs/architecture/affiliate-partners.md` — the existing attribution
  chains (`Conversion.clickId -> Click`, `Click.affiliatePartnerId ->
  TrackingLink.affiliatePartnerId`) this phase's reports read from, never
  re-derive.
- `apps/api/src/modules/conversions/conversions.service.ts` — confirmed
  `createConversionSchema` already has no `campaignId`/`trackingLinkId`/
  `affiliatePartnerId` field (Phase 7/9), so a forged attribution attempt
  on conversion creation is already impossible; this phase's own
  "attribution integrity" tests exercise that guarantee from the
  reporting side (a forged value has no effect on which report a
  conversion appears in), rather than re-testing the ingestion-side
  stripping already covered in `conversion-tracking.test.ts`.

## Attribution model: first-click, via the recorded Click

Phase 10 does not implement a new attribution model — it documents and
reports on the one this codebase already has:

> A conversion is attributed to the Click referenced by its
> `clickId`. That Click's own `campaignId`, `trackingLinkId`, and
> `affiliatePartnerId` are authoritative. This is what Phase 10 calls
> "first-click" attribution: there is exactly one click per conversion
> (the one the conversion was reported against), and that click's own
> recorded context is never re-derived, re-guessed, or overridden by
> anything supplied at conversion-report time.

Concretely:

```
Conversion.clickId -> Click.campaignId        (authoritative campaign attribution)
Conversion.clickId -> Click.trackingLinkId    (authoritative tracking-link attribution)
Conversion.clickId -> Click.affiliatePartnerId (authoritative affiliate attribution)
```

`createConversionSchema` (`packages/validation/src/conversions.ts`) has no
`campaignId`, `trackingLinkId`, or `affiliatePartnerId` field — a client
that includes any of these in a `POST .../conversions` body has them
silently stripped by Zod, never honored (Phase 7/9, unchanged by this
phase). `Conversion.campaignId`/`trackingLinkId` are derived server-side
from the click at insert time and enforced immutable afterward by
`enforce_conversion_click_attribution` (Phase 7); `Click.affiliatePartnerId`
is itself immutable after creation (`enforce_click_affiliate_partner_immutable`,
Phase 9). Phase 10 relies on both, unmodified.

**Not multi-touch.** A visitor who clicks a link twice before converting
produces two independent `Click` rows; the conversion is attributed to
whichever single click it was reported against (`clickId`), not to some
combination of both. There is no "first click ever by this visitor" or
"last click before conversion" resolution across multiple clicks — the
attribution is simply "the one click this conversion names." See "Future
multi-touch attribution possibilities" below for what a later phase would
need to add.

## Reporting dimensions

Grouping/filtering is supported for every dimension `Click` actually
stores — nothing is invented:

| Dimension | Column | Notes |
| --- | --- | --- |
| organization | `organizationId` | always implicit — every query is scoped to the authenticated URL's organization |
| campaign | `campaignId` | |
| tracking link | `trackingLinkId` | |
| affiliate partner | `affiliatePartnerId` | nullable — only links with one configured have it |
| date/time | `occurredAt` | timezone-aware bucketing, see "Time series" below |
| country | `country` | nullable — populated only when a geo provider is configured (Phase 4) |
| device type | `deviceType` | closed enum |
| browser | `browser` | free text (UA-parser-derived, no closed list — see Phase 8's own precedent for this exact tradeoff) |
| operating system | `os` | free text, same caveat as browser |
| bot classification | `botClassification` | closed enum |

## Core metrics and exact formulas

All formulas below are computed in PostgreSQL (`COUNT`, `COUNT DISTINCT`,
`SUM`, `FILTER`, `GROUP BY`) — never in a Node.js loop over fetched rows.

**Traffic** (from `clicks`, `AnalyticsFilters`-scoped):

- `totalClicks` = `COUNT(*)`
- `uniqueClicksInRange` = `COUNT(DISTINCT (ipHash, userAgent))` over the
  **entire** requested range — see "Unique visitor definition" below.
- `humanClicks`/`botClicks`/`suspiciousClicks`/`unknownClicks` =
  `COUNT(*) FILTER (WHERE botClassification = '...')`

**Conversions** (from `conversions`):

- `totalConversions`, `pendingConversions`, `approvedConversions`,
  `rejectedConversions`, `reversedConversions` = `COUNT(*) FILTER (WHERE
  status = '...')`

**Performance:**

- `conversionRate` and `approvedConversionRate` — **the same formula**:
  `approvedConversions / humanClicksInRange × 100`, rounded to 2 decimal
  places, `0` when `humanClicksInRange` is `0`. Two field names exist for
  one reason: `conversionRate` is `ConversionSummary`'s original Phase 7
  field and **is kept byte-for-byte unchanged** (its existing public
  definition is preserved per this phase's own instruction not to
  silently change an existing analytics definition); `approvedConversionRate`
  is the same value under Phase 10's own, more explicit name. Every
  Phase-10-introduced row type (`CampaignPerformanceRow`,
  `TrackingLinkPerformanceRow`, and the extended
  `AffiliatePartnerPerformanceRow`) carries both fields with the same
  equality, for one consistent meaning across the whole reporting
  surface. There is no separate "rate including non-approved conversions"
  metric — only approved conversions ever count as "performance."
- **Denominator is human clicks specifically** — never all clicks, never
  unique clicks. Bot/suspicious traffic can never convert legitimately,
  so including it would dilute the rate with clicks that were never going
  to convert. This is Phase 7's original design decision, unchanged.
- `EPC` ("earnings per click") = `approvedConversionValue /
  humanClicksInRange`, rounded to 2 decimal places, `0` when
  `humanClicksInRange` is `0`. **Not a percentage** — a currency-per-click
  figure, never multiplied by 100.
- All rate/EPC formulas use the exact same human-click denominator a
  caller already sees as `humanClicksInRange`/`humanClicks` in the same
  response, so nothing is computed against a number the response doesn't
  also expose.

**Zero-denominator behavior**: every rate/EPC computation is guarded
(`humanClicks > 0 ? ... : 0`) — never `NaN`, never `Infinity`, never a
divide-by-zero error. Covered by a dedicated test.

## Unique visitor definition (unchanged from Phase 4)

`COUNT(DISTINCT (ipHash, userAgent))` — preserved exactly as Phase 4
defined it; this phase found no correctness issue to justify changing it.
Two important, deliberately-still-true facts:

- **Range-wide** unique counts (`ClickSummary.uniqueClicksInRange`,
  every performance-row's `uniqueClicksInRange`) are computed over the
  *entire* requested `[from, to)` window in one aggregation.
- **Bucket-level** unique counts (`ReportTimeseriesPoint.uniqueClicksInBucket`)
  are computed independently *per bucket*. A visitor who clicks in two
  different buckets is counted once in each. **Summing bucket-level
  uniques across a timeseries does NOT equal the range-wide unique
  count** — this was already true in Phase 4 and remains true here;
  the reports timeseries test asserts this explicitly (two clicks
  from the same visitor on two different days: 2 bucket-level uniques,
  but 1 range-wide unique).

## Bot treatment

`botClassification` comes exclusively from the value already stored on
`Click` (written by `apps/tracker`'s bot-detection engine — Phase 5).
Phase 10 adds no new classification logic and reads this column
read-only. **Bot clicks never enter a human-performance denominator**:
every rate/EPC formula divides by `humanClicksInRange` specifically, so a
click classified `BOT` or `SUSPICIOUS` can inflate `totalClicks` but can
never dilute a conversion rate or EPC figure. The tracker's own
`BOT -> SAFE_PAGE` routing rule (Phase 5, unmodified by Phase 8's Rules
Engine or Phase 9's affiliate attribution) is completely untouched by
this phase — Phase 10 adds no code to `apps/tracker` at all.

## Revenue / value and currency

`Conversion.value` (`Decimal(12,2)`) and `Conversion.currency`
(`VarChar(3)`, both nullable, Phase 7) are the only monetary
representation this codebase has. Phase 10 aggregates `value` via
`SUM(value)`/`SUM(value) FILTER (WHERE status = 'APPROVED')` exactly as
Phase 7's `getConversionSummary` already did — **this is an unchanged,
pre-existing behavior, not a new design decision by this phase.**

**Known limitation, inherited from Phase 7, not introduced here**: `SUM(value)`
has no awareness of `currency` — it blindly adds every matching
conversion's `value` regardless of what `currency` each one recorded. If
an organization records conversions in more than one currency, every
summed value field (`totalConversionValue`, `approvedConversionValue`)
and every `epc` figure derived from it mixes currencies meaninglessly.
This codebase does **not** invent a currency-conversion step to fix this
— per this phase's explicit instruction, doing so would fabricate an
exchange rate this system has no real source for. An organization that
only ever records one currency (the common case) is unaffected. A future
phase that wants correct multi-currency reporting would need to either
group these sums by `currency` (returning a value array/map per currency
instead of one number) or maintain a real, source-of-truth exchange-rate
table — neither of which Phase 10 attempts.

## Time series

`getConversionTimeseries` is the new conversion-side counterpart to
Phase 4's `getClickTimeseries` — same `date_trunc(bucket, occurredAt AT
TIME ZONE 'UTC' AT TIME ZONE $timezone)` double-conversion (verified
against real Postgres when Phase 4 built it; reused verbatim here on
`conversions.occurredAt` instead of `clicks.occurredAt`), same bucket
types. **`month` is newly accepted** alongside the existing
`hour`/`day`/`week` — Postgres's `date_trunc` already supports `'month'`
natively, so no query code changed, only
`packages/validation/src/analytics.ts`'s `timeseriesBucketSchema` enum.

`GET .../reports/timeseries` merges both queries' results by their shared
bucket-string key (a plain JS `Map`, the same merge-by-key shape
`getAffiliatePartnerPerformance` already uses for clicks+conversions) —
neither query is aware of the other; the route handler is the only place
they're combined.

A conversion's bucket is derived from **its own** `occurredAt`, entirely
independent of its click's `occurredAt` — a click on day 1 whose
conversion is approved and reported on day 5 contributes to day 1's click
count and day 5's conversion count separately. This is the same "not a
cohort rate" simplification `ConversionSummary` already documents (Phase
7); Phase 10 does not change it.

**Timezone interpretation**: identical to Phase 4 — the `timezone` query
parameter (IANA name, default `"UTC"`) determines which wall-clock day/
hour/week/month a click or conversion's UTC-stored instant falls into.
"Daily" for an organization in `America/New_York` means a day boundary at
midnight New York time, not midnight UTC — this was already Phase 4's
behavior for clicks and is now identically true for conversions.

## Query performance strategy

Every function in this phase follows the same rule Phase 4 established:
one (or two, for click+conversion combinations) PostgreSQL aggregation
query per report, never a per-row Node.js loop, never an N+1 query.
Concretely:

- `getCampaignPerformance`/`getTrackingLinkPerformance` each run exactly
  two queries (one `GROUP BY` over `clicks`, one over `conversions`) plus
  one `findMany` for the label list (campaign names / link slugs) — three
  total queries regardless of how many clicks or conversions exist,
  merged by primary key in JS via a `Map` (the same shape
  `getAffiliatePartnerPerformance` already established in Phase 9).
- `getDimensionBreakdown` runs exactly two queries (one per table),
  parameterized over a **whitelisted** column reference
  (`DIMENSION_COLUMNS`, a closed `Record<ReportDimension, Prisma.Sql>`) —
  the caller-supplied `dimension` string is validated against a closed
  Zod enum before this function is ever called, and is never
  string-interpolated into raw SQL; only a pre-built `Prisma.Sql`
  fragment from the whitelist is used.
- No new indexes were added. Every query in this phase filters/groups on
  columns Phase 3/4/7/9 already indexed: `clicks(organizationId,
  occurredAt)`, `clicks(campaignId, occurredAt)`,
  `clicks(trackingLinkId, occurredAt)`, `clicks(affiliatePartnerId,
  occurredAt)`, `conversions(organizationId, occurredAt)`,
  `conversions(campaignId, occurredAt)`,
  `conversions(trackingLinkId, occurredAt)`. The one dimension without a
  dedicated index (`country`/`deviceType`/`browser`/`os`/
  `botClassification` breakdowns scan by `organizationId, occurredAt`
  first via the existing composite index, then group in-memory-on-the-
  database-side over the matched rows) was judged acceptable at expected
  report-query volumes rather than adding five more single-column
  indexes speculatively — see "Do not add unnecessary indexes" in the
  brief this phase was built against.
- No caching (Redis or otherwise) and no materialized views were added.
  Correct, indexed PostgreSQL aggregation was judged sufficient; this
  phase found no concrete performance problem that would justify the
  added operational complexity.

## API surface

```
GET /organizations/:organizationId/reports/overview
GET /organizations/:organizationId/reports/timeseries
GET /organizations/:organizationId/reports/campaigns
GET /organizations/:organizationId/reports/tracking-links
GET /organizations/:organizationId/reports/dimensions
```

**Deliberately no `GET .../reports/affiliate-partners`.** The pre-existing
`GET .../analytics/affiliate-partners/performance` endpoint (Phase 9)
already serves exactly this report, extended in this phase with
`totalConversionValue`/`approvedConversionValue`/`approvedConversionRate`/
`epc` fields. Adding a second URL for the identical query would be
exactly the "unnecessary duplicate endpoint" this phase was told to
avoid — see `reports.routes.ts`'s own doc comment. The dashboard's
Reports page calls the existing endpoint directly for its
affiliate-partner table.

All filters (`from`, `to`, `timezone`, `campaignId`, `trackingLinkId`,
`affiliatePartnerId`, `country`, `deviceType`, `browser`, `os`,
`botClassification`) are accepted by every endpoint above via the same
`analyticsFilterSchema`/`timeseriesFilterSchema` Phase 4/7/9 already
established, now extended with the five new dimension filters.
`GET .../reports/dimensions` additionally requires a `dimension` query
parameter (one of `country`/`deviceType`/`browser`/`os`/
`botClassification`), validated by `reportDimensionSchema` — an
out-of-whitelist value is rejected with `400`, never silently ignored.

RBAC: `VIEWER` (and therefore `MEMBER`/`ADMIN`/`OWNER`, the existing
role-hierarchy convention) can read every report endpoint — identical to
every other analytics endpoint in this codebase. No report mutates
anything, so there is no higher-tier action to gate.

## Organization isolation / IDOR

Every endpoint takes `organizationId` only from the authenticated,
membership-checked URL path (`requireOrganizationMember("VIEWER")`,
exactly as `analytics.routes.ts` already does) — never from the request
body, never trusted from a query parameter. A filter's ID (`campaignId`,
`trackingLinkId`, `affiliatePartnerId`) supplied from a *different*
organization can never leak that organization's data: every query's
`WHERE` clause always `AND`s the filter condition together with
`organizationId = <the URL's own organization>` (`buildWhere`/
`buildConversionWhere`), so a cross-org ID simply matches zero rows —
there is no click or conversion whose `organizationId` is the caller's
own AND whose `campaignId` belongs to a different organization, since a
campaign belongs to exactly one organization. This is a structural
guarantee (the same AND-condition composition Phase 4/7/9 already relied
on), not a special case added for this phase, and is covered by dedicated
tests for a cross-org `campaignId`, `trackingLinkId`, and
`affiliatePartnerId` filter each returning zero rows rather than an
error or leaked data. A member of one organization hitting another
organization's report URL directly gets `403` (via
`requireOrganizationMember`) before any service code runs, the same
membership-check convention every other module uses.

## Historical attribution

Nothing in this phase writes to `Click`, `Conversion`, `AffiliatePartner`,
or `TrackingLink` — every function here is read-only. Phase 9's own
"historical attribution survives archival" guarantee (archiving a partner
never touches existing `Click`/`TrackingLink`/`CampaignAffiliatePartner`
rows) is therefore automatically preserved: `GET
.../analytics/affiliate-partners/performance` continues to return an
archived partner's row (with its real historical clicks, conversions, and
value) exactly as before, now with the phase's new value/EPC fields
populated from the same unmodified historical data. Covered by a
dedicated test that archives a partner with historical clicks/conversions
and confirms the performance report still shows them correctly.

## Tests

- `apps/api/test/reports.test.ts` (21 tests) — overview aggregation
  (including the human/bot separation and zero-denominator-safety
  checks), unique-visitor range-wide vs. bucket-level distinction,
  date-range filtering, timeseries bucket merging across all four bucket
  sizes, per-campaign and per-tracking-link performance (including value/
  EPC and a campaign filter narrowing both tables), all five dimension
  breakdowns (including the closed-whitelist rejection test), dimension
  filters, conversion lifecycle changes reflected in reports (including a
  concurrent duplicate-approve test proving no double-counting),
  forged-attribution-has-no-effect-on-reporting, RBAC across all four
  roles, cross-org report access denied, cross-org campaign/tracking-link/
  affiliate-partner filters returning zero rows rather than leaking data,
  and archived-partner historical reporting.
- `apps/api/test/analytics.test.ts` (28, unchanged), `affiliate-partners.test.ts`
  (41, unchanged), `conversion-tracking.test.ts` (42, unchanged) — re-run
  in full as regression coverage for the functions this phase extends
  (`ConversionSummary`, `AffiliatePartnerPerformanceRow`); all pass
  unmodified, confirming the new fields are additive and did not change
  any existing field's value or meaning.
- `apps/tracker`'s full test suite (161 tests) — re-run unmodified as
  regression coverage proving `BOT -> SAFE_PAGE`, the transparent
  `redirection_url` behavior, Phase 8 routing, and Phase 9 click
  attribution are all completely unaffected (Phase 10 makes no change to
  any file under `apps/tracker`).

## Known limitations

- **No multi-touch attribution.** See "Attribution model" above — a
  conversion is attributed to the one click it names, not to a sequence
  of a visitor's prior clicks. A future phase could add this by
  recording a visitor-identity join key (this codebase's current
  `ipHash`+`userAgent` uniqueness proxy is not a stable enough identity
  for that) and a real multi-touch weighting model (first-click,
  last-click, linear, or time-decay) — deliberately not attempted here.
- **Currency mixing.** See "Revenue / value and currency" above — value
  sums assume a single currency per organization; this is inherited from
  Phase 7, not introduced by this phase.
- **No export.** CSV/Excel/PDF export was evaluated and deliberately not
  built this phase — the existing architecture has no export
  infrastructure to make it "trivial and safe" as instructed, and
  bolting one on would be new infrastructure complexity outside this
  phase's scope. A future phase could add a CSV endpoint that streams the
  exact same `getCampaignPerformance`/etc. query results, reusing every
  organization-scoping guarantee this phase already established.
- **No caching layer.** Every report is a live PostgreSQL aggregation on
  every request. Acceptable at expected data volumes; a future phase
  should only add caching (or a materialized view refreshed on a
  schedule) if a real, measured performance problem justifies the added
  complexity — not preemptively.
- **Free-text `browser`/`os` dimensions are not validated against a
  closed list** (same precedent as Phase 8's own `RoutingRule`
  `BROWSER`/`OS` conditions) — a breakdown row's key is whatever string
  the UA parser produced, which can vary in capitalization/format across
  different user agents.
