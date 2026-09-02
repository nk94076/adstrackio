# Click Analytics (Phase 4)

## Status and scope

This document describes **Phase 4: Click Analytics** — the reporting layer
built on top of the `Click` rows Phase 3 (Transparent Click Tracker) writes.
It is analytics only. It does **not** implement: real bot detection (Phase
5 — `HeuristicBotDetectionEngine` from Phase 3 is unchanged), Campaign
Manager routing rules (Phase 6/8), conversion tracking or postbacks (Phase
7), the affiliate/partner system, an attribution engine, or any Google
Transparent Click Tracker certification claim (see
`docs/compliance/google-transparent-tracker.md` — nothing in this document
changes that status).

Phase 4 adds:

- Real User-Agent parsing and (optional, pluggable) IP-based geolocation
  enrichment on `Click` rows, written by `apps/tracker` at click time.
- A privacy-conscious, deterministic "unique click" methodology (below).
- Ten read-only, authenticated, organization-scoped analytics endpoints on
  `apps/api`, all backed by single PostgreSQL aggregation queries.
- An `/analytics` dashboard page consuming those endpoints.

## Metric definitions

All metrics are computed over `Click` rows matching the request's filters
(organization, date range, and optionally campaign/tracking link/tracking
domain) — see "Filtering and organization scoping" below.

- **Total clicks** — `COUNT(*)` of matching `Click` rows.
- **Human / bot / suspicious / unknown clicks** — `COUNT(*) FILTER (WHERE
  "botClassification" = ...)`, reusing `Click.botClassification` exactly as
  Phase 3's `BotDetectionEngine` wrote it. Phase 4 does not run its own bot
  classification and does not recompute or reinterpret this value — see
  "Relationship to bot detection" below.
- **Bot percentage** — `botClicks / totalClicks * 100`, rounded to 2
  decimal places; `0` when `totalClicks` is `0` (never a division-by-zero
  error or `NaN` in a JSON response).
- **Unique clicks** — see "Unique click methodology" below.

### Unique click methodology

A raw `Click` row is **one inbound request**, not one visitor — the same
person clicking a link twice produces two `Click` rows. "Unique clicks" is
this codebase's definition of a deduplicated visitor estimate, and it is
deliberately conservative about what it claims:

```sql
COUNT(DISTINCT (c."ipHash", c."userAgent"))
```

Two `Click` rows are counted as the same "unique" visit within the query's
date range when they share both `ipHash` (a one-way, salted hash of the
request IP — see `docs/architecture/data-model.md`) and the raw
`userAgent` string. This is a coarse fingerprint, not a tracking cookie or
device ID, and it is understood to have real limitations:

- **Shared IP, shared browser** (e.g. a corporate NAT or a school network
  where many people run the same browser/OS combination) will
  under-count — multiple real visitors collapse into one "unique" click.
- **The same visitor across networks or browsers** (switching from wifi to
  mobile data, or from Chrome to Safari) will over-count — one real
  visitor produces two "unique" clicks.
