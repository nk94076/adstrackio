# Data Model

Source of truth: `packages/database/prisma/schema.prisma`. This document
explains the *why* behind the schema; read the Prisma file for exact field
types, defaults, and indexes.

## Entity overview

| Model | Purpose | Phase 1 status |
| --- | --- | --- |
| `User` | An individual account (email + password hash) | Fully functional |
| `Organization` | A workspace/tenant | Fully functional |
| `OrganizationMember` | Join table: user ↔ organization, with a role | Fully functional |
| `TrackingDomain` | A hostname an organization tracks clicks on | Foundation — no real DNS verification yet |
| `Destination` | The business URL a campaign/link points to | Fully functional (CRUD + URL validation) |
| `Campaign` | Groups tracking links under a name/status/budget | Foundation — no routing logic yet |
| `TrackingLink` | A routable slug on a domain, pointing at a destination | Foundation — no live redirect yet |
| `Click` | An individual inbound tracking event | Schema only — nothing writes to this table yet |
| `Conversion` | A recorded conversion event | Schema only — no postback ingestion yet |
| `BotEvent` | A bot-detection verdict for a click | Schema only — no detection engine wired in yet |
| `ReferralConfiguration` | How referral/attribution is labeled for a campaign | Fully functional, including the approval gate |
| `ReferralProof` | Evidence supporting a custom partner attribution config | Fully functional |
| `AuditLog` | Append-only record of administrative actions | Fully functional |

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
  serve tracking traffic from. `verificationStatus` starts `PENDING` and
  `sslStatus` starts `NOT_CONFIGURED`; both are placeholders for Phase 2
  (Domain Manager), which will implement real DNS TXT-record verification
  and certificate provisioning.
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
doesn't have to change shape to support that later.

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
  (`activateReferralConfiguration`), not just in the dashboard UI — see
  `docs/architecture/security.md` for why that placement matters, and
  `apps/api/test/referral-workflow.test.ts` for the tests that pin this
  behavior down (including: rejected proof still blocks activation; a
  second, approved proof unblocks it).
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
