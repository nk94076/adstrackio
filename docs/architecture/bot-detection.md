# Bot Detection Integration (Phase 5)

## Status and scope

This document describes **Phase 5: Bot Detection Integration** — wiring
the existing `BotDetectionEngine` abstraction (originally scaffolded in
Phase 1, given its first real implementation in Phase 3) into the
production tracker routing decision, closing the gap where a `SUSPICIOUS`
or `UNKNOWN` verdict had no defined routing behavior at all.

This phase does **not** build a second, independent bot detector — the
single `BotDetectionEngine` interface
(`packages/shared/src/bot-detection.ts`) remains the sole source of truth
for classification, exactly as it was in Phase 3. It does **not** build
the full Rules & Routing Engine (Phase 8) — the routing-policy abstraction
introduced here (`BotTrafficPolicy`) answers exactly one question
(classification → routing action) and is designed to be replaced, not
extended, by Phase 8. It does **not** claim AI/ML-based detection,
100% bot detection, fraud-prevention certification, or Google Transparent
Click Tracker certification anywhere — none of those are true of this
implementation, and this document says so explicitly rather than
implying otherwise.

## What existed before this phase (audit summary)

Before Phase 5, `apps/tracker` had:

- A `BotDetectionEngine` interface already defined and already wired into
  the redirect route (Phase 3) — `HeuristicBotDetectionEngine`, a small
  User-Agent regex/substring match against ~24 known bot/crawler/tool
  signatures, plus "empty User-Agent → BOT." Explicitly labeled
  provisional/placeholder in its own file header and in
  `docs/compliance/google-transparent-tracker.md`.
- An input type (`BotClassificationInput`, since renamed to
  `BotDetectionInput`) that only ever carried `userAgent` in practice —
  `ipHash` and `requestMetadata` existed on the type but the engine never
  read either.
- An output type (`BotClassificationResult`) whose `classification` field
  already supported all four `BotClassification` values (`HUMAN`, `BOT`,
  `SUSPICIOUS`, `UNKNOWN`), but the engine itself only ever produced
  `HUMAN` or `BOT` — never `SUSPICIOUS` or `UNKNOWN`.
- A routing decision in `tracker.routes.ts` of the form `if
  (classification === "BOT") { safePage } else { transparent
  destination }` — meaning any classification that wasn't the literal
  string `"BOT"`, including a hypothetical `SUSPICIOUS`/`UNKNOWN`, fell
  through to the transparent destination exactly like `HUMAN`. This was a
  real, if latent, gap: nothing had ever exercised it, since the engine
  never produced those values.
- No wrapping around the `classify()` call — a throw would propagate as an
  unhandled rejection and fail the whole redirect with a `500`, rather
  than degrading safely the way UA parsing and geo lookup already did
  (Phase 4).
- `Click.botClassification`/`Click.botScore` and `BotEvent` already
  correctly persisted whatever the engine produced, and Phase 4's
  analytics aggregation (`CLASSIFICATION_AGGREGATES` in
  `apps/api/src/modules/analytics/analytics.service.ts`) already counted
  all four classifications — this machinery needed no changes, only real
  data flowing through it (see "Analytics compatibility" below).

Phase 5's job was closing these gaps without redesigning what already
worked.

## Detection architecture

```
Request
  ↓
Transparent redirect validation (Phase 3, unchanged)
  ↓
Tracking domain/link resolution (Phase 3, unchanged — now also returns
the campaign's BotTrafficPolicy)
  ↓
Bot detection — classifyWithSafeFallback(BotDetectionEngine, input)
  ↓
Classification (HUMAN / BOT / SUSPICIOUS / UNKNOWN)
  ↓
resolveBotRoutingAction(classification, campaign's BotTrafficPolicy)
  ├── SAFE_PAGE → Campaign.safePageUrl, or a controlled 404 if unset
  ├── TARGET    → the request's own validated redirection_url
  └── BLOCK     → a controlled 404 (never a guessed destination)
  ↓
Click + BotEvent logging (unchanged schema, now exercising SUSPICIOUS/
UNKNOWN in practice)
  ↓
Analytics (Phase 4, unchanged query logic)
```