- **NULL handling**: Postgres's row-tuple `DISTINCT` treats `(NULL,
  NULL)` as equal to itself, so two clicks with no `ipHash` and no
  `userAgent` at all are still counted as (at most) one unique row rather
  than each counting separately — verified directly against Postgres
  before relying on it.

**The uniqueness window is the query's own date range**, not a separately
stored bucket. `getClickSummary` computes uniqueness across the entire
`from`–`to` range; `getClickTimeseries` computes it independently *within
each bucket* (so a visitor who returns in a later hour/day/week bucket is
counted as unique again in that bucket) — there is no fixed, hardcoded
"uniqueness window" baked into a stored hash, which would have forced an
arbitrary choice (1 hour? 24 hours?) at write time that couldn't be
changed later without reprocessing historical data. Widening or narrowing
the effective window is simply a matter of choosing a different `from`/`to`
or `bucket` at query time.

This is an **estimate**, not a guarantee of distinct visitors, and the
dashboard and API responses describe it as such rather than implying
device-level or cookie-level accuracy.

#### Two distinct uniqueness windows — `uniqueClicksInRange` vs. `uniqueClicksInBucket`

Because summary/breakdown queries and timeseries queries apply this same
`COUNT(DISTINCT (ipHash, userAgent))` formula over **different windows**,
the API deliberately uses two different field names rather than reusing
`uniqueClicks` for both — reusing one name invites a client to sum the
per-bucket values and expect them to equal the range-wide total, which
they generally will not:

- **`ClickSummary.uniqueClicksInRange`** (and the same-named field on
  `ClickBreakdownRow`) — computed once, over the entire requested
  `from`–`to` range.
- **`ClickTimeseriesPoint.uniqueClicksInBucket`** — computed
  independently for each bucket. A visitor who clicks in two different
  buckets is counted once in *each* bucket's `uniqueClicksInBucket`, so
  **summing `uniqueClicksInBucket` across every point in a timeseries
  response does not equal the `uniqueClicksInRange` from a summary
  request over the identical `from`/`to`/filters** — the sum is always
  greater than or equal to the range-wide total, and typically strictly
  greater whenever any visitor returns in more than one bucket.

The dashboard's KPI card is explicitly labeled "Unique Clicks (range)"
and the breakdown tables' column is labeled "Unique (range)", both with a
tooltip explaining the distinction, specifically so a per-bucket number
is never displayed next to a range-wide one under an identical label.

### What is never exposed

`ipHash`, the raw request IP, and any visitor fingerprint are never
returned by any analytics endpoint or rendered in the dashboard.
`uniqueClicksInRange`/`uniqueClicksInBucket` are the only
visitor-identity-adjacent values ever exposed, and both are counts, never
the underlying `(ipHash, userAgent)` pairs — see "Privacy model" below.

## Time buckets and timezone handling

`getClickTimeseries` supports `hour`, `day`, and `week` buckets via
Postgres's `date_trunc`. Every request — summary, timeseries, and every
breakdown — takes an explicit `timezone` query parameter (IANA name, e.g.
`America/New_York`), validated with:

```ts
new Intl.DateTimeFormat(undefined, { timeZone: value }); // throws on invalid input
```

(`packages/validation/src/analytics.ts`). This — not
`Intl.supportedValuesOf("timeZone")` — is the validator, because the
latter's canonical IANA name list does not include `"UTC"` itself even
though `Intl.DateTimeFormat` accepts it everywhere else; using it would
have rejected the one value this API defaults to. **There is no implicit
server-timezone fallback** — an omitted `timezone` defaults explicitly to
`"UTC"` via the schema, never to `process.env.TZ` or the host's local
time.

### Why the double `AT TIME ZONE` conversion

`Click.occurredAt` is a Postgres `timestamp without time zone` column
holding UTC wall-clock digits (Prisma's default write behavior — the
column never carries the writer's local time zone). To bucket it correctly
in an arbitrary requested zone:

```sql
date_trunc(
  'day',
  c."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
)
```

The first `AT TIME ZONE 'UTC'` reinterprets the naive timestamp as the
`timestamptz` instant it actually represents; the second `AT TIME ZONE
$timezone` converts that instant to the requested zone's wall clock,
which `date_trunc` then buckets. Both the `timezone` string and the
`bucket` unit are passed as ordinary parameterized values through
`Prisma.sql`, exactly like every other filter value — verified directly
against Postgres that this carries no SQL-injection risk (both values are
additionally schema-validated before they ever reach the query: `timezone`
against `Intl.DateTimeFormat`, `bucket` against a fixed enum).

### Bucket timestamp shape in API responses

Each `ClickTimeseriesPoint.bucket` is rendered as `YYYY-MM-DDTHH:mm:ss`
with **no trailing `Z` or UTC offset** — e.g. `"2026-01-01T00:00:00"`, not
`"2026-01-01T00:00:00Z"`. Postgres/Prisma attach a `Z` to the returned
value purely because JavaScript's `Date` has no timezone-less
representation, but the underlying number is already the requested zone's
wall clock, not a true UTC instant — keeping the `Z` would misleadingly
imply the opposite. Callers should treat `bucket` as "local time in the
`timezone` you requested," never re-parse it as UTC.

## Query parameters (all ten endpoints)

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `from` | ISO date/datetime | `to` minus 7 days | |
| `to` | ISO date/datetime | now | |
| `timezone` | IANA tz name | `"UTC"` | Validated via `Intl.DateTimeFormat`, not `supportedValuesOf` |
| `campaignId` | cuid | — | Optional filter |
| `trackingLinkId` | cuid | — | Optional filter |
| `trackingDomainId` | cuid | — | Optional filter; resolved via a `trackingLinkId IN (SELECT ...)` subquery |
| `bucket` | `hour` \| `day` \| `week` | `day` | Timeseries endpoint only |

Validation (`packages/validation/src/analytics.ts`, `analyticsFilterSchema`
/ `timeseriesFilterSchema`):

- `from` must not be after `to` (`400` otherwise).
- The resolved range must not exceed **366 days**
  (`MAX_ANALYTICS_RANGE_DAYS`) — this is a hard cap, not just a UI default,
  specifically so a single request can't force an unbounded full-range
  aggregation scan.
- `campaignId` / `trackingLinkId` / `trackingDomainId` must be well-formed
  cuids if present.
- If neither `from` nor `to` is given, the range defaults to the last 7
  days (`DEFAULT_ANALYTICS_RANGE_DAYS`) ending now. If only one bound is
  given, the other is derived using that same default window width.

Every validation failure is a `400` with the existing
`{ "error": { "code": "VALIDATION_ERROR", ... } }` shape
(`docs/architecture/security.md#input-validation`) — analytics reuses the
same Zod-to-error-response pipeline as every other module, not a
parallel one.

