# Data Model

Source of truth: `packages/database/prisma/schema.prisma`. This document
explains the *why* behind the schema; read the Prisma file for exact field
types, defaults, and indexes.

## Entity overview

Status legend: **IMPLEMENTED** — working end-to-end, covered by tests, safe
to build on as-is. **FOUNDATION ONLY** — the schema/model exists and is
deliberately shaped for what comes later, but the behavior that would make
it "live" isn't built yet. **FUTURE PHASE** — not started; named here only
so the roadmap this schema was designed against is explicit.

| Model | Purpose | Phase 1 status |
| --- | --- | --- |
| `User` | An individual account (email + password hash) | IMPLEMENTED |
| `Organization` | A workspace/tenant | IMPLEMENTED |
| `OrganizationMember` | Join table: user ↔ organization, with a role | IMPLEMENTED |
| `TrackingDomain` | A hostname an organization tracks clicks on | IMPLEMENTED (Phase 2: Domain Manager) — real DNS TXT verification; activation gated on it. No redirect/routing behavior (FUTURE PHASE: Transparent Click Tracker) |
| `Destination` | The business URL a campaign/link points to | IMPLEMENTED (CRUD + URL validation) |
| `Campaign` | Groups tracking links under a name/status/budget | FOUNDATION ONLY — no routing logic (FUTURE PHASE: Rules & Routing Engine) |
| `TrackingLink` | A routable slug on a domain, pointing at a destination | FOUNDATION ONLY — no live redirect (FUTURE PHASE: Transparent Click Tracker) |
| `Click` | An individual inbound tracking event | FOUNDATION ONLY — schema only, nothing writes to this table yet (FUTURE PHASE: Transparent Click Tracker / Click Analytics) |
| `Conversion` | A recorded conversion event | FOUNDATION ONLY — schema only, no postback ingestion (FUTURE PHASE: Conversion Tracking) |
| `BotEvent` | A bot-detection verdict for a click | FOUNDATION ONLY — schema + integration boundary only, no detection engine wired in (FUTURE PHASE: Bot Detection Integration) |
| `ReferralConfiguration` | How referral/attribution is labeled for a campaign | IMPLEMENTED, including the approval gate (app + database level) |
| `ReferralProof` | Evidence supporting a custom partner attribution config | IMPLEMENTED |
| `AuditLog` | Append-only record of administrative actions | IMPLEMENTED |

## Identity & organizations

`User` and `Organization` are connected through `OrganizationMember` rather
than an implicit many-to-many, specifically so a membership can carry a
`role` (`OWNER | ADMIN | MEMBER | VIEWER`) today and additional per-membership
attributes later (e.g. a per-member permission override) without a schema
rewrite. A user can belong to multiple organizations; the API resolves
"active organization" per-request from the URL (`/organizations/:id/...`),
not from a single "current org" column on `User` — see
`docs/architecture/security.md` for how the client tracks which
organization is active.

## Tracking domain, destination, campaign, tracking link

These four models are deliberately kept as separate concerns:

- **TrackingDomain** — a hostname the organization controls and intends to
  serve tracking traffic from. `verificationStatus` starts `PENDING` and is
  moved to `VERIFIED` only by a real, server-performed DNS TXT-record lookup
  (Phase 2: Domain Manager — see `docs/architecture/security.md#domain-activation-invariant`
  and `apps/api/src/modules/domains/dns-verification.ts`). `isActive`
  defaults to `false` and can only become `true` via the `/activate`
  endpoint once `verificationStatus = VERIFIED`; this is enforced both in
  the service layer and by a Postgres `CHECK` constraint
  (`tracking_domains_active_requires_verified`, migration
  `20260902061926_domain_manager_verification_fields`). `sslStatus` remains
  `NOT_CONFIGURED` — certificate provisioning is not part of Phase 2 and is
  left for a future phase to implement for real rather than being faked
  here. Domain Manager deliberately does not implement any redirect,
  destination-resolution, click-logging, or bot-routing behavior — a
  verified/active `TrackingDomain` is only ever a row in this table until
  Phase 3 (Transparent Click Tracker) builds the actual redirect path; see
  `docs/compliance/google-transparent-tracker.md`.
- **Destination** — the actual business URL (e.g. an offer page or app
  store link). Stored and normalized independently of any campaign so the
  same destination can be reused across campaigns/tracking links, and so
  future attribution reporting can group by destination.
- **Campaign** — the organizational/business grouping (name, status,
  budget, flight dates). A campaign optionally references a default
  `TrackingDomain` and `Destination`, but does not itself resolve traffic.
- **TrackingLink** — the actual routable unit: `(trackingDomainId, slug)`
  is unique, and it points at one `Destination`. This is intentionally
  *not* a redirect endpoint — it's a database row describing what a future
  redirect *should* do. See `packages/shared/src/tracking-resolver.ts` for
  the interface that will consume this data in Phase 3.

Splitting Destination from TrackingLink from Click matters for analytics:
a Destination can be reused across many links; a TrackingLink can accrue
many Clicks over time; and neither should have to change shape just
because the other does.

## Click, Conversion, BotEvent — event data

These three models exist now so Phase 3 (Transparent Click Tracker),
Phase 4 (Click Analytics), Phase 5 (Bot Detection Integration), and Phase 7
(Conversion Tracking) can be built against a stable schema. **No code
writes to these tables in Phase 1** — creating rows here would be
implementing functionality (click recording, bot scoring) ahead of the
phase that owns it.

