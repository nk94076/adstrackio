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

All database access goes through Prisma's generated client
(`packages/database`), which parameterizes queries. The one place raw SQL
is used is the test-only `resetDatabase()` helper
(`apps/api/test/db-reset.ts`), which truncates tables between test runs —
it is never reachable from application code or any HTTP route.

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
  `HeuristicBotDetectionEngine` computes its verdict solely from the
  request's own `User-Agent` header; no query parameter, custom header, or
  other client-supplied value is read for this decision. Covered by a test
  that sends `?isBot=false&bot=false` alongside a known-bot UA and asserts
  the Safe Page still fires.
- **Click IDs are not sequential or guessable.** Generated with
  `crypto.randomUUID()` (`apps/tracker/src/modules/tracker/click-id.ts`)
  rather than relying on the `Click` model's default `cuid()`, and never
  appended to the outward-facing redirect URL — it exists purely for the
  `Click` row and internal log correlation.
- **No raw IP is ever stored.** `hashIp` (`packages/shared/src/ip-hash.ts`)
  salts and one-way-hashes the request IP before it reaches `Click.ipHash`.

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
- **`HeuristicBotDetectionEngine` is a basic, explicitly-provisional
  placeholder**, not a production bot-detection system. It will
  misclassify some real traffic in both directions; Phase 5 is expected to
  replace it with the product's real capability through the same
  `BotDetectionEngine` interface.