## API endpoints

All under `/api/v1/organizations/:organizationId/analytics/clicks/...`,
gated by `fastify.authenticate` + `fastify.requireOrganizationMember("VIEWER")`
— the same minimum role as every other read endpoint in this codebase (see
"Authorization" below).

| Endpoint | Returns |
| --- | --- |
| `GET .../summary` | `{ summary: ClickSummary, range }` |
| `GET .../timeseries` | `{ points: ClickTimeseriesPoint[], bucket, range }` |
| `GET .../by-campaign` | `{ rows: ClickBreakdownRow[], range }` |
| `GET .../by-link` | same shape, grouped by `TrackingLink` |
| `GET .../by-domain` | same shape, grouped by `TrackingDomain` |
| `GET .../by-referrer` | same shape, grouped by normalized referrer hostname |
| `GET .../by-device` | same shape, grouped by `Click.deviceType` |
| `GET .../by-browser` | same shape, grouped by `Click.browser` |
| `GET .../by-os` | same shape, grouped by `Click.os` |
| `GET .../by-country` | same shape, grouped by `Click.country` |

```ts
interface ClickSummary {
  totalClicks: number;
  humanClicks: number;
  botClicks: number;
  suspiciousClicks: number;
  unknownClicks: number;
  uniqueClicksInRange: number; // whole from-to range — see "Unique click methodology"
  botPercentage: number; // 0–100, 2 decimal places
}

interface ClickTimeseriesPoint {
  bucket: string; // "YYYY-MM-DDTHH:mm:ss", local to `timezone` — no "Z"
  clicks: number;
  humanClicks: number;
  botClicks: number;
  uniqueClicksInBucket: number; // THIS bucket only — not summable into uniqueClicksInRange
}

interface ClickBreakdownRow {
  key: string;   // stable identifier (id for campaign/link/domain, raw value for the rest)
  label: string; // human-readable (name/slug/hostname; equals `key` for referrer/device/browser/os/country)
  clicks: number;
  humanClicks: number;
  botClicks: number;
  uniqueClicksInRange: number; // whole from-to range, scoped to this row's group
}
```

