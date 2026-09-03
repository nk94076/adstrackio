# Webhooks

## Management endpoints (dashboard-session only)

```
POST   /api/v1/organizations/:organizationId/webhooks
GET    /api/v1/organizations/:organizationId/webhooks
GET    /api/v1/organizations/:organizationId/webhooks/:webhookId
PATCH  /api/v1/organizations/:organizationId/webhooks/:webhookId
POST   /api/v1/organizations/:organizationId/webhooks/:webhookId/rotate-secret
POST   /api/v1/organizations/:organizationId/webhooks/:webhookId/disable
POST   /api/v1/organizations/:organizationId/webhooks/:webhookId/test
GET    /api/v1/organizations/:organizationId/webhooks/:webhookId/deliveries
```

RBAC: MEMBER and VIEWER can read (list/get/deliveries); only OWNER/ADMIN
can create, update, rotate the secret, disable, or send a test event.
Like API keys, webhook management is not reachable via an API key at any
scope.

### Creating an endpoint

```json
{
  "name": "Order sync",
  "url": "https://your-server.example.com/webhooks/adstrackio",
  "subscribedEvents": ["conversion.created", "conversion.approved"]
}
```

The response includes `secret` (a `whsec_...` value) **exactly once** —
store it to verify incoming signatures. `rotate-secret` issues a new one
(also shown once); no endpoint ever returns a previously-issued secret
again.

## Events

| Event | Fires when |
| --- | --- |
| `conversion.created` | A conversion is reported |
| `conversion.approved` / `.rejected` / `.reversed` | A conversion's status transitions |
| `affiliate_partner.created` / `.updated` | A partner is created or edited |
| `affiliate_partner.activated` / `.paused` / `.archived` | A partner's lifecycle status transitions |
| `campaign.created` / `.updated` | A campaign is created or edited |
| `tracking_link.created` / `.updated` | A tracking link is created or edited |

This list is intentionally not exhaustive of every state change this
codebase can make (e.g. campaign/tracking-link activate/pause/archive are
not included) — only events explicitly in scope for this phase are
emitted, per the "do not create fake events" principle. See
`packages/shared/src/webhook-events.ts`.

## Payload envelope

```json
{
  "id": "evt_abc123",
  "type": "conversion.approved",
  "createdAt": "2026-01-01T12:00:00.000Z",
  "organizationId": "org_123",
  "data": {
    "id": "conv_xyz",
    "eventName": "purchase",
    "status": "APPROVED",
    "value": "49.99",
    "currency": "USD",
    "clickId": "...",
    "campaignId": "...",
    "trackingLinkId": "...",
    "occurredAt": "..."
  }
}
```

`data` never includes API key hashes, webhook secrets, raw IP addresses,
or any other internal-only field — only the resource's own public
fields, the same fields the equivalent `GET` endpoint would return.

## Signatures

Every delivery carries:

```
X-Adstrackio-Signature: <hex HMAC-SHA256>
X-Adstrackio-Event-Id: evt_abc123
X-Adstrackio-Timestamp: 1700000000000
```

Signature = `HMAC-SHA256(secret, "{timestamp}.{rawBody}")`, computed over
the EXACT bytes transmitted — never a re-serialized/re-parsed version of
the JSON. To verify (reference implementation:
`packages/shared/src/webhook-signature.ts`):

```
expected = hex(HMAC-SHA256(your_stored_secret, timestamp + "." + raw_request_body))
compare(expected, X-Adstrackio-Signature)   // constant-time comparison
```

Use the **raw** body your HTTP framework gives you before any JSON
parsing/re-serialization — parsing then re-stringifying can reorder keys
or reformat numbers and will not reproduce the same bytes that were
signed.

### Replay protection

Compare `X-Adstrackio-Timestamp` against your own clock and reject a
delivery whose timestamp is more than 5 minutes old (or unreasonably far
in the future) — this bounds how long a captured, replayed delivery
remains acceptable. AdstrackIO does not itself enforce a receiver-side
replay window (it cannot; that's the receiver's responsibility), but the
timestamp is always included specifically to make this check possible.

## Delivery architecture

Webhook delivery is fully asynchronous and off every request-handling
path in this codebase, including — critically — the tracker's transparent
redirect handler:

