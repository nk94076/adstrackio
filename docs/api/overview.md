# AdstrackIO Public API — Overview

Phase 11 (API + Integrations) exposes a versioned public API under
`/api/v1` for external advertisers, affiliates, agencies, and developer
integrations. It does not introduce a second backend: every public
endpoint below reuses the exact same route handlers and service functions
the AdstrackIO dashboard itself calls (see
`docs/architecture/api-integrations.md` for the implementation-level
detail). This document is the entry point; see the companion documents
for specifics:

- [`authentication.md`](./authentication.md) — Bearer API keys, scopes,
  organization scoping, error semantics.
- [`api-keys.md`](./api-keys.md) — key lifecycle (create/list/rotate/
  revoke), idempotency, and its relationship to `externalConversionId`.
- [`webhooks.md`](./webhooks.md) — event types, payload envelope,
  signatures, retries, SSRF protections, and the test-send endpoint.

## Versioning

Every public endpoint lives under `/api/v1`. There is no `/api/v2` and no
unversioned public route. A breaking change to this API would ship as a
new `/api/v2` prefix in a future phase, never as an in-place change to
`/api/v1`'s existing behavior.

## Base URL

The public API is served by the same `apps/api` process as the dashboard
session API — there is no separate "public API" deployment. Use the
`API_URL` your AdstrackIO instance is configured with.

## Resources

| Resource | Endpoints |
| --- | --- |
| Campaigns | `GET/POST /organizations/:organizationId/campaigns`, `GET/PATCH .../campaigns/:campaignId`, `POST .../campaigns/:campaignId/{activate,pause,archive}` |
| Tracking Links | `GET/POST /organizations/:organizationId/tracking-links` (and the campaign-nested equivalents), `GET/PATCH .../tracking-links/:trackingLinkId`, lifecycle actions |
| Conversions | `GET/POST /organizations/:organizationId/conversions`, `GET .../conversions/:conversionId`, `POST .../conversions/:conversionId/{approve,reject,reverse}` |
| Reports | `GET /organizations/:organizationId/reports/{overview,timeseries,campaigns,tracking-links,dimensions}`, plus the existing `GET .../analytics/*` endpoints (including affiliate-partner performance) |

These are the exact URLs and route handlers the dashboard already uses —
see `docs/architecture/api-integrations.md#why-the-same-routes` for why
Phase 11 deliberately did not create a parallel set of "public" routes.

**Not exposed to API keys in this phase** (dashboard-session only):
organization/membership management, tracking domains, referral
configurations/proofs, routing rules, audit logs, and API key/webhook
management themselves. These were not requested for the public surface,
and widening every route to accept machine credentials would be a
materially larger security surface than what Phase 11 actually asked
for — see `docs/architecture/security.md#api--integrations-appsapi-phase-11`.

## Authentication

`Authorization: Bearer atk_live_<secret>`. See
[`authentication.md`](./authentication.md) for the full contract
(lookup/verification, scopes, error behavior). Dashboard session cookies
continue to work on every one of these same URLs unchanged — Phase 11 is
additive, not a replacement.

## Pagination

Every list endpoint uses the same cursor-based pagination shape already
established for `GET .../conversions` and `GET .../audit-logs`:

```
?take=50&cursor=<opaque id>
```

`take` defaults to 50 and is capped at 100 server-side — a client cannot
request an unbounded page. The response includes the requested resource
array; a full "next cursor" convenience field was not added beyond what
already existed, since every list response's last row's `id` already
serves as the next `cursor` value.

## Errors

Every error — public API or dashboard session alike — uses the same
shape (`plugins/error-handler.ts`, unchanged by this phase):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

Stable `code` values: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED`
(429), `INTERNAL_ERROR` (500). No response ever includes a stack trace,
raw SQL, Prisma driver internals, a secret, or a filesystem path.

## Rate limits

API-key-authenticated requests are rate-limited per key (120
requests/minute by default), isolated from both the dashboard's own
per-IP baseline and every other organization's keys — see
`docs/architecture/security.md` for the exact mechanism. Standard
`X-RateLimit-*` headers are included; exceeding the limit returns `429`
in the same `{ error: { code: "RATE_LIMITED", ... } }` shape as any other
error.

## Idempotency

`POST .../conversions` accepts an `Idempotency-Key` header. See
[`api-keys.md#idempotency`](./api-keys.md#idempotency).

## Attribution

A conversion's campaign/tracking-link/affiliate-partner attribution is
always derived server-side from the `Click` its `clickId` references —
never from any attribution field a client supplies, API key or dashboard
session alike. See
[`api-keys.md#conversion-attribution`](./api-keys.md#conversion-attribution).

## Known limitations

- No OpenAPI/Swagger specification and no interactive API explorer yet —
  this Markdown documentation is the source of truth for now.
- No CSV/Excel/PDF export endpoints (unchanged from Phase 10's own
  documented deferral).
- No SDKs/client libraries yet.