`uniqueClicksInRange` and `uniqueClicksInBucket` are deliberately
different field names, not the same field reused across shapes — see
"Two distinct uniqueness windows" above for why summing one into the
other produces a wrong number.

Breakdown endpoints are capped at **100 rows** (`BREAKDOWN_ROW_LIMIT` in
`apps/api/src/modules/analytics/analytics.service.ts`), ordered by
`clicks DESC` — a safety valve against an organization with an unbounded
number of distinct referrers/links, not a pagination mechanism. There is
no pagination on breakdown endpoints today; add one if a real deployment
needs more than 100 rows of a given dimension.

### Referrer normalization

`by-referrer` groups by **bare hostname**, extracted from the stored
`Click.referrer` with a Postgres regex
(`REFERRER_HOST_PATTERN`/`HOSTNAME_CHARSET_PATTERN` in
`analytics.service.ts`) — e.g. `https://www.google.com/search?q=x` groups
under `www.google.com`. Query strings and paths are dropped at query time
(they were never stripped from the stored `referrer` itself — Phase 3's
raw capture behavior is unchanged), both to avoid grouping the same
referring site into dozens of rows by query-string noise and to avoid
surfacing whatever sensitive-looking values a query string might carry in
a report. A missing referrer and a referrer that isn't a well-formed,
hostname-bearing URL are both grouped under the literal key `"(direct)"` —
deliberately conflating "no referrer sent" with "referrer present but
unparseable," since neither case can be attributed to a specific referring
site.

### Filtering and organization scoping

Every query starts from an unconditional `organizationId = $1 AND
"occurredAt" >= $from AND "occurredAt" < $to` clause
(`buildWhere` in `analytics.service.ts`) before any optional filter is
added. There is no code path that runs an analytics query without an
organization filter — a request can only narrow (via `campaignId` /
`trackingLinkId` / `trackingDomainId`) the rows already scoped to the
caller's own organization, established server-side from the authenticated
membership on the `:organizationId` route param (see "Authorization"
below), never from a request body or query value. Filtering by another
organization's `campaignId` (etc.) can never leak that organization's
data: the `WHERE organizationId = A AND campaignId = <B's campaign>`
clause can never match any of A's own rows, so the result is an empty/zero
result set, not an error and not another tenant's data — covered
explicitly by `apps/api/test/analytics.test.ts`.

## Authorization

Reuses the existing pattern exactly — no analytics-specific authorization
path exists:

```ts
preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")]
```

`VIEWER` is the existing minimum read role
(`packages/auth/src/roles.ts`, `OWNER > ADMIN > MEMBER > VIEWER`), the same
minimum every other read endpoint (domains, campaigns, tracking links)
uses. Cross-organization access is rejected the same way as everywhere
else in this codebase — see
`docs/architecture/security.md#authorization`.

## User-Agent enrichment

`packages/shared/src/user-agent.ts` defines the plug-in boundary —
`UserAgentParser` / `DeviceInfo` / `AnalyticsDeviceType` — mirroring the
existing `TrackingResolver` / `BotDetectionEngine` pattern: the interface
lives in `packages/shared`, the concrete implementation
(`UaParserUserAgentParser`, wrapping the `ua-parser-js` package) lives in
`apps/tracker`.

**This is an analytics concern only.** `UserAgentParser` derives
`deviceType`/`browser`/`browserVersion`/`os`/`osVersion` for reporting
purposes; it never participates in bot/human classification, which
remains `BotDetectionEngine`'s job exclusively
(`packages/shared/src/bot-detection.ts`). `UaParserUserAgentParser` only
imports `ua-parser-js`'s main export — never its own
`ua-parser-js/bot-detection` submodule — and is tested explicitly to
confirm its output carries no `classification`/`isBot`-shaped property
that could be mistaken for one. When `Click.botClassification` is `BOT`,
`Click.deviceType` is still forced to `"BOT"` in
`tracker.service.ts#recordClick`, overriding whatever the UA parser
returned — a bot classification is a more useful analytics signal for
that row than a spoofable UA string's device guess.