1. A business mutation (e.g. approving a conversion) writes a Conversion
   row AND an `OutboxEvent` row in the SAME database transaction
   (`apps/api/src/modules/webhooks/outbox.service.ts`'s `publishEvent`).
   Either both commit or neither does — there is no window where the
   mutation succeeds but the event is silently lost, nor one where an
   event fires for a mutation that then rolls back.
2. A background worker, running on a plain interval inside `apps/api`'s
   own process (`apps/api/src/index.ts` — never started by `buildApp`,
   which is what every test and the tracker actually use), fans each
   pending `OutboxEvent` out into one `WebhookDelivery` row per active,
   subscribed `WebhookEndpoint` in that event's organization.
3. The worker claims due `WebhookDelivery` rows with
   `SELECT ... FOR UPDATE SKIP LOCKED` (safe for multiple concurrent
   worker ticks/processes — no delivery is ever double-sent) and attempts
   each: sign, POST, record the outcome.

This is a minimal PostgreSQL-backed queue, not BullMQ/Redis — this
codebase's `REDIS_URL` environment variable exists only as Phase-1
foundation (validated at startup, never actually connected to by any
package), and introducing a new infrastructure dependency purely for this
phase would be exactly the "unnecessary complexity" this phase was told
to avoid. `SKIP LOCKED` already provides the concurrency safety a real
queue would.

**No webhook/API-key code exists in `apps/tracker` at all.** The tracker
redirect handler (`GET /:slug?redirection_url=...`) is completely
unmodified by this phase.

## Retries

| Attempt | Delay before it |
| --- | --- |
| 1 | Immediate |
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 10 minutes |
| 5 (final) | 30 minutes |

**Retried**: network errors, timeouts, `408`, `429`, any `5xx`.
**Not retried** (`FAILED` immediately): `400`, `401`, `403`, `404`,
`422`, and any other non-retryable `4xx` — the destination understood and
rejected the request; retrying an unchanged payload cannot succeed.
**Not retried**: a destination that fails SSRF/URL validation — this is
also terminal, since the destination cannot become safe merely by
retrying later.

After exhausting all 5 attempts against a retryable failure, the
delivery's final status is `EXHAUSTED` (distinct from `FAILED`, which
means a non-retryable rejection was returned on some attempt — usually
the first).

## SSRF protection

Webhook URLs are the one place in this codebase where AdstrackIO's own
server makes an outbound request to a destination an organization
controls — see `packages/shared/src/webhook-url.ts`.

**Blocked, always:**

- `localhost` (the literal hostname)
- Loopback (`127.0.0.0/8`, IPv6 `::1`)
- The unspecified address (`0.0.0.0`, IPv6 `::`)
- RFC1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- Link-local addresses (`169.254.0.0/16`, IPv6 `fe80::/10`) — this
  includes `169.254.169.254`, the cloud metadata endpoint used by AWS,
  GCP, Azure, and others
- Carrier-grade NAT (`100.64.0.0/10`)
- IETF documentation/reserved/multicast ranges
- An IPv4-mapped IPv6 address that unwraps to any of the above

**Required in production**: `https://` only (`NODE_ENV=production`);
`http://` is permitted in development/test.

**When it's checked**: at endpoint creation/update (fail fast, clear
error) AND again, freshly, immediately before every single delivery
attempt — DNS can change between the two moments, so a creation-time-only
check would let an organization register a webhook pointing at a domain
they control, wait for it to pass validation, then repoint DNS at an
internal address before the real delivery happens. The delivery HTTP
client additionally pins its TCP connection to the specific IP address
that was just resolved and checked (via a custom DNS `lookup` override),
rather than letting the underlying HTTP request re-resolve the hostname
itself at connect time — this closes the remaining gap between "we
checked this address" and "we connected to this address."

**Redirects are never followed.** A `3xx` response from the destination
is recorded like any other status code, not treated as an instruction to
make a second request to a different (unvalidated) URL.

**Documented limitation**: this validates and pins DNS state at the
moment of each delivery attempt. It cannot protect against an endpoint
that is genuinely, persistently reachable at a public address at
validation time but architecturally routes internally once connected
(e.g. an application-layer proxy an organization controls) — that is
outside what a network-layer SSRF check can detect. See
`docs/architecture/security.md#api--integrations-appsapi-phase-11`.

## Secret storage

`WebhookEndpoint.secretEncrypted` is AES-256-GCM-encrypted with a key
derived from `AUTH_SECRET` (`packages/auth/src/secret-box.ts`) — not a
one-way hash, because the server must be able to reproduce the exact HMAC
signature on every delivery, the same reason Stripe/GitHub webhook
secrets are retrievable server-side rather than one-way hashed.
Encryption-at-rest protects a raw database dump from revealing secrets;
it does not protect against a compromise of the running API process
itself (which holds `AUTH_SECRET` and could decrypt anything it stores) —
an inherent limitation of any symmetric-signing webhook design, not a gap
specific to this implementation.

## Test-send

`POST .../webhooks/:webhookId/test` sends one clearly-marked event to the
named endpoint, bypassing its `subscribedEvents` filter (a test always
targets exactly the endpoint you asked for) and its `active` flag,
through the exact same signing/delivery/retry code real events use. The
synthetic event is typed `"webhook.test"` — a reserved type excluded from
`subscribedEvents` (an organization cannot "subscribe" to test events)
and never counted in, or visible to, any analytics/reporting query. It
never creates a Conversion, Campaign, AffiliatePartner, or TrackingLink
row.

## Delivery history

`GET .../webhooks/:webhookId/deliveries` returns each delivery attempt's
`attempt`, `status` (`PENDING`/`DELIVERED`/`FAILED`/`EXHAUSTED`),
`responseStatus`, a truncated `responseBodySnippet`, `deliveredAt`, and
`nextAttemptAt` — this is where retry/delivery history belongs; ordinary
delivery attempts are never written to the audit log (see
`docs/architecture/security.md`).
