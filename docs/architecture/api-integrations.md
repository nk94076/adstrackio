# API + Integrations (Phase 11)

This document covers the *implementation-level* design decisions behind
Phase 11. For the API contract itself (endpoints, payloads, headers), see
`docs/api/overview.md` and its companions. For the security rationale
behind each choice, see
`docs/architecture/security.md#api--integrations-appsapi-phase-11`.

## Why the same routes

Section 8 of the Phase 11 brief listed illustrative public endpoints
(`GET /organizations/:organizationId/campaigns`, etc.) that are, byte for
byte, URLs that already existed for the dashboard's session-authenticated
use before this phase. Two designs were possible:

1. Build a second, parallel set of routes at the same paths under a
   different mount point, duplicating the request handling and calling
   the same service functions.
2. Make the EXISTING routes accept either auth mode.

(1) would have meant maintaining two authorization/validation code paths
for identical business logic — exactly the "unnecessary duplicate
endpoint" and "duplicate business logic" the brief repeatedly warned
against. (2) is what was built: `campaigns.routes.ts`,
`tracking-links.routes.ts`, `conversions.routes.ts`, `analytics.routes.ts`,
and `reports.routes.ts` each swap their preHandler pair from
`[fastify.authenticate, fastify.requireOrganizationMember(role)]` to
`[fastify.authenticateEither, fastify.requireOrgAccess(role, scopes)]`.
Every other module (organizations, domains, referrals, routing rules,
audit logs, and API-key/webhook management themselves) is completely
untouched — still `fastify.authenticate`/`requireOrganizationMember`,
session-only.

## The dual-auth plugin

`apps/api/src/plugins/api-key-auth.ts` adds two new decorators without
modifying Phase 1's `authenticate`/`requireOrganizationMember` at all:

- **`authenticateEither`**: if an `Authorization: Bearer ...` header is
  present, verifies it as an API key and sets `request.apiKeyContext`;
  otherwise delegates to the existing `fastify.authenticate` (cookie
  session) unchanged.
- **`requireOrgAccess(minimumRole, apiKeyScopes)`**: if
  `request.apiKeyContext` is set, checks the key's own `organizationId`
  against the URL and its `scopes` against `apiKeyScopes`; otherwise
  delegates to `fastify.requireOrganizationMember(minimumRole)` — the
  exact same call every route already made before this phase.

Because both decorators fall through to the pre-existing session logic
unchanged whenever no Bearer token is present, a dashboard session's
behavior on every touched route is provably identical to before this
phase — verified by the full pre-existing test suite (668 tests across
`apps/api`, `apps/tracker`, and every package) passing unmodified.

### Attributing API-key-driven mutations