An unparseable, empty, or missing User-Agent resolves to
`UNKNOWN_DEVICE_INFO` (`deviceType: "UNKNOWN"`, all other fields `null`)
rather than guessing — `ua-parser-js` leaves `device.type` unset both for
a genuine desktop browser and for input it can't parse at all, so
`UaParserUserAgentParser` explicitly checks "did anything parse" (browser
or OS present) before defaulting to `DESKTOP`, to avoid misclassifying
garbage input as a real desktop hit.

## Geo enrichment

`packages/shared/src/geo-location.ts` defines `GeoLocationProvider` /
`GeoLocationResult`, with `NullGeoLocationProvider` as the default,
wired-in implementation — it performs no lookup at all and always resolves
to `{ country: null, region: null, city: null, timezone: null }`.

This is deliberate, not a placeholder to be embarrassed about:

- Geo enrichment stays **optional infrastructure**, never a hard runtime
  dependency for basic click tracking to work. With no provider
  configured, every analytics query still runs correctly — `country` /
  `region` / `city` breakdowns simply report everything under
  `"Unknown"`.
- No paid third-party GeoIP service (or its API key) is required just to
  record a click.
- No arbitrary HTTP request to a client-controlled URL is ever made —
  `lookup(ip)` takes the request's own server-observed IP, never a
  client-supplied URL or hostname.

**Adding a real provider later**: implement `GeoLocationProvider.lookup`
against `ip` and wire it into `buildTrackerApp`'s `geoLocationProvider`
option (`apps/tracker/src/app.ts`) in place of `NullGeoLocationProvider`.
The interface's `lookup` is `async` precisely because a real
implementation is expected to be a remote network call (e.g. a hosted geo
API) — `recordClick` never awaits it on the redirect path regardless (see
"Data enrichment strategy" below), so a slow or even occasionally-hanging
remote provider cannot add latency to a click. A local, file-backed
database lookup (e.g. MaxMind GeoLite2) is still a reasonable choice when
available, since it avoids depending on a third-party service's uptime,
but it is not required for latency safety the way it would be if the
lookup were on the critical path.

**Privacy note on the input**: `lookup` takes the request's raw,
transient IP — the same value used to compute `Click.ipHash` — because a
geo lookup from a one-way hash is fundamentally impossible (hashing
destroys exactly the structure a geo database indexes on). "Privacy-safe"
describes the *output*: the raw IP is used in memory for this one call and
discarded, exactly like `hashIp` already does; only the coarse
`GeoLocationResult` (country/region/city/timezone) is ever persisted, on
`Click`. No code path in this codebase writes a raw IP to the database.

## Data enrichment strategy: keeping the redirect hot path safe

Phase 3's redirect latency requirement is unchanged by Phase 4, and UA and
geo enrichment are treated very differently in
`apps/tracker/src/modules/tracker/tracker.service.ts#recordClick`
precisely because they carry different latency risk:

- **UA parsing is synchronous and stays on the critical path.**
  `safeParseUserAgent` wraps `UserAgentParser.parse` in a `try/catch` — the
  interface contract is "pure, synchronous, no I/O" (see
  `packages/shared/src/user-agent.ts`), so a throw here is a bug in the
  parser, not an expected failure mode, and it carries no latency risk
  worth deferring. Its result is written in the same transaction as the
  `Click`/`BotEvent` rows, before the redirect is sent.
- **Geo lookup is asynchronous and runs entirely off the critical path,
  by construction — not merely wrapped for failure isolation.** A real
  `GeoLocationProvider` is expected to be a network call once one is
  configured, so even a *successful* lookup could otherwise add
  unpredictable latency (slow DNS, a loaded remote API, a stalled TCP
  connection) directly to every click. `recordClick` does not `await`
  `GeoLocationProvider.lookup` at all before returning:
  1. The `Click` row is written (in the same transaction as `BotEvent`)
     with its geo fields left null.
  2. `recordClick` returns immediately after that write — this is what
     the redirect route handler awaits, and it resolves without ever
     touching the geo provider's promise.
  3. Only then does `enrichClickWithGeoInBackground` kick off
     `GeoLocationProvider.lookup`, unawaited, in the background. If/when
     it resolves with any non-null field, a follow-up `UPDATE` applies
     the geo data to the already-written `Click` row. A throw, a
     rejection, or a promise that never settles at all all resolve to
     "leave the geo fields null" — none of them can affect the response
     already sent to the client.
