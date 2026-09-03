# Google Transparent Click Tracker — Certification Evidence Package (Phase 13)

**Status: not certified.** Nothing in this document is a claim that
Google has certified, approved, or verified this platform. It is a
consolidated evidence package — architecture, behavior, and test
results an operator can attach to a real submission once a real
production tracking domain is deployed and verified. It supersedes
nothing in `docs/compliance/google-transparent-click-tracker.md` or
`docs/compliance/google-certification-checklist.md` (Phase 12); it
consolidates them alongside Phase 13's production-launch work into one
submission-ready document.

## 1. Tracker architecture

`apps/tracker` is a separate Fastify service from `apps/api` and
`apps/dashboard`, whose only job is `GET /:slug?redirection_url=...`.

```
Google Ads click
      │
      ▼
GET https://track.example.com/<slug>?redirection_url=<visible destination>
      │
      ▼
apps/tracker:
  1. Read + validate `redirection_url` (protocol, length, no userinfo/
     control characters) — BEFORE any domain/slug lookup.
  2. Resolve hostname+slug against a VERIFIED, active TrackingDomain and
     an ACTIVE TrackingLink. Destination/destinationId is never read.
  3. Classify traffic (Phase 5 heuristic engine): BOT or not-BOT.
  4. BOT  → redirect to the campaign's configured Safe Page.
     else → redirect to the exact validated `redirection_url`.
  5. Record the click (Click row) — asynchronously enriched, never
     blocking the response.
      │
      ▼
HTTP 302, Location: <the exact redirection_url>  (or Safe Page, for BOT)
```

Full architectural detail: `docs/compliance/google-transparent-click-tracker.md`.
Full repository-wide redirect-path audit (every occurrence of
redirect-shaped code, classified): `docs/compliance/redirect-audit.md`.

## 2. Visible `redirection_url` behavior

The `redirection_url` query parameter **is** the next hop shown to the
browser — not an opaque ID, not a lookup key into a hidden mapping. It
is validated once (`validateTransparentRedirectUrl`,
`packages/shared/src/transparent-redirect.ts`) and the exact same parsed
`URL` object is what the tracker redirects to (`apps/tracker/src/modules/tracker/tracker.routes.ts`).
There is no code path where a stored `Destination` overrides it — the
resolver never even selects that field from the database.

## 3. Immediate HTTP `Location` evidence

The exact procedure and expected results are in
`docs/compliance/production-tracker-verification.md`. To generate real
evidence from your own deployment:

```sh
TRACKER_URL=https://track.yourdomain.com \
COMPLIANCE_TEST_HOSTNAME=track.yourdomain.com \
COMPLIANCE_TEST_SLUG=<a real, active slug> \
pnpm compliance:test -- --remote
```

This prints the raw request and response — method, path, `Host` header,
HTTP status, `Location` header — unconditionally, for the exact-redirect
check, e.g.:

```
Evidence — GET /<slug>?redirection_url=https%3A%2F%2Fexample.com%2Flanding...
           Host: track.yourdomain.com
           -> HTTP 302
           -> Location: https://example.com/landing?utm_source=ads&utm_campaign=x#top
```

The same shape, run against a local instance, is what
`apps/tracker/test/google-transparency-compliance.test.ts` and this
same tool's LOCAL mode prove deterministically today (see §9 for the
actual run recorded in this phase). **Paste your own deployment's real
output here when preparing an actual submission** — do not reuse the
example above, which is illustrative, not a live capture.

Equivalent by hand:

```sh
curl -sI "https://track.yourdomain.com/<slug>?redirection_url=<url-encoded destination>"
```

`curl -sI` never follows redirects — the `Location:` line in its output
is the tracker's immediate, unaltered response.

## 4. Destination validation

`validateTransparentRedirectUrl` (`packages/shared/src/transparent-redirect.ts`):
requires `http`/`https`, rejects `javascript:`/`data:`/`file:`/`vbscript:`
and other non-`http(s)` schemes, rejects userinfo (`user:pass@host`),
control characters, protocol-relative input (`//host/path`), and bounds
length at 2048 characters. Encoded/obfuscated variants are handled
safely because validation happens on the fully-decoded `URL` object, not
via string pattern matching that an encoding trick could evade.

This is a documented, deliberate design tradeoff, not an oversight: any
verified/active tracking link can redirect to **any** well-formed
`http`/`https` URL named in `redirection_url` — restricting the target
host would defeat the entire purpose of a transparent tracker. See
`docs/compliance/google-transparent-tracker.md#this-is-a-known-deliberate-open-redirect-shaped-design`.

## 5. Domain verification

A `TrackingDomain` must reach `verificationStatus: VERIFIED` (DNS TXT
record, `docs/architecture/domain-manager.md`) and `isActive: true`
before it can resolve any tracking traffic — enforced at the service
layer and by a Postgres `CHECK` constraint
(`tracking_domains_active_requires_verified`), so it cannot be bypassed
by a direct database write either. Production setup procedure:
`docs/deployment/production.md#4-real-tracking-domain-setup`.

## 6. Bot handling

`HeuristicBotDetectionEngine` (Phase 5,
`apps/tracker/src/modules/bot-detection/heuristic-bot-detection-engine.ts`)
is the single bot-classification implementation in this codebase. `BOT`
traffic is uniformly redirected to the campaign's configured Safe Page
— never to the visible `redirection_url` — applied identically to every
request classified `BOT`, with no per-caller or per-reviewer branching
anywhere in the decision. This is the one documented, non-transparent
exception to "redirection_url is always the destination," and it is the
same policy for a real search-engine crawler as for any other bot-like
request; there is no mechanism to distinguish "a Google reviewer" from
any other bot signal, which is precisely why one cannot exist to
deceive a reviewer specifically. See
`docs/compliance/google-transparent-click-tracker.md#5-bot-handling`.