Every mutating service function in this codebase takes an
`actorUserId: string` for its audit-log entry. An API key isn't a user,
so there's no natural `userId` for a machine-driven action. Rather than
thread a nullable `actorUserId` through every service function's
signature (touching campaigns/tracking-links/conversions service code
for a concern that's really about the caller, not the mutation), routes
call a small helper, `actorIdOf(request)`
(`apps/api/src/plugins/api-key-auth.ts`), which resolves to
`request.user.id` for a session request or the API key's own `createdBy`
(the user who originally created that key) for an API-key request. The
audit trail therefore always attributes a Phase 11 API-key-driven action
to a real person — the one who issued the credential — with zero changes
to any existing service function's signature or business logic.

## Idempotency: composing a transaction inside a transaction

`createConversion` (Phase 7) opens its own `prisma.$transaction(...)`.
Phase 11's `withIdempotencyKey` also needs to open a transaction — one
that additionally writes the `IdempotencyRecord` row atomically with the
conversion. Nesting `$transaction` calls isn't supported by Prisma's
interactive-transaction client (`Prisma.TransactionClient` has no
`$transaction` method of its own).

The fix: `createConversion`'s actual body was extracted into
`createConversionInTx(tx: Prisma.TransactionClient, ...)`, which no
longer opens its own transaction — it just uses whatever `tx` it's
given. `createConversion(prisma, ...)` (the original, unchanged public
entry point every existing caller and test still uses) is now a one-line
wrapper: `prisma.$transaction((tx) => createConversionInTx(tx, ...))`.
`conversions.routes.ts`'s `POST` handler instead calls
`withIdempotencyKey`, which opens ONE transaction that writes the
`IdempotencyRecord` row, calls `createConversionInTx(tx, ...)` directly
inside it, and then updates the record with the result — so the
idempotency bookkeeping and the actual conversion commit or roll back
together, with no window for one to succeed without the other.

## The outbox pattern, minimally

`publishEvent` (`apps/api/src/modules/webhooks/outbox.service.ts`) is a
five-line function: it writes one `OutboxEvent` row using whatever
`Prisma.TransactionClient` it's handed. It is called from exactly one
place inside each of `conversions.service.ts`, `affiliate-partners.service.ts`,
`campaigns.service.ts`, and `tracking-links.service.ts`: immediately
alongside the existing `writeAuditLog` call, on the same branch that
already only runs for a REAL state transition (every one of these
functions already treats "already at target state" as an idempotent
no-op that skips the audit-log write — see e.g.
`conversions.service.ts`'s `transitionConversionStatus`). Placing
`publishEvent` on that identical branch means a retried HTTP request that
resolves to a no-op produces neither a duplicate audit entry NOR a
duplicate outbox event, for the same underlying reason — no new,
independent dedupe mechanism was needed for the outbox at all.

Turning an `OutboxEvent` into actual deliveries is a separate,
asynchronous concern (`webhook-delivery-worker.ts`):

1. **Fan-out** (`fanOutPendingOutboxEvents`): for each `PENDING`
   `OutboxEvent`, find every `active` `WebhookEndpoint` in that
   organization whose `subscribedEvents` includes the event's `type`, and
   `createMany(..., { skipDuplicates: true })` one `WebhookDelivery` row
   per match — safe to re-run (the `@@unique([webhookEndpointId, eventId])`
   constraint backstops it) even if a previous pass partially completed.
2. **Delivery** (`attemptWebhookDelivery`): claims and processes due
   `WebhookDelivery` rows.

This two-stage split keeps "which endpoints care about this event" (a
cheap, purely-relational question) separate from "actually make the HTTP
call" (slow, fallible, needs retry bookkeeping) — each stage is testable
and reasoned about independently.

## Why claiming holds a transaction open across the HTTP call

`processPendingWebhookDeliveries` runs `SELECT ... FOR UPDATE SKIP LOCKED`
inside a transaction and then performs each claimed delivery's actual
HTTP call *before that transaction commits*. Holding a database
transaction (and therefore a row lock, and a pooled connection) open
across slow external I/O is generally an anti-pattern — but it is the
simplest way to guarantee, with zero additional infrastructure, that two
concurrent worker ticks (or, if this API is ever horizontally scaled,
two different processes) can never both attempt the same delivery. The
batch size (5) and per-request timeout (8s) are sized to keep the
transaction's worst-case duration well under Postgres's default
statement/lock timeouts. This is documented as a known, deliberate
scaling boundary in `docs/architecture/security.md`; a future phase
handling meaningfully higher delivery volume should split "claim" (a
fast, short transaction) from "execute" (a separate step, using a lease
or heartbeat column instead of holding the row lock throughout).

## Testing an SSRF-safe system

`packages/shared/src/webhook-url.ts`'s `validateWebhookUrl` correctly and
unconditionally rejects loopback/private/link-local addresses — which
means a real local test HTTP server (needed to prove delivery mechanics:
signing, retries, timeouts, response handling) can never pass this check,
by design. Weakening the check for `NODE_ENV=test` was rejected outright
— that would be a real security regression disguised as a testing
convenience, and the brief's SSRF requirements are stated unconditionally,
not "except in non-production."

Instead, `attemptWebhookDelivery` accepts an optional `validateUrl`
parameter, defaulting to the real `validateWebhookUrl` and NEVER
overridden by any production code path (`index.ts`'s worker loop and
`webhooks.service.ts`'s `sendTestWebhook` both call it with zero extra
arguments). This mirrors `validateWebhookUrl`'s own injectable
`resolveHostname` option one level up — a standard dependency-injection
seam for testability, not a security bypass, since production code never
supplies an override. Tests use it to prove delivery mechanics against a
real local server, and separately (via `validateWebhookUrl`'s own
`resolveHostname` injection, and literal private-IP URLs at the route
level) prove the real, unmodified SSRF gate rejects every documented
attack surface. See `apps/api/test/api-integrations.test.ts` and
`packages/shared/src/webhook-url.test.ts`.

## Migration / schema footprint

One migration (`20260903061255_api_integrations`), five new tables
(`ApiKey`, `WebhookEndpoint`, `OutboxEvent`, `WebhookDelivery`,
`IdempotencyRecord`), three new enums (`ApiKeyScope`,
`WebhookDeliveryStatus`, `OutboxEventStatus`). No existing table gained a
column; no existing model's meaning changed. See
`docs/architecture/data-model.md#api--integrations-phase-11`.