- **A failing UA parser still can't block the write**: its failure
  resolves to `UNKNOWN_DEVICE_INFO` inline, same as before.

Enrichment failure — of either kind — never prevents `Click`/`BotEvent`
from being written, and never prevents the redirect response from being
issued. Covered directly by
`apps/tracker/test/tracker.service.test.ts` (`recordClick` still writes a
`Click` row when the parser throws, when the geo provider throws
synchronously, when its returned promise rejects, when it never resolves
at all during the test, and confirms the background `UPDATE` still lands
once a slow provider does eventually resolve) and
`apps/tracker/test/tracker.routes.test.ts` ("enrichment failure isolation"
and "geo lookup latency isolation") at the HTTP level, asserting the `302`
redirect still fires — including a case where the geo provider's promise
is deliberately never resolved during the test, which would hang the test
itself if the redirect handler were waiting on it anywhere on its path.

`NullGeoLocationProvider` never performs a lookup at all, so the default
configuration adds no latency to the hot path whatsoever, and schedules no
background work either.

## Privacy model

- **No raw IP is ever stored** — unchanged from Phase 3. `RecordClickInput.ip`
  exists only as an in-memory, transient value passed to
  `GeoLocationProvider.lookup`; it is never written to any column.
- **`ipHash`, the raw IP, and any visitor fingerprint are never returned
  by an analytics endpoint.** Every response is an aggregate
  (`ClickSummary`/`ClickTimeseriesPoint`/`ClickBreakdownRow`) — none of
  these types carry a per-click identifier, `ipHash`, or fingerprint
  field. Covered by `apps/api/test/analytics.test.ts` ("privacy"), which
  asserts the full JSON body of every endpoint never contains `ipHash` or
  anything matching `/fingerprint/i`.
- **Bot-detection internals are not exposed beyond the existing
  classification.** Analytics surfaces `botClassification` (already
  user-facing via `Click`/`BotEvent`) and derived counts; it does not
  expose `BotEvent.reasonCodes` or `detectionSource` through any analytics
  endpoint.
- **No sensitive analytics data is logged.** Analytics service functions
  run parameterized SQL and return plain aggregate objects; nothing here
  introduces a new logging call, sensitive or otherwise.

## Relationship to bot detection

Phase 4 does not build a second bot detector. Every human/bot/suspicious/
unknown count reported by this module is a direct read of
`Click.botClassification`, exactly as Phase 3's `BotDetectionEngine`
wrote it (`docs/architecture/data-model.md#click-conversion-botevent--event-data`).
This module never writes to `botClassification`, never calls
`BotDetectionEngine`, and never influences Phase 3's routing/Safe-Page
behavior in any way — it is a pure downstream reader.

## Performance strategy

- **Every metric is a single PostgreSQL aggregation query.** Nothing in
  `apps/api/src/modules/analytics/analytics.service.ts` fetches `Click`
  rows into Node to aggregate in application memory — every function is
  one `$queryRaw` call using `COUNT(*)`, `COUNT(*) FILTER (WHERE ...)`,
  `COUNT(DISTINCT (...))`, and `date_trunc`, with `GROUP BY`/`ORDER BY`
  pushed down to Postgres.
- **`COUNT(*)`/`COUNT(DISTINCT ...)` results are explicitly cast with
  `::int`.** An uncast Postgres `bigint` deserializes through
  node-postgres/Prisma as a native JS `bigint`, which `JSON.stringify`
  cannot serialize (verified directly: an uncast `COUNT(*)` came back as
  `15n`, not `15`) — every count column in every query is cast to avoid
  this failing at the HTTP response layer.