### The detection engine remains the single source of truth

`BotDetectionEngine.classify()` (`packages/shared/src/bot-detection.ts`)
is the only place a classification is computed. `tracker.routes.ts` never
inspects the request itself to second-guess or override the engine's
verdict — it only maps whatever the engine (via the safe-fallback
wrapper) returns through `resolveBotRoutingAction`. This is a hard
architectural rule, not just a convention: there is no second detector,
heuristic, or override path anywhere in the routing logic.

### `HeuristicBotDetectionEngine` — still explicitly provisional/heuristic

The concrete engine wired in by default
(`apps/tracker/src/modules/bot-detection/heuristic-bot-detection-engine.ts`)
is a **multi-signal, weighted-scoring heuristic** — a meaningfully more
capable implementation of the same interface, but still explicitly
**PROVISIONAL / HEURISTIC**, not a production-grade or ML-based detector.
It will misclassify real traffic in both directions under adversarial
conditions: a careful script can replicate every signal checked here, and
a real browser behind an unusual proxy/extension setup can trip the
header-consistency signal. Nothing in this codebase claims otherwise.

#### Signals used

All signals are computed entirely from server-observed request data —
the `User-Agent` header and a small, explicit set of other headers
(`packages/shared/src/bot-detection.ts`'s `BotDetectionHeaderSignals`:
`accept`, `acceptLanguage`, `secFetchMode`, `secFetchSite`,
`secFetchDest`). Nothing else — no full raw header dump, no cookies, no
client-supplied classification/score/reason field of any kind can
influence the score.

| Signal | Weight | Reason code |
| --- | --- | --- |
| Missing/empty/whitespace-only User-Agent | deterministic (score 1, BOT) | `missing_user_agent` |
| Known crawler/SEO/monitoring-bot UA (Googlebot, Bingbot, AhrefsBot, etc.) | 0.9 | `known_crawler_user_agent` |
| Known non-browser HTTP client UA (curl, wget, python-requests, okhttp, Scrapy, etc.) | 0.9 | `known_http_client_user_agent` |
| Known headless/automation-runtime UA (HeadlessChrome, PhantomJS, Puppeteer, Playwright, Selenium) | 0.9 | `known_headless_browser_user_agent` |
| UA claims to be a mainstream browser (Chrome/Firefox/Safari/Edge/Opera) but no `Sec-Fetch-*` header is present | 0.35 | `missing_sec_fetch_headers_on_browser_ua` |
| `Accept` header completely absent | 0.2 | `missing_accept_header` |
| `Accept-Language` header completely absent | 0.15 | `missing_accept_language_header` |

Rationale for the header-consistency signal: every mainstream browser has
sent `Sec-Fetch-*` headers on top-level navigations by default since
~2021, and always sends `Accept`/`Accept-Language`. A script that spoofs
a browser's User-Agent string but doesn't replicate its full header set
is a genuine, if soft, sign the "browser" isn't one. It never fires for a
UA that isn't claiming to be a mainstream browser in the first place — an
unrecognized custom UA with no headers only accumulates the two generic
missing-header signals, keeping the false-positive risk for legitimate
non-browser clients (in-app browsers, unusual but real integrations) low.

#### Scoring and thresholds

Individual signal weights sum (clamped to a maximum of 1) into a single
`score`, which then maps to a classification:

| Score | Classification |
| --- | --- |
| ≥ 0.75 | `BOT` |
| ≥ 0.35 and < 0.75 | `SUSPICIOUS` |
| > 0 and < 0.35 | `UNKNOWN` |
| exactly 0 | `HUMAN` |

Any single "known automation" signal (0.9) alone crosses the `BOT`
threshold regardless of what else is present — this preserves the
pre-Phase-5 behavior that a known-bot UA is always `BOT`, even set
against a fully browser-consistent header set (a "conflicting signals"
case covered directly by
`apps/tracker/src/modules/bot-detection/heuristic-bot-detection-engine.test.ts`).
The two weak header signals only cross into `SUSPICIOUS`/`UNKNOWN`
territory in combination or alongside the stronger header-consistency
signal — a single missing `Accept-Language` header alone, for instance,
is `UNKNOWN` (0.15), not `SUSPICIOUS`.

