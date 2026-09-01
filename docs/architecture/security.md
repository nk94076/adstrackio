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

## Secrets and logging

- `packages/logger` redacts `password`, `passwordHash`, `token`,
  `accessToken`, `refreshToken`, `authorization`, `cookie`, `secret`,
  `authSecret`, and `apiKey` fields (at any nesting depth pino's redact
  paths can reach) before anything is written to stdout.
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