- **Indexes.** `Click` carries `@@index([organizationId, occurredAt])`
  (Phase 1/3), plus two added in this phase:
  `@@index([trackingLinkId, occurredAt])` and
  `@@index([campaignId, occurredAt])` — chosen to match the actual filter
  shape every analytics query uses (`organizationId`/`campaignId`/
  `trackingLinkId` equality plus an `occurredAt` range), not added
  blindly across every column. `EXPLAIN` sanity is exercised in
  `apps/api/test/analytics.test.ts`, deliberately without asserting "must
  use an Index Scan" — Postgres's cost-based planner correctly prefers a
  Seq Scan over a tiny test-sized table regardless of index availability,
  so that assertion would be flaky/incorrect at test scale, not a
  meaningful correctness check.
- **Breakdown row cap.** `BREAKDOWN_ROW_LIMIT = 100` bounds worst-case
  response size and sort cost for an organization with an unusually high
  cardinality of distinct referrers/links/etc.
- **Date-range cap.** `MAX_ANALYTICS_RANGE_DAYS = 366` (enforced by
  validation, not just documented) bounds the worst-case scan range a
  single request can force.
- **No separate analytics database or warehouse.** PostgreSQL — the same
  database Phase 3 already writes to — remains the sole source of truth.
  No ClickHouse/BigQuery/similar dependency has been introduced.

### Future warehouse migration path

`apps/api/src/modules/analytics/analytics.service.ts` exposes typed
functions (`getClickSummary`, `getClickTimeseries`, `getClicksBy*`) with
stable return shapes (`ClickSummary`/`ClickTimeseriesPoint`/
`ClickBreakdownRow`) that `analytics.routes.ts` and the dashboard consume
without knowing anything about how they're computed. If click volume ever
outgrows single-table Postgres aggregation, the migration path is to
re-implement these same functions against a warehouse (e.g. querying a
replicated/streamed copy of `Click` in ClickHouse or BigQuery) behind the
same function signatures — the routes layer, the dashboard, and the
response shapes would not need to change. This is a design intent, not
something implemented in Phase 4.

## Known limitations

- **Unique-click counting is an estimate**, not a guarantee of distinct
  visitors — see "Unique click methodology" above for the specific
  under/over-counting cases this accepts.
- **No geo provider ships by default.** `country`/`region`/`city`/
  `timezone` (on `Click`) are `null` and report as `"Unknown"` in every
  breakdown unless an operator wires in a real `GeoLocationProvider`.
- **Geo enrichment is eventually consistent, not immediate.** Because the
  geo lookup runs in the background after the redirect (see "Data
  enrichment strategy" above), a `Click` row's `country`/`region`/`city`/
  `timezone` can briefly be `null` even with a real provider configured,
  until that provider's promise resolves and the follow-up `UPDATE` lands
  — typically milliseconds to low seconds after the click, but with no
  hard upper bound if the provider itself is slow. An analytics query run
  immediately after a click may undercount that click's geo breakdown by
  one row; querying again shortly after resolves it. There is no retry or
  dead-letter queue if the background update itself fails after the
  provider succeeds (e.g. a dropped DB connection) — that click's geo
  fields simply stay `null` permanently.
- **Referrer grouping is hostname-only and lossy by design** — path and
  query string are discarded at query time (not at write time — the raw
  `Click.referrer` is unchanged from Phase 3), and a referrer that fails
  to parse as a hostname-bearing URL is indistinguishable from "no
  referrer" in the `by-referrer` breakdown.
- **Breakdown endpoints cap at 100 rows** with no pagination — see
  "Performance strategy" above.
- **No caching layer.** Every request re-runs its aggregation query
  against live data; there is no materialized view, cache, or
  pre-aggregation. Acceptable at the click volumes this system currently
  handles; revisit if a specific endpoint becomes a hot path at higher
  volume.
- **This module does not implement, and makes no claim toward, Google
  Transparent Click Tracker certification** — see
  `docs/compliance/google-transparent-tracker.md` for the actual scope of
  that requirement, which Phase 4 does not touch.