`reasonCodes` always lists every signal that fired (not just the
dominant one), and `detectionSource` is `"tracker-heuristic-placeholder"`
for a real classification, or `"tracker-fallback"` for a safe-fallback
result (see "Failure handling" below) — both are internal, never exposed
through the analytics API (see "Privacy" below).

#### Avoiding false positives

The scoring model is deliberately conservative in the human direction:
a real browser sending a normal, unmodified request scores exactly 0 and
is always `HUMAN`. An unrecognized custom User-Agent (e.g. an in-app
browser with its own UA string) with a full, consistent header set is
also `HUMAN` — it is never penalized merely for not matching a known
browser or bot pattern. Only actual evidence (a known-automation UA
match, or the absence of headers a real browser reliably sends) moves a
request off `HUMAN`, and insufficient evidence resolves to `UNKNOWN` or
`SUSPICIOUS`, never a forced `BOT` verdict.

### Detection input

`BotDetectionInput` (`packages/shared/src/bot-detection.ts`, renamed from
`BotClassificationInput` for clarity — matching the "input to detection"
vs. "result of classification" distinction):

```ts
interface BotDetectionHeaderSignals {
  accept?: string;
  acceptLanguage?: string;
  secFetchMode?: string;
  secFetchSite?: string;
  secFetchDest?: string;
}

interface BotDetectionInput {
  clickId: string;
  userAgent?: string;
  ipHash?: string;              // one-way hash; unused by the current engine
  headers?: BotDetectionHeaderSignals;
  requestMetadata?: Record<string, unknown>;
}
```

Nothing beyond this whitelist reaches the engine. In particular:

- **No raw IP.** `ipHash` is the same one-way, salted hash already used
  for `Click.ipHash` (`packages/shared/src/ip-hash.ts`) — the current
  engine doesn't use it at all, kept only as a forward-compatible input
  for a future IP-reputation-style signal that would still never need the
  raw address.
