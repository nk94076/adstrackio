# Authentication

## Bearer API keys

```
Authorization: Bearer atk_live_<secret>
```

Send this header on every public API request. The dashboard's session
cookie (`adstrackio_session`) continues to authenticate the exact same
URLs — a request is treated as an API-key request whenever an
`Authorization: Bearer ...` header is present, and falls back to the
session cookie otherwise. Sending both is not meaningful: the
`Authorization` header always takes precedence when present.

Implementation: `apps/api/src/plugins/api-key-auth.ts`'s
`authenticateEither`/`requireOrgAccess`, layered on top of (never
replacing) Phase 1's `authenticate`/`requireOrganizationMember`.

## How authentication works

1. The raw key's first 10 characters after `atk_live_` are extracted as a
   lookup prefix and used to find the matching `ApiKey` row (`keyPrefix`
   is a unique-indexed column) — an O(1) lookup, not a scan comparing
   every stored hash.
2. The full raw key is hashed (SHA-256) and compared against the stored
   `keyHash` with a constant-time comparison
   (`crypto.timingSafeEqual`) — never a plain `===`.
3. `revokedAt` and `expiresAt` are checked; either being set fails
   authentication.
4. `lastUsedAt` is updated (best-effort, never blocks or fails the
   request if this write races).
5. The authenticated organization and scopes are attached to the request
   from the `ApiKey` row itself — never from anything the request
   supplied.

Any failure at any of these steps — malformed token, no matching prefix,
hash mismatch, revoked, or expired — returns the exact same response:

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Invalid or expired API key" } }
```

This is deliberate: a caller (or an attacker probing keys) cannot
distinguish "this key never existed" from "this key was revoked
yesterday" from "this key expired an hour ago." See
`docs/architecture/security.md` for the full rationale.

## Organization scoping

Every public API URL is shaped `/organizations/:organizationId/...`. The
`:organizationId` in the URL is compared against the authenticated key's
own `organizationId` — a mismatch returns `403 FORBIDDEN` before any
service logic runs. **The organization is never taken from the request
body or a query parameter for an API-key-authenticated request** — only
from the key itself. A key from Organization A can never be used against
Organization B's URLs, regardless of what the request claims.

## Scopes

| Scope | Grants |
| --- | --- |
| `READ` | Read campaigns, tracking links, and (together with `REPORTS`) reports/analytics. |
| `WRITE` | Create/update campaigns and tracking links, run their lifecycle actions, and (together with `CONVERSIONS`) create/approve/reject/reverse conversions. |
| `REPORTS` | Read `/reports/*` and `/analytics/*` endpoints. |
| `CONVERSIONS` | Full conversion lifecycle (create, read, approve, reject, reverse) without needing the broader `WRITE`/`READ` scopes. |

A key must carry at least one of a route's accepted scopes; scopes are
never combined with `AND` logic across a single route. An API key cannot
be used to manage other API keys or webhook endpoints at all — those
remain dashboard-session-only regardless of scope (see
`docs/api/overview.md#resources`).

An insufficient scope returns `403 FORBIDDEN`, distinct from the `403`
returned for a wrong organization (the message names the missing
scope(s)) — this does not leak anything about other organizations, only
about the calling key's own grants.

## Key format

```
atk_live_<43-character base64url secret>
```

256 bits of `crypto.randomBytes` — not a UUID, not a predictable value.
See `docs/api/api-keys.md#hashing` for how it's stored.
