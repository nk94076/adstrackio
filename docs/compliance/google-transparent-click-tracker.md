# Google Transparent Click Tracker — Certification Readiness

## Status

**AdstrackIO has not applied for, and does not hold, Google Transparent
Click Tracker certification.** Nothing in this document, or anywhere else
in this codebase, should be read as a claim that Google has certified,
approved, or verified this system. This document describes what has been
built and prepared for submission — "certification readiness," "prepared
for submission," and "designed to satisfy the documented transparency
requirements" are the only characterizations used here. The actual
certification decision is Google's, made through a manual review process
this document cannot substitute for.

This document is the certification-submission-oriented companion to
`docs/compliance/google-transparent-tracker.md` (the original architecture
decision record from Phase 3, which this document does not duplicate —
see it for the full historical rationale) and
`docs/compliance/redirect-audit.md` (the line-by-line audit of every
redirect-shaped code path in this repository, produced by re-reading the
entire codebase for Phase 12). See also
`docs/compliance/google-certification-checklist.md` for the submission
checklist and evidence list.

## 1. Architecture overview

AdstrackIO's tracker (`apps/tracker`) is a single-purpose Fastify service,
deployed and scaled independently from the API (`apps/api`) and dashboard
(`apps/dashboard`). Its only job is:

```
GET /:slug?redirection_url=<visible destination>
    -> resolve (hostname, slug) to a verified, active tracking link
    -> validate redirection_url
    -> classify the request (human / bot / suspicious / unknown)
    -> record a Click
    -> respond with an HTTP redirect
```

The tracker never renders HTML, never serves the destination content
itself, and never makes an outbound network request to the destination.
The only action it takes as a result of a request is writing one database
row (the `Click`, plus a `BotEvent`) and returning an HTTP redirect
response.

## 2. Transparent redirect flow

```
https://tracker.example.com/abc?redirection_url=https://advertiser.example.com/landing
```

Flow:

```
Google Ads (or any ad network / affiliate link)
  |
  v
AdstrackIO tracker: GET /abc?redirection_url=https://advertiser.example.com/landing
  |
  v
HTTP 302, Location: https://advertiser.example.com/landing
  |
  v
Advertiser landing page (the browser navigates here directly)
```

There is no intermediate hop between the tracker and the advertiser's
page. The `Location` header the tracker returns **is** the final
destination the ad pointed at — not another AdstrackIO URL, not a second
redirect, not a resolved backend ID.

## 3. Destination transparency

The immediate next hop is explicitly represented by the `redirection_url`
query parameter — plainly visible in the URL itself, not hidden behind an
opaque link ID that only AdstrackIO's own database can resolve.

Concretely, in `apps/tracker/src/modules/tracker/tracker.routes.ts`:

1. `redirection_url` is read from the query string and validated by a
   single canonical parser, `validateTransparentRedirectUrl`
   (`packages/shared/src/transparent-redirect.ts`) — this happens
   **before** the tracking link is even resolved, so a missing or invalid
   `redirection_url` never depends on, or reveals anything about, whether
   the slug exists.
2. The tracker redirects to the **exact string that validator returns**.
   The same parsed `URL` object that validated the input is what gets
   serialized into the `Location` header — there is no second parse, no
   re-derivation, and no path where two different parsers could disagree
   about what the "real" destination is.
3. `TrackingLink.destinationId` (and the `Destination` row it points to)
   is **never read by the redirect decision**. `PrismaTrackingResolver`
   (`apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts`) does
   not even select `destinationId` from the database — it is
   administrative/reporting metadata only. There is no code path in
   `apps/tracker` where a stored `Destination` value can override, augment,
   or silently replace `redirection_url`.
4. A missing `redirection_url` returns `400` — it never falls back to any
   stored value.
5. Query parameters, path, and fragment on the destination URL are
   preserved exactly (`URL.toString()` on the same parsed object used for
   validation) — the tracker does not rewrite, strip, or reorder any part
   of the destination.