## 7. Routing behavior

Campaign-scoped routing rules (Phase 8,
`packages/shared/src/routing-rules.ts`) can only resolve to
`TARGET` (the visible `redirection_url`), `SAFE_PAGE`, or `BLOCK` —
never an arbitrary URL. `BOT` classification has hard-coded precedence
over any routing rule. COUNTRY-based rule conditions only ever match
when `TRUSTED_EDGE_SECRET` is configured **and** the request actually
carries the matching `x-adstrackio-edge-secret` header from a genuinely
trusted edge — a client cannot forge this by sending a geo header alone.
See `docs/architecture/rules-routing.md`.

## 8. Affiliate attribution behavior

`Click.affiliatePartnerId` is written as an immutable snapshot at click
time (from `TrackingLink.affiliatePartnerId`) and is read only for
internal attribution reporting — never by the redirect decision.
Two tracking links attributing to different affiliate partners but
pointing at the same `redirection_url` produce byte-identical redirect
responses. See `docs/architecture/affiliate-partners.md` and
`docs/compliance/redirect-audit.md`'s "affiliatePartnerId" section.

## 9. Security controls

Full detail: `docs/compliance/production-readiness.md#5-production-security-audit`.
Summary relevant to a certification reviewer: HTTPS expected in
production (TLS terminated by the operator's infrastructure — see
`docs/deployment/production.md`), no session/cookie concept on the
tracker at all (it is not an authenticated surface), rate limiting
deliberately absent from the tracker route (documented rationale:
legitimate ad-click burst traffic), and the tracker's redirect hot path
makes zero synchronous external calls — click recording is a single
local Postgres transaction, geo enrichment happens strictly after the
response is sent.

## 10. Test commands

```sh
# Full local (in-process) transparency test suite:
pnpm --filter @adstrackio/tracker exec vitest run test/google-transparency-compliance.test.ts

# The full monorepo test suite:
pnpm turbo run test --force

# Deterministic local compliance check (10 checks, no live deployment needed):
pnpm compliance:test

# Against a real production deployment (see docs/compliance/production-tracker-verification.md):
TRACKER_URL=https://track.yourdomain.com \
COMPLIANCE_TEST_HOSTNAME=track.yourdomain.com \
COMPLIANCE_TEST_SLUG=<a real slug> \
COMPLIANCE_TEST_SAFE_PAGE_URL=<that link's Safe Page, if any> \
pnpm compliance:test -- --remote
```

Results recorded for this phase (LOCAL mode, run against this branch):

```
Mode: LOCAL (in-process apps/tracker against the configured DATABASE_URL)

  [PASS] tracker responds to a well-formed request
  [PASS] visible redirection_url is the exact immediate redirect target
  [PASS] missing redirection_url is rejected (400), no hidden destination used
  [PASS] a dangerous protocol destination (javascript:) is rejected (400)
  [PASS] a malformed redirection_url is rejected (400)
  [PASS] an unknown tracking slug fails safely (404)
  [PASS] an unverified tracking domain fails safely (404)
  [PASS] an inactive tracking domain fails safely (404)
  [PASS] BOT traffic routes to the configured Safe Page, never the visible destination
  [PASS] HUMAN traffic reaches exactly the visible destination, never the Safe Page

10 passed, 0 failed, 0 skipped.
```

(The exact same output is reproduced in this phase's PR description and
in `docs/compliance/production-readiness.md`'s quality-gate section —
this is a real recorded run, not an illustrative example, captured
against this branch during Phase 13.)

## 11. Production verification checklist

Before an actual submission, confirm every row against your **real,
live** deployment (not this repository's test suite — that proves the
code is correct; this proves your specific deployment is configured
correctly):

- [ ] Tracking domain is a real, DNS-owned hostname you control.
- [ ] Domain has completed `VERIFIED` status via the DNS TXT flow.
- [ ] Domain serves over HTTPS with a valid, non-self-signed certificate.
- [ ] At least one real `ACTIVE` tracking link exists on that domain.
- [ ] `curl -sI` (or `pnpm compliance:test -- --remote`) against that
      link, with a real `redirection_url`, returns a 3xx with `Location`
      exactly matching what was sent.
- [ ] The same check with `redirection_url` omitted returns 400.
- [ ] The same check with a `javascript:` destination returns 400.
- [ ] An unknown slug on the same domain returns 404.
- [ ] If the campaign has a configured Safe Page, a bot-UA request
      redirects there instead of the visible destination.
- [ ] `pnpm --filter @adstrackio/database exec prisma migrate status`
      against the production database reports up to date.
- [ ] `docs/deployment/production.md`'s environment variable table has
      been reviewed against the actual deployed configuration
      (`NODE_ENV=production`, real `AUTH_SECRET`, correct `APP_URL`/
      `API_URL`/`TRACKER_URL`, same-site dashboard/API deployment).

## What this document does not claim

- It does not claim Google has certified, approved, or verified this
  platform.
- It does not claim external certification evidence already exists —
  the evidence shapes above are what to produce from a real deployment,
  not fabricated samples presented as real captures (the one runnable
  output in §10 is real and reproducible from this branch; every
  "yourdomain.com"-shaped example elsewhere is illustrative).
- It does not claim a real production tracking domain has been
  deployed, verified, or checked as part of this phase — see
  `docs/compliance/production-readiness.md`'s "Limitations / remaining
  manual production steps" for exactly what remains an operator action.