- **No full raw header dump.** Only the five explicitly named header
  values are extracted (`extractDetectionHeaderSignals` in
  `apps/tracker/src/modules/tracker/tracker.routes.ts`) — arbitrary
  client-supplied headers (e.g. `X-Bot-Override: false`) are never read
  by the detection path at all, proven by a dedicated test
  ("arbitrary client-supplied headers outside the allowed detection set
  have no effect on classification").
- **No client-provided classification/score/reason input of any kind.**
  `requestMetadata` exists on the type (a Phase 3 holdover) but no code
  path ever populates it from request data, and even if a caller passed
  one, the engine's own scoring logic never reads it — proven directly by
  a "conflicting signals" test that passes `requestMetadata: { isBot:
  false, classification: "HUMAN", score: 0 }` alongside a known-bot UA
  and asserts the result is still `BOT`.
- **HTTP method is not a detection input.** The tracker route only ever
  registers `GET /:slug` — there is no other method to distinguish, so
  including it would carry zero information; noted here rather than
  added as a dead field.

## Classification policy — `BotTrafficPolicy`

A small, explicit routing-policy abstraction
(`packages/shared/src/bot-traffic-policy.ts`) — deliberately **not** the
full Rules & Routing Engine (Phase 8). It answers exactly one question:
given a classification and a campaign's configured policy, where does
this request go?

```ts
type BotTrafficPolicyAction = "SAFE_PAGE" | "TARGET" | "BLOCK";

interface BotTrafficPolicy {
  suspiciousTrafficPolicy: BotTrafficPolicyAction;
  unknownTrafficPolicy: BotTrafficPolicyAction;
}

function resolveBotRoutingAction(
  classification: BotClassification,
  policy: BotTrafficPolicy,
): BotTrafficPolicyAction;
```

`BOT` and `HUMAN` are **not configurable** — `resolveBotRoutingAction`
hardcodes `BOT → SAFE_PAGE` and `HUMAN → TARGET`. Only `SUSPICIOUS` and
`UNKNOWN` read from the campaign's own policy, stored as
`Campaign.suspiciousTrafficPolicy` / `Campaign.unknownTrafficPolicy`
(Prisma enum `BotTrafficPolicyAction`, migration
`20260902113901_bot_detection_traffic_policy`). This function is pure and
synchronous — no I/O — so it's always safe on the hot path.

**Default: `TARGET` for both.** This is the same behavior every campaign
implicitly had before this field existed — the pre-Phase-5 engine never
produced `SUSPICIOUS`/`UNKNOWN` at all, so every non-`BOT` verdict was
routed to the transparent destination. The migration backfills every
existing campaign with this explicit default (`NOT NULL DEFAULT
'TARGET'`), so no campaign's traffic pattern changes the moment Phase 5
deploys — see "Known limitations" for what does change (real `SUSPICIOUS`/
`UNKNOWN` verdicts now occur, whereas before they structurally could not).

### Routing actions

| Action | Behavior |
| --- | --- |
| `SAFE_PAGE` | Redirect to `Campaign.safePageUrl` if configured; otherwise a controlled `404` (never a guessed destination, never a fallback to the transparent one). |
| `TARGET` | Redirect to the request's own validated `redirection_url` — identical to how `HUMAN` traffic is always routed. |
| `BLOCK` | A controlled `404` — same response shape as "`SAFE_PAGE` but none configured." Never falls back to `TARGET`, `SAFE_PAGE`, or any other destination, even when a Safe Page *is* configured — proven by a dedicated test. |

Why a campaign might choose differently for `SUSPICIOUS`/`UNKNOWN`: a
lead-gen campaign paying for guaranteed real humans might set `BLOCK` to
avoid paying for anything not confidently `HUMAN`; a display/awareness
campaign might keep `TARGET` to avoid losing any borderline-legitimate
traffic; a campaign that wants ambiguous traffic funneled to a holding
page might set `SAFE_PAGE`. This phase makes the choice explicit and
per-campaign rather than making it silently for everyone.

## Safe Page security

Unchanged from Phase 3, re-verified explicitly for Phase 5's new routing
paths:

- `Campaign.safePageUrl` is validated server-side at creation/update time
  using the same admin-configured-URL validator as `Destination`
  (`normalizeSafePageUrlOrThrow` in
  `apps/api/src/modules/campaigns/campaigns.service.ts`, wrapping
  `normalizeDestinationUrl`).
- The tracker route never reads a Safe Page URL, or anything that could
  select one, from the request — not from `redirection_url`, not from any
  query parameter, not from any header. It is always
  `resolution.safePageUrl`, sourced from `link.campaign.safePageUrl` via
  `TrackingResolver`.
- Regression tests prove this explicitly for every classification whose
  policy can resolve to `SAFE_PAGE`: `BOT` (always), and `SUSPICIOUS`/
  `UNKNOWN` when configured with a `SAFE_PAGE` policy — each asserts that
  an attacker-controlled `redirection_url`
  (`https://attacker.example/phish`) never appears in the response's
  `Location` header, and that a request carrying
  `isBot=false&bot=false&classification=HUMAN&score=0&safePageUrl=...`
  query parameters still resolves to the campaign's real, stored Safe
  Page — none of those parameters are ever read by any code path.

## Failure handling

Bot detection sits on the tracker's hot path, and — unlike geo enrichment
(Phase 4, which can safely run in the background) — its result gates the
routing decision itself, so it cannot simply be deferred. Both failure
modes below resolve to a safe fallback via
`classifyWithSafeFallback`
(`apps/tracker/src/modules/bot-detection/classify-with-fallback.ts`)
rather than propagating:

- **Throw or rejected promise.** A bug in the engine, or — for a future
  network-backed engine — a connection error.
- **Timeout (50ms).** The current `HeuristicBotDetectionEngine` is fully
  synchronous/local and will never hit this in practice, but the guard
  costs nothing on that path and protects against a future engine that
  hangs instead of rejecting — a hang would otherwise stall the redirect
  indefinitely, which is worse than a crash. Implemented with
  `Promise.race`-style timer logic (not a real network timeout), proven
  by a dedicated test using an engine whose promise never settles.

**The fallback classification is `UNKNOWN`, not `HUMAN` or `BOT`.** A
detection failure is not evidence of humanity (never trust that) and not
evidence of automation either (never guess `BOT` without a real signal)
— it's exactly what `UNKNOWN` means, and it's routed through the
campaign's own configured `unknownTrafficPolicy` like any other `UNKNOWN`
verdict, not a special case. `reasonCodes` records which failure mode
occurred (`detection_engine_failure` or `detection_engine_timeout`) and
`detectionSource` is `"tracker-fallback"`, both persisted to `BotEvent`
like any other detection result.

Both failure modes are covered end-to-end: unit tests against
`classifyWithSafeFallback` directly, and HTTP-level tests against the
full tracker route asserting the redirect still completes (bounded, not
hanging) and the persisted `Click`/`BotEvent` reflect the fallback
classification and reason code.

### Cancellation: the timeout actually cancels, it doesn't just stop waiting

A naive timeout that merely stops *waiting* on `engine.classify()` would
still leave that call's promise — and whatever produced it: a socket, an
in-flight HTTP request, a worker — running in the background after the
redirect has already been served. For the current synchronous
`HeuristicBotDetectionEngine` this is harmless (there's no real operation
to leave running), but the whole point of `BotDetectionEngine` is to be
swappable for a future network-backed detector, and under sustained high
traffic against a slow or hanging remote provider, "the timeout fires but
the underlying call keeps running" accumulates unbounded outstanding
work even though every individual redirect still completes on time — a
genuine resource-exhaustion risk (sockets, memory, provider-side
concurrency limits).

So `classifyWithSafeFallback` is cancellation-aware, not just
time-bounded:

```ts
interface BotDetectionInput {
  // ...
  signal?: AbortSignal;
}
```

- `classifyWithSafeFallback` creates one `AbortController` per call and
  passes `controller.signal` into `engine.classify()` as part of the
  input.
- If the 50ms timeout fires, it calls `controller.abort()` **before**
  resolving with the fallback `UNKNOWN` result — the signal is guaranteed
  aborted by the time the caller sees the timeout outcome.
- `controller.abort()` is called **only** on timeout — never on a normal
  resolution or an engine-thrown/rejected error, both of which have
  already settled on their own with nothing left to cancel.

**This places a contract on any future engine, not just an optional
courtesy:** an engine that performs real asynchronous work — a `fetch` to
an external bot-intelligence provider, a worker thread, a queued job —
**MUST** observe `input.signal` and actually cancel/tear down that
underlying operation when it fires (e.g. pass the signal straight through
to `fetch`'s own `signal` option, or otherwise abort the in-flight
request). Merely ignoring the signal and letting the operation run to
completion in the background defeats the purpose and reintroduces the
resource-exhaustion risk this exists to prevent.

`HeuristicBotDetectionEngine` accepts `signal` (it's part of
`BotDetectionInput`, which it must type against) but never reads it —
documented explicitly in its own file as deliberate, not an oversight:
every signal it computes is a synchronous regex/property check with
nothing to cancel, so adding a listener would be artificial async
plumbing wired to nothing real.

Covered by dedicated tests: the timeout path aborts the signal it handed
to the engine; a fake "well-behaved async engine" that listens for
`abort` and only then settles is confirmed to actually receive the
event; a synchronous throw does *not* abort the signal (nothing to
cancel); and the pre-existing never-resolving-engine test still proves
the HTTP redirect completes on time regardless of what the engine does
with the signal afterward.

## Analytics compatibility

Phase 4's analytics aggregation
(`apps/api/src/modules/analytics/analytics.service.ts`) required **no
changes** — `CLASSIFICATION_AGGREGATES` already counted all four
`BotClassification` values via `COUNT(*) FILTER (WHERE
"botClassification" = ...)`, and `botPercentage` was already computed as
bot-of-total only. What Phase 5 changes is that `SUSPICIOUS`/`UNKNOWN`
rows can now actually occur in practice (previously the detection engine
never emitted them, so those code paths, while present, were never
exercised by production-shaped data). A dedicated test
(`apps/api/test/analytics.test.ts`, "correctly counts SUSPICIOUS and
UNKNOWN classifications alongside HUMAN/BOT") seeds all four
classifications and confirms `totalClicks`, `humanClicks`, `botClicks`,
`suspiciousClicks`, `unknownClicks`, and `botPercentage` are all correct
together — not just individually plausible.

No raw IP, `ipHash`, or visitor fingerprint is exposed by this phase —
unchanged from Phase 4's privacy model.

## Privacy

- **`BotEvent.reasonCodes` and `BotEvent.detectionSource` are internal.**
  They are persisted (as they were before Phase 5) but are **not**
  exposed through any analytics endpoint — Phase 4's analytics API
  surfaces only the four classification counts and derived
  `botPercentage`, never per-click reason codes or detection source.
  Exposing them would require an explicit future admin/debug API, which
  this phase does not add.
- **No new personal data is collected.** The additional detection inputs
  (`Accept`, `Accept-Language`, `Sec-Fetch-*`) are ordinary, non-sensitive
  request headers already sent by every browser on every request to every
  website; none are stored — they're read from the live request,
  used to compute a score, and discarded. Nothing here changes what
  `Click`/`BotEvent` persist (still no raw IP, still only the one-way
  `ipHash`).
- **No externally observable behavior change to what's logged.** Server
  logs already recorded `classification`/`reasonCodes` per request
  (Phase 3); this phase adds `routingAction` to that same log line for
  operational visibility, nothing more sensitive.

## Performance

- **No network calls on the default path.** `HeuristicBotDetectionEngine`
  is fully synchronous/local — every signal is a regex test or an
  object-property check against data already in memory from the request.
- **No database query per click for detection itself.** The routing
  *policy* (`suspiciousTrafficPolicy`/`unknownTrafficPolicy`) piggybacks
  on the existing `TrackingResolver.resolve()` call
  (`PrismaTrackingResolver` already joins `Campaign` to read
  `safePageUrl`; the two policy columns are read in that same query, not
  a new one) — no additional round trip.
- **Bounded worst case.** The 50ms timeout in `classifyWithSafeFallback`
  caps how long a hypothetical slow/hanging engine could ever add to a
  single request; the synchronous engine shipped today never approaches
  it.
- **No synchronous heavy computation.** Every signal is O(1) or O(number
  of known-pattern regexes) — a small, fixed, in-memory list — never a
  model inference, external call, or unbounded loop.
- **Detection failure/timeout never crashes the process** — see "Failure
  handling" above; both paths return a value, never throw out of
  `classifyWithSafeFallback`.

No formal load-testing benchmark was run for this phase; the performance
claims above are architectural (no I/O, no unbounded work, bounded
timeout), not measured throughput numbers, and should be read as such.

## Rate limiting / abuse considerations

**Unchanged from Phase 3: `apps/tracker` still has no request rate
limiting.** This was already documented as a deliberate deferral (real
ad-click traffic can legitimately arrive in high-volume bursts from a
shared egress IP — corporate NAT, mobile carrier CGNAT — and a naive
per-IP limit risks dropping real clicks more than it stops abuse; see
`apps/tracker/src/plugins/security.ts` and
`docs/architecture/security.md`). Phase 5 does not change this and does
not introduce a rate limiter — doing so was explicitly out of scope for
this phase ("do not silently introduce an unrelated large infrastructure
change").

**Extension point, if a future phase adds one:** `apps/api` already uses
`@fastify/rate-limit` (`apps/api/src/plugins/security.ts`); the same
package could be registered in `apps/tracker/src/plugins/security.ts`
following that precedent. The natural point to make it bot-detection-aware
would be applying a stricter limit specifically to requests the detection
engine classifies as `BOT`/`SUSPICIOUS` (available in `tracker.routes.ts`
right after the classification step, before the routing decision) rather
than a blanket per-IP limit that risks the same false-positive problem on
legitimate bursty traffic. Not implemented here.

## Data model changes

Migration `20260902113901_bot_detection_traffic_policy` — backward
compatible, no data loss, no table added:

```sql
CREATE TYPE "BotTrafficPolicyAction" AS ENUM ('SAFE_PAGE', 'TARGET', 'BLOCK');

ALTER TABLE "campaigns"
  ADD COLUMN "suspiciousTrafficPolicy" "BotTrafficPolicyAction" NOT NULL DEFAULT 'TARGET',
  ADD COLUMN "unknownTrafficPolicy" "BotTrafficPolicyAction" NOT NULL DEFAULT 'TARGET';
```

Both columns are `NOT NULL DEFAULT 'TARGET'`, so every existing campaign
receives an explicit, safe, backward-compatible value at migration time
— not a nullable column requiring null-handling everywhere it's read.
No other schema changes were needed: `Click.botClassification`/
`Click.botScore` and the `BotEvent` model already supported everything
Phase 5 required.

## API / dashboard changes

Deliberately minimal — no bot-management dashboard was built:

- `POST`/`PATCH .../campaigns` (`packages/validation/src/campaigns.ts`,
  `apps/api/src/modules/campaigns/campaigns.service.ts`) now accept
  `suspiciousTrafficPolicy`/`unknownTrafficPolicy` (validated against the
  `BotTrafficPolicyAction` enum), defaulting to `TARGET` on create and
  left untouched on update when omitted.
- The dashboard's `/campaigns` page (`apps/dashboard/src/app/campaigns/page.tsx`)
  gained a Safe Page URL input and two policy `<select>` dropdowns on the
  create-campaign form, and a compact "Bot policy (SUS / UNK)" column on
  the campaigns table. There is no dedicated bot-detection or
  bot-analytics dashboard, and no edit form for existing campaigns beyond
  what already existed (the dashboard has no campaign-edit UI for any
  field yet — this is an existing gap, not new to this phase).

## Google Transparent Click Tracker: no change to the transparency architecture

Phase 5 does not change Phase 3's core transparency commitment: the
immediate next hop remains the request's own visible `redirection_url`,
and the tracker still never resolves or substitutes a hidden backend
destination for `TARGET`-routed traffic (which includes all `HUMAN`
traffic, always). Bot detection decides *whether* a request is routed to
the Safe Page/blocked instead — a decision that was already part of the
Phase 3 architecture and already documented as compliant
(`docs/compliance/google-transparent-tracker.md`) — Phase 5 only makes
that decision configurable for the two ambiguous verdicts and closes the
gap where they had no defined behavior. No certification of any kind is
claimed by this document or this implementation.

## Known limitations

- **Still a heuristic, not a production-grade or ML-based detector.**
  See "Detection architecture" above. A sufficiently careful adversary
  can evade every signal checked here.
- **No IP-reputation or external bot-intelligence signal.** The input
  type has room for one (`ipHash`, forward-compatible), but none is
  implemented — deliberately, to keep this phase focused on local,
  deterministic, zero-network-dependency signals. A future phase adding
  one must give it an explicit timeout and safe-degradation behavior
  (the same pattern `classifyWithSafeFallback` already establishes),
  must actually honor `BotDetectionInput.signal` and cancel its
  underlying request/connection when aborted rather than merely ignoring
  the signal (see "Cancellation" above), and must never let its
  unavailability become a redirect outage.
- **No tracker-level rate limiting.** See "Rate limiting / abuse
  considerations" above — unchanged from Phase 3, an extension point is
  documented, not implemented.
- **`SUSPICIOUS`/`UNKNOWN` policy is per-campaign only, not per-rule.**
  There is no way to combine bot-traffic policy with other conditions
  (geo, device, time of day, etc.) — that is exactly Phase 8's job, and
  this abstraction is deliberately shaped so Phase 8 can replace
  `resolveBotRoutingAction`'s call site with a richer resolver without
  touching the tracker route's control flow around it.
- **The header-consistency signal can false-positive on unusual but
  legitimate setups** — a real browser behind certain privacy-focused
  configurations, corporate proxies, or older browser versions that
  predate `Sec-Fetch-*` header support could score as `SUSPICIOUS`. With
  the default `TARGET` policy this has no effect on real users (still
  routed to the destination); it only matters for campaigns that opt into
  a stricter `SAFE_PAGE`/`BLOCK` policy for `SUSPICIOUS` traffic.
- **No load-testing benchmark was run.** Performance claims in this
  document are architectural, not measured.
- **No AI/ML detection, no fraud-prevention certification, no Google
  Transparent Click Tracker certification** — none of these are
  implemented or claimed by this phase.
