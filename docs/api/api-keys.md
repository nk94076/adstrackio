# API Keys

## Lifecycle endpoints (dashboard-session only, OWNER/ADMIN)

```
POST   /api/v1/organizations/:organizationId/api-keys
GET    /api/v1/organizations/:organizationId/api-keys
GET    /api/v1/organizations/:organizationId/api-keys/:apiKeyId
POST   /api/v1/organizations/:organizationId/api-keys/:apiKeyId/rotate
POST   /api/v1/organizations/:organizationId/api-keys/:apiKeyId/revoke
```

There is no `DELETE` endpoint: revocation (permanent, one-directional)
is the correct model for a credential — it preserves the row for audit
history and for `lastUsedAt`/`createdAt` forensics, rather than deleting
evidence a key ever existed. MEMBER/VIEWER members cannot call any of
these endpoints (`403`); OWNER/ADMIN can. An API key itself can never
call any of these endpoints, at any scope — key/webhook management is
session-only. See `docs/api/overview.md#resources`.

### Creating a key

```http
POST /api/v1/organizations/org_123/api-keys
{
  "name": "Reporting integration",
  "scopes": ["READ", "REPORTS"],
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

```json
{
  "apiKey": {
    "id": "key_abc",
    "name": "Reporting integration",
    "keyPrefix": "AbCdEfGhIj",
    "scopes": ["READ", "REPORTS"],
    "expiresAt": "2027-01-01T00:00:00Z",
    "revokedAt": null,
    "lastUsedAt": null,
    "createdAt": "...",
    "key": "atk_live_AbCdEfGhIj...restofsecret"
  }
}
```

**`key` is present in this response and this response only.** Every
subsequent `GET`/list call omits it entirely — AdstrackIO does not
persist the raw secret anywhere, so there is nothing to return even if a
future endpoint tried to. Store it somewhere safe immediately.

### Rotation

`POST .../api-keys/:apiKeyId/rotate` issues a brand-new secret for the
same key row (same `id`, same `name`, same `scopes`, same `expiresAt`) —
the OLD secret stops working the instant rotation succeeds. Use this to
replace a credential you suspect was exposed, without having to
reconfigure every scope/permission a brand-new key would need from
scratch.

### Revocation

`POST .../api-keys/:apiKeyId/revoke` is permanent and idempotent —
revoking an already-revoked key succeeds without error and writes no
duplicate audit entry.

## Hashing

AdstrackIO stores `keyHash` (a SHA-256 digest of the full raw secret) and
`keyPrefix` (a 10-character, non-secret slice of the secret, used purely
as a lookup index) — never the raw key itself. This is deliberately
**not** the same treatment as `User.passwordHash` (argon2id): a human
password is low-entropy and needs a slow, memory-hard KDF to resist
offline brute-forcing, while an API key secret already carries 256 bits
of cryptographically random entropy. Hashing an already-unguessable
secret with a deliberately slow KDF would add substantial latency to
every single API request and create a CPU-exhaustion vector, for no
additional security. This is the same approach GitHub, Stripe, and most
API-token systems take. See
`docs/architecture/security.md#api--integrations-appsapi-phase-11`.

## Idempotency

`POST .../conversions` accepts:

```
Idempotency-Key: <client-generated opaque string, 1-255 chars>
```

### Semantics

- The same `(organizationId, scope, Idempotency-Key)` combination is
  guaranteed to correspond to at most one created `Conversion`.
- **Replay**: sending the identical request again with the same key
  returns the SAME response (same conversion, same HTTP status) rather
  than creating a second conversion. The response carries an
  `Idempotency-Replayed: true` header on a replay.
- **Conflicting reuse**: sending a *different* request body with a
  previously-used key returns `409 CONFLICT` — the key names one
  specific request, not a general dedup token for "conversions from this
  click."
- **Concurrency**: two truly simultaneous requests with the same key are
  safe — Postgres's own unique-constraint insert semantics (not an
  in-memory map, not an application-level lock) guarantee exactly one
  actually creates the conversion; the other transparently replays that
  result. See the `IdempotencyRecord` schema doc comment in
  `packages/database/prisma/schema.prisma` for the exact mechanism.
- **No key supplied**: the request is processed normally, with no
  dedup guarantee — the same tradeoff `externalConversionId` already
  offers as an optional field.

### Relationship to `externalConversionId`

These are two different, complementary concepts:

| | `externalConversionId` (Phase 7) | `Idempotency-Key` (Phase 11) |
| --- | --- | --- |
| Scope | The **business identity** of the created Conversion resource itself | One specific **HTTP request attempt** |
| Guarantee | No two conversions in an organization can ever share this value | A retried call with this key returns the same response, never a new resource |
| Enforced by | `conversions_organizationId_externalConversionId_key` unique index | `idempotency_records_organizationId_scope_key_key` unique index |

Using both together is normal and recommended: `externalConversionId`
protects your own systems from ever double-counting the same real-world
event by business meaning; `Idempotency-Key` protects a single API call
against duplication from network retries, regardless of whether the
call even supplies an `externalConversionId`. A **different**
`Idempotency-Key` reusing the same `externalConversionId` still
collides — `externalConversionId` uniqueness cannot be bypassed by
varying the `Idempotency-Key`.

### Known limitation

`IdempotencyRecord` rows are retained indefinitely; there is no
expiry/pruning job yet. A future phase should add TTL-based cleanup once
retention requirements are defined.

## Conversion attribution

`POST .../conversions` never accepts `campaignId`, `trackingLinkId`, or
`affiliatePartnerId` — these are always derived from the `Click` named
by `clickId`, exactly as they are for a dashboard-authenticated request
(Phase 7/9, unchanged). Supplying these fields in the request body has no
effect; they are not even present in the request schema, so they are
silently ignored rather than rejected. See
`docs/architecture/conversion-tracking.md#click-attribution` and
`docs/architecture/affiliate-partners.md`.