## 4. Domain ownership and verification

A `TrackingDomain` must have `verificationStatus = VERIFIED` (a real DNS
TXT-record check performed server-side — see `docs/architecture/domain-manager.md`
if present, or Phase 2's implementation in `apps/api/src/modules/domains`)
**and** `isActive = true` before the tracker will resolve any request
against it. Both conditions are re-checked on every request (not cached),
and both are additionally enforced at the database level by a Postgres
`CHECK` constraint (`tracking_domains_active_requires_verified`) — an
`isActive = true` row with `verificationStatus != VERIFIED` cannot exist,
even via a raw SQL statement that bypasses the application entirely.

An unknown hostname, an unverified domain, and an inactive domain all
return the same `404` — deliberately uninformative, so an anonymous
caller cannot use response differences to enumerate which hostnames are
registered in the system.

## 5. Bot handling

Classification (`HUMAN` / `BOT` / `SUSPICIOUS` / `UNKNOWN`) is computed
entirely server-side by the existing Phase 5 `BotDetectionEngine`
interface, from the request's own `User-Agent` header and a small,
explicit whitelist of other headers (`Accept`, `Accept-Language`, and the
three `Sec-Fetch-*` headers) — no request parameter can assert its own
bot/human status, override the classifier's score, or supply its own
reason codes (see `apps/tracker/test/tracker.routes.test.ts`'s "malicious/
conflicting headers" test group).

Routing precedence (`packages/shared/src/routing-rules.ts`'s
`resolveRoutingDecision`):

1. **`BOT` is always routed to the campaign's Safe Page** (`Campaign.safePageUrl`).
   This is hard-coded, non-configurable, and never subject to a routing
   rule. If no Safe Page is configured, the response is a controlled `404`
   — never a fallback to the visible `redirection_url`, and never a
   guess.
2. **`SUSPICIOUS`/`UNKNOWN`** follow the campaign's own configured policy
   (`suspiciousTrafficPolicy`/`unknownTrafficPolicy`: `TARGET`,
   `SAFE_PAGE`, or `BLOCK` — defaulting to `TARGET`, unchanged behavior
   from before these fields existed) and, for a `TARGET` outcome, are
   further subject to routing rules (see §6).
3. **`HUMAN` always reaches the visible `redirection_url`**, subject only
   to a matching, campaign-scoped routing rule (see §6) — never the Safe
   Page.

What gets logged: every resolved request writes one `Click` row (with a
denormalized `botClassification`/`botScore` snapshot) and one `BotEvent`
row (the classification's system of record, including `reasonCodes` and
`detectionSource`) — see §7 for exactly what fields these carry.

Because a genuine Google crawler and a genuine human visitor both present
as `HUMAN` to this classifier when they browse normally (the classifier
has no special-case logic keyed on "is this a known search-engine
crawler" at all — see `HeuristicBotDetectionEngine`), there is no
mechanism here that could route "Google's reviewer" to a different
destination than "a normal user." The only traffic ever routed away from
the visible destination is traffic this system's own heuristic classifies
as automated/`BOT`, using the same criteria for every caller.

## 6. Routing

Phase 8's routing rules are campaign-scoped, priority-ordered, and can
only ever resolve to one of the same three outcomes the bot-traffic policy
already used: `TARGET` (follow the request's own `redirection_url` — a
rule can never name its own destination URL), `SAFE_PAGE` (the campaign's
configured Safe Page), or `BLOCK` (a controlled `404`). A rule's
conditions may reference the bot classification, device type, browser,
OS, referrer host, or country — country only when the request is proven
(via a constant-time comparison against a server-configured
`TRUSTED_EDGE_SECRET`) to have passed through a trusted CDN/edge that
injects the geo header; with no secret configured (the default), `COUNTRY`
never matches for any request regardless of what geo headers it carries,
so a client cannot forge trust simply by sending one.

No routing rule can introduce a destination that isn't already one of
these three uniform outcomes. There is no way to configure a rule that
sends a subset of traffic to a fourth, arbitrary URL — this is what keeps
routing rules from becoming a hidden-redirect mechanism.

## 7. Click logging

Each resolved request writes one `Click` row containing: an
internally-generated id (a `crypto.randomUUID()`, never appended to the
outward redirect URL), organization/campaign/tracking-link identifiers, a
**salted one-way hash of the IP address** (the raw IP is never stored —
`packages/shared/src/ip-hash.ts`), the `User-Agent` and `Referer` header
values, parsed device/browser/OS fields, geo fields (populated
asynchronously in the background, after the redirect has already been
sent — see §9), the bot classification/score, and — if the resolving
tracking link is attributed to an affiliate partner — that partner's id
(see §8). Nothing about the destination or Safe Page is written into the
`Click` row differently than described in §3/§5.

## 8. Attribution

A `Conversion` is always attributed through the `Click` it references
(`Conversion.clickId`) — never through a client-supplied
`campaignId`/`trackingLinkId`/`affiliatePartnerId`. The public conversion-
creation schema (`packages/validation/src/conversions.ts`) has no such
fields at all; a client cannot supply them even if it tries; there is no
code path where any of these three identifiers are trusted from an
external caller.

Affiliate-partner attribution specifically: `TrackingLink.affiliatePartnerId`
(a plain foreign key, set only by an authenticated organization member
managing their own tracking links) is copied to `Click.affiliatePartnerId`
at write time and is immutable afterward (enforced by a Postgres trigger,
not just application code). This attribution is recorded for internal
reporting only — it has no effect on which destination a request is
redirected to, and `BOT` traffic through an affiliate-attributed link
still routes to the Safe Page exactly as it would through a non-affiliate
link (see `apps/tracker/test/tracker.routes.test.ts`'s affiliate-partner
test group).

`ReferralConfiguration` (Phase 1) is a separate, unrelated concept: it
controls how AdstrackIO's own internal reporting labels traffic
(referrer-attribution bookkeeping), and is not read by `apps/tracker` at
all — it has zero effect on redirect behavior, the `Location` header, or
any outbound HTTP request. A `CUSTOM_PARTNER_ATTRIBUTION` configuration
additionally cannot become `ACTIVE` without an approved `ReferralProof`
(enforced in the service layer, not just the UI).

## 9. Security controls

- **Authentication/RBAC**: dashboard sessions (httpOnly, `SameSite=Lax`
  cookies) and organization-scoped API keys (Phase 11) both use the same
  role/scope enforcement; every organization-scoped resource is checked
  against the authenticated caller's own organization, never a
  client-supplied one.
- **Destination validation**: `validateTransparentRedirectUrl` requires an
  absolute `http`/`https` URL, rejects userinfo, control characters, and
  protocol-relative input, and bounds input length — see
  `docs/compliance/redirect-audit.md` for the full test matrix.
- **SSRF protections (webhooks only)**: Phase 11's webhook delivery
  system validates destination URLs against a real private/loopback/
  link-local/cloud-metadata IP blocklist, re-checked immediately before
  every delivery attempt, with the outbound connection pinned to the
  validated address. This is a **server-side outbound HTTP client**
  concern (the server makes a real network request to a webhook URL) and
  is deliberately **not** applied to the tracker's `redirection_url` — a
  browser redirect (`Location` header) and a server-side webhook POST are
  different threat models; the tracker never makes a network request to
  `redirection_url` at all, so there is nothing for an SSRF check to
  protect there. See `docs/api/webhooks.md#ssrf-protection`.
- **Rate limiting**: the public API (`apps/api`) rate-limits per API key;
  this is enforced by a Fastify plugin instance that exists only in
  `apps/api`'s process. `apps/tracker` is a separate process that never
  imports it — tracker traffic cannot be throttled by, or accidentally
  share a bucket with, the public API's rate limiter.
- **Webhook signing**: HMAC-SHA256 over the exact raw request body,
  bounded retries, encrypted-at-rest signing secrets — see
  `docs/api/webhooks.md`.

## 10. Data handling

**Logged**: click id, organization/campaign/tracking-link/affiliate-
partner ids, a salted one-way IP hash, `User-Agent`, `Referer`, parsed
device/browser/OS, geo fields (country/region/city/timezone, from an
optional pluggable provider — a no-op by default), bot classification and
its reason codes.

**Never logged**: the raw IP address (only its salted hash is ever
persisted), API key secrets or webhook signing secrets (hashed/encrypted,
never written to any log), session cookies, or password hashes in
application logs (the logger's redaction list, `packages/logger`, strips
known secret-shaped fields from structured log output as defense in
depth).

## 11. Example requests/responses

**Successful human redirect:**

```
GET /abc123?redirection_url=https%3A%2F%2Fadvertiser.example.com%2Flanding%3Futm_source%3Dgoogle
Host: track.example.com

HTTP/1.1 302 Found
Location: https://advertiser.example.com/landing?utm_source=google
```

**Missing `redirection_url`:**

```
GET /abc123
Host: track.example.com

HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error":{"code":"VALIDATION_ERROR","message":"redirection_url query parameter is required"}}
```

**Dangerous protocol rejected:**

```
GET /abc123?redirection_url=javascript%3Aalert(1)
Host: track.example.com

HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid redirection_url: protocol \"javascript:\" is not allowed (only http/https)"}}
```

**Unknown slug / unverified / inactive domain (uniform, non-leaking):**

```
GET /no-such-slug?redirection_url=https%3A%2F%2Fexample.com%2Fx
Host: track.example.com

HTTP/1.1 404 Not Found
```

**Bot traffic (classified `BOT`), Safe Page configured:**

```
GET /abc123?redirection_url=https%3A%2F%2Fadvertiser.example.com%2Flanding
Host: track.example.com
User-Agent: Googlebot/2.1 (+http://www.google.com/bot.html)

HTTP/1.1 302 Found
Location: https://safe.example.com/
```

These exact request/response shapes are proven by automated tests — see
`apps/tracker/test/google-transparency-compliance.test.ts` and the
`pnpm compliance:test` tool (`docs/compliance/google-certification-checklist.md`).

## 12. Known limitations

- **This is a known, deliberate open-redirect-shaped design.** Any
  request to a verified, active tracking link can redirect a visitor to
  any well-formed `http`/`https` URL named in `redirection_url` — that is
  the intended shape of a transparent tracker, not an oversight. See
  `docs/compliance/google-transparent-tracker.md#this-is-a-known-deliberate-open-redirect-shaped-design`
  for the full discussion of what this does and does not restrict.
- **No rate limiting on the tracker route.** Deliberately deferred — see
  `docs/architecture/security.md`'s known limitations.
- **No TLS certificate provisioning.** `TrackingDomain.sslStatus` remains
  `NOT_CONFIGURED`; operators are expected to terminate TLS at their own
  edge/CDN or load balancer. HTTPS is expected in production but not
  provisioned by this codebase.
- **`HeuristicBotDetectionEngine` is a heuristic, not a production-grade
  or ML-based detector**, and will misclassify some real traffic in both
  directions under adversarial conditions — see
  `docs/architecture/bot-detection.md`.
- **Campaign status does not gate tracker traffic** — only
  `TrackingDomain` verification/activation and `TrackingLink.status` do.
  A `PAUSED`/`ARCHIVED` campaign's still-`ACTIVE` tracking links continue
  to serve traffic.
- **This document does not constitute, and cannot substitute for, an
  actual Google review.** It describes what has been built and how it can
  be verified; the certification decision itself is external to this
  codebase.