Privacy-by-design notes on `Click`:

- No raw IP address is stored — only `ipHash`, intended to be a one-way,
  salted hash computed by the future ingestion path. This satisfies the
  "privacy-aware network identifier" requirement without ever persisting a
  directly-identifying value.
- `userAgent` and `referrer` are stored as-is because they're necessary
  for both analytics and bot detection, but are not linked to any other
  PII in this schema.
- `botClassification` / `botScore` on `Click` are a **denormalized
  snapshot** of the latest related `BotEvent`, kept for fast filtering in
  future analytics queries. `BotEvent` remains the source of truth and can
  hold multiple historical classifications per click (e.g. if re-scored).

`BotEvent.detectionSource` and `reasonCodes` exist so whichever bot
detection engine is wired in (Phase 5 — expected to be the product's
existing/planned bot-detection capability, not something built from
scratch here) can write structured, explainable verdicts through the
`BotDetectionEngine` interface in `packages/shared/src/bot-detection.ts`,
without AdstrackIO needing its own competing detection logic.

`Conversion` has optional `clickId`/`trackingLinkId` (not required) because
a real-world conversion pipeline needs to handle conversions that arrive
without a cleanly matched click (e.g. view-through, delayed postbacks) —
Phase 7 will build the actual ingestion; Phase 1 only ensures the schema
doesn't have to change shape to support that later. Both are indexed
(`conversions_trackingLinkId_idx`, `conversions_clickId_idx`) since "did
this click convert" / "conversions for this link" are core attribution
lookups — Postgres doesn't auto-index foreign key columns, and Phase 1
CTO review found these two missing.

### Flagged for the phase that starts writing to these tables (not fixed now)

Reviewed for what could become a problem at real click volume, once Phase
3/4 start inserting rows here — none of this blocks Phase 1, since nothing
writes to `Click`/`BotEvent`/`Conversion` yet, but it should inform that
work rather than being rediscovered under load:

- **Primary key strategy.** `Click`/`BotEvent` use the same `cuid()` text
  primary key as every other model for consistency. At sustained
  high-volume insert rates, a purely time-ordered key (e.g. UUIDv7/ULID,
  or a `bigint` identity column) indexes and partitions more efficiently
  than `cuid()`'s ordering. Worth an explicit decision — not necessarily a
  change — when Phase 3/4 design real ingestion.
- **No table partitioning.** A single unpartitioned `clicks` table will
  eventually need time-based partitioning (e.g. monthly) for both write
  throughput and the ability to cheaply drop/archive old data. Standard
  practice at scale, deliberately not built ahead of real volume.
- **Other foreign keys without an index**, lower priority than the two
  fixed above because they sit on control-plane tables bounded by org
  size, not click volume: `Campaign.trackingDomainId`,
  `Campaign.destinationId`, `TrackingLink.destinationId`,
  `ReferralConfiguration.campaignId`. Add if a specific query pattern
  needs them.

## Referral configuration & proof — the approval-gated model

This is the one piece of Phase 1 with real, enforced business logic (not
just a foundation schema):

- `ReferralConfiguration.type` is one of `NORMAL`, `HIDE`, or
  `CUSTOM_PARTNER_ATTRIBUTION`. This governs how AdstrackIO's **own**
  internal attribution pipeline records referral data for a campaign — it
  is explicitly not a mechanism for spoofing outbound HTTP `Referer`
  headers to third parties. See
  `docs/compliance/google-transparent-tracker.md`.
- Every configuration is created with `status = INACTIVE`, regardless of
  type.
- For `NORMAL` and `HIDE`, there's no additional gate — an org member can
  activate it once created.
- For `CUSTOM_PARTNER_ATTRIBUTION`, activation is blocked until at least
  one linked `ReferralProof` has `reviewStatus = APPROVED`. This is
  enforced in `apps/api/src/modules/referrals/referral-configurations.service.ts`
  (`activateReferralConfiguration`), not just in the dashboard UI, **and**
  backed by a Postgres trigger
  (`enforce_referral_configuration_activation`, migration
  `20260901204759_enforce_referral_activation_gate`) that rejects the same
  transition even for a write that bypasses the API entirely — see
  `docs/architecture/security.md` for why both layers exist, and
  `apps/api/test/referral-workflow.test.ts` for the tests that pin this
  behavior down (including: rejected proof still blocks activation; a
  second, approved proof unblocks it; a raw SQL `UPDATE` is rejected by the
  trigger until an approved proof exists).
- `ReferralProof` carries `documentReference` and/or `evidenceUrl`
  (external evidence), `submittedBy`, and a review trail (`reviewStatus`,
  `reviewedBy`, `reviewedAt`, `rejectionReason`). Review requires the
  `ADMIN` role or higher.

## Audit logging

`AuditLog` is intentionally schema-light: `action` is a free-text,
namespaced string (`"organization.created"`, `"referral_proof.approved"`,
etc.) rather than an enum, because the set of auditable actions will keep
growing across every future phase and an enum would need a migration for
every addition. `entityType`/`entityId` identify what changed;
`organizationId`/`actorUserId` identify the tenant/actor (both nullable —
some future system-initiated actions may have no human actor);
`metadata` is a JSON blob for action-specific context and **must never
contain secrets** (passwords, tokens, cookies) — this is enforced by
convention/code review today, and by the logger's redaction list
(`packages/logger`) for anything that also gets logged.
