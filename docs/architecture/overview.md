# Architecture Overview

## Status

This document describes AdstrackIO's architecture as of **Phase 13
(Production Launch & Certification Evidence)**. Phase 1 established the monorepo, data model,
authentication, and API foundation; Phase 2 (Domain Manager) added real
DNS verification and domain activation; Phase 3 added the real tracker
redirect endpoint; Phase 4 added User-Agent/geo enrichment on `Click` rows
and a read-only analytics API + dashboard on top of them — see
`docs/architecture/click-analytics.md`; Phase 5 wired bot classification
into the tracker's actual routing decision (SUSPICIOUS/UNKNOWN previously
had no defined behavior) via a small, campaign-configurable policy
abstraction — see `docs/architecture/bot-detection.md`; Phase 6 turned
Campaign/TrackingLink from unguarded CRUD rows into a real control plane —
an explicit status lifecycle enforced in the backend (not just the
dashboard), and domain/destination assignment rules that close IDOR and
"campaign points at a dead domain" gaps Phase 1-5 left open — see
`docs/architecture/campaign-manager.md`; Phase 7 added conversion
reporting, always attributed through a real `Click` (never a
client-asserted campaign/tracking-link ID), with database-enforced
deduplication and its own status lifecycle — see
`docs/architecture/conversion-tracking.md`; Phase 8 added a campaign-scoped,
priority-ordered routing-rule engine that composes (not duplicates) Phase
5's bot-traffic policy — a rule can only ever pick among the same
TARGET/SAFE_PAGE/BLOCK outcomes the tracker already knew how to execute,
never an arbitrary URL — see `docs/architecture/rules-routing.md`; Phase 9
added an affiliate/partner control plane (partner CRUD/lifecycle,
campaign-roster assignment, and deterministic click/conversion
attribution derived entirely from server-controlled tracking
configuration, never client input) around the existing transparent
tracker, with zero new synchronous calls on its redirect hot path — see
`docs/architecture/affiliate-partners.md`; Phase 10 added a reporting
layer (organization-scoped overview/timeseries/campaign/tracking-link/
dimension-breakdown reports, plus value/EPC fields on the existing
affiliate-partner performance endpoint) built entirely on top of Phase
4/7/9's existing `Click`/`Conversion` aggregation functions — no new
attribution mechanism, no schema change, no new tracker code — see
`docs/architecture/attribution-reporting.md`; Phase 11 added a versioned
public API surface (`/api/v1`) that external advertisers/affiliates/
agencies can authenticate against with organization-scoped API keys
(scoped READ/WRITE/REPORTS/CONVERSIONS), reusing — never duplicating —
the exact same campaign/tracking-link/conversion/reporting service
functions and route paths dashboard sessions already used; an
Idempotency-Key-backed dedup mechanism for POST conversions on top of the
existing DB-unique-constraint pattern; and an outbox-pattern webhook
system (signed HMAC-SHA256 deliveries, bounded retries, SSRF-safe
destination validation) that fires on Phase 7/9's existing conversion/
affiliate-partner/campaign/tracking-link lifecycle mutations, delivered
by a minimal PostgreSQL-backed queue with zero new synchronous calls
anywhere in `apps/tracker` — see `docs/api/overview.md` and
`docs/architecture/api-integrations.md`. Phase 12 audited every redirect
path added across Phases 3–11 against the Google Transparent Click
Tracker transparency requirement, found the existing architecture already
compliant by construction, added an explicit compliance test suite and a
`pnpm compliance:test` tool, and produced certification-readiness
documentation — see `docs/compliance/google-transparent-click-tracker.md`,
`docs/compliance/google-certification-checklist.md`, and
`docs/compliance/redirect-audit.md`. Phase 13 (Production Launch &
Certification Evidence) added production container images
(`apps/*/Dockerfile`) and a deployment procedure
(`docs/deployment/production.md`), `/ready` readiness endpoints on
`apps/api`/`apps/tracker` distinct from the pre-existing `/health`
liveness check, extended `pnpm compliance:test`'s remote mode to print
raw HTTP evidence for a real production tracking link, and consolidated
a certification evidence package
(`docs/compliance/google-certification-evidence.md`) and production
tracker verification procedure
(`docs/compliance/production-tracker-verification.md`) on top of Phase
12's audit — no changes to the tracker's redirect/routing/attribution
logic itself. This is preparation for a future manual submission and
review, not a certification grant, and no phase in this codebase can
certify itself or claims to have completed a real production
deployment.

Nothing described as "future" or "not implemented" below exists yet. This
document is written to stay accurate as those phases land — update it as
each phase is implemented rather than treating it as aspirational.

## Monorepo layout

```
adstrackio/
  apps/
    api/         Fastify backend — auth, organizations, campaigns, tracking
                 links, destinations, referrals, audit logs (admin/control plane)
    dashboard/   Next.js App Router admin UI
    tracker/     Fastify data-plane service — the real Transparent Click
                 Tracker redirect endpoint (Phase 3)
  packages/
    database/    Prisma schema + generated client, shared by apps/api and
                 apps/tracker
    auth/        Password hashing, session tokens, role helpers
    config/      Typed, validated environment configuration
    validation/  Zod request schemas shared by apps/api (and reusable by
                 apps/dashboard)
    shared/      Cross-cutting types: API error shape, URL normalization,
                 and the TrackingResolver / BotDetectionEngine /
                 UserAgentParser / GeoLocationProvider interfaces
    logger/      Structured logging (pino) with secret redaction
  docker/        docker-compose.yml for local Postgres + Redis
  docs/          This documentation
```

Package manager: pnpm workspaces. Task runner: Turborepo (`pnpm dev`,
`pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck` fan out to every
workspace via `turbo.json`).

## Why apps/tracker is a separate service from apps/api

This is the one architectural decision Phase 1 exists specifically to set
up correctly, because retrofitting it later would mean a rewrite:

- **Traffic profile is different.** apps/api serves authenticated admin
  traffic (low volume, latency-tolerant). The future tracker serves
  unauthenticated, high-volume redirect traffic where every millisecond of
  latency matters and where a slow admin-plane query must never be able to
  block a redirect.
- **Independent scaling.** The tracker needs to scale horizontally based on
  click volume, independent of how many people are using the dashboard.
- **Independent auditability.** Google's Transparent Click Tracker
  certification is concerned specifically with redirect behavior. Keeping
  that code in its own deployable, with its own boundary, makes it possible
  to audit in isolation rather than having to reason about the entire admin
  API surface. See `docs/compliance/google-transparent-tracker.md`.
- **Failure isolation.** An incident in the admin API (e.g. a bad
  migration, a runaway report query) should never take down click
  redirection, and vice versa.

Phase 1 only created this boundary — `apps/tracker` exposed a `/health`
endpoint and a `TrackingResolver` interface
(`packages/shared/src/tracking-resolver.ts`) that unconditionally rejected
with "not implemented". Phase 3 (Transparent Click Tracker) has since
implemented the real `GET /:slug` redirect route on this boundary — see
`docs/compliance/google-transparent-tracker.md` for the architecture and
`docs/architecture/security.md` for its security properties.

## Request flow

```
Dashboard (Next.js, browser)
  --fetch, credentials: include-->  apps/api (Fastify)
                                        |
                                        v
                                   packages/database (Prisma)
                                        |
                                        v
                                    PostgreSQL

Ad click, unauthenticated
  --GET /:slug?redirection_url=...-->  apps/tracker (Fastify)
                                        |
                                        v
                                   packages/database (Prisma)
                                        |
                                        v
                                    PostgreSQL
```

apps/tracker never calls apps/api, and vice versa — they only share
`packages/database`'s Postgres connection. This keeps the data plane
(tracker) independently deployable and scalable from the control plane
(api/dashboard); see "Why apps/tracker is a separate service" above.

apps/api and apps/dashboard are on separate origins (different ports in
development). The dashboard is a client-rendered SPA-style app for
authenticated pages: it calls the API directly from the browser with
`credentials: "include"` so the browser attaches the API's httpOnly session
cookie. Server components in the dashboard do not call the API directly in
Phase 1, because the session cookie is scoped to the API's origin and isn't
visible to the Next.js server. See `docs/architecture/security.md` for the
session model and the tradeoffs this accepts.

## Package boundaries and why they exist

- **packages/database** is the only package that imports `@prisma/client`
  directly. Nothing else talks to Postgres directly — this keeps the
  schema/query surface centralized and makes it possible to swap or extend
  the data layer without touching every app.
- **packages/auth** has no dependency on `packages/database`. It is pure
  crypto/token logic (argon2 hashing, JWT sign/verify, role ranking) that
  apps/api wires up against real user records. This keeps it independently
  testable and reusable by apps/tracker later if needed.
- **packages/shared** defines the `TrackingResolver` and
  `BotDetectionEngine` interfaces, plus `validateTransparentRedirectUrl`
  (the tracker's URL-safety check) and `hashIp` (one-way IP hashing).
  `TrackingResolver` is implemented for real by `PrismaTrackingResolver`
  (`apps/tracker`, Phase 3); `BotDetectionEngine` currently has only the
  explicitly-provisional, though now multi-signal, `HeuristicBotDetectionEngine`
  (`apps/tracker`) — not a production-grade or ML-based bot-detection
  capability. See the inline documentation in
  `packages/shared/src/tracking-resolver.ts` and
  `packages/shared/src/bot-detection.ts`. Phase 4 added two more
  interfaces in the same package following the same pattern:
  `UserAgentParser` (`packages/shared/src/user-agent.ts`, implemented by
  `UaParserUserAgentParser` in `apps/tracker`) and `GeoLocationProvider`
  (`packages/shared/src/geo-location.ts`, implemented by default as a
  no-op `NullGeoLocationProvider`) — see
  `docs/architecture/click-analytics.md`. Phase 5 added
  `packages/shared/src/bot-traffic-policy.ts` — a small, explicit
  classification-to-routing-action resolver (`resolveBotRoutingAction`),
  deliberately not a full rules engine — see
  `docs/architecture/bot-detection.md`. Phase 8 added
  `packages/shared/src/routing-rules.ts` (the pure `evaluateRules`
  evaluator and `resolveRoutingDecision`, which composes rather than
  replaces `resolveBotRoutingAction`) and
  `packages/shared/src/routing-signals.ts` (synchronous country/referrer
  signal extraction) — see `docs/architecture/rules-routing.md`.
- **packages/validation** holds Zod schemas so the same validation rules
  can be reused by the API (server-side enforcement) and, if useful later,
  by the dashboard for client-side form validation — without duplicating
  the rules.

## What's implemented so far, and what still isn't

- **Domain verification/activation (Phase 2)** and **click redirection
  (Phase 3)** are implemented — see
  `docs/architecture/security.md#domain-activation-invariant` and
  `docs/compliance/google-transparent-tracker.md`.
- **SSL/TLS certificate provisioning** remains unimplemented (`sslStatus`
  stays `NOT_CONFIGURED`, not fabricated).
- **Click analytics (Phase 4)** is implemented — a read-only, organization-scoped
  analytics API (`/api/v1/organizations/:organizationId/analytics/clicks/...`)
  and an `/analytics` dashboard page, backed by real PostgreSQL aggregation
  over `Click`. `Click` rows now also carry real User-Agent-derived
  enrichment (device type/browser/OS) written by `apps/tracker`, and an
  optional, pluggable geo-location provider (no-op by default — see
  `docs/architecture/click-analytics.md`). Conversion analytics remains
  out of scope (Phase 7/10 — `Conversion` is still schema-only).
- **Bot detection integration (Phase 5)** is implemented — the tracker's
  routing decision now reads the `BotDetectionEngine` verdict for all four
  classifications (`HUMAN`/`BOT`/`SUSPICIOUS`/`UNKNOWN`), not just `BOT`;
  `SUSPICIOUS`/`UNKNOWN` route through a small, campaign-configurable
  policy (`Campaign.suspiciousTrafficPolicy`/`unknownTrafficPolicy`,
  default `TARGET`). The engine itself
  (`HeuristicBotDetectionEngine`) remains an explicitly provisional,
  multi-signal heuristic — not a production-grade, ML-based, or
  externally-validated bot-detection capability. See
  `docs/architecture/bot-detection.md`.
- **Campaign Manager (Phase 6)** is implemented — an explicit
  `DRAFT -> ACTIVE -> PAUSED -> ARCHIVED` campaign lifecycle and a
  `ACTIVE -> PAUSED -> ARCHIVED` tracking-link lifecycle, both enforced in
  the service layer (`packages/shared/src/campaign-lifecycle.ts` and
  `tracking-link-lifecycle.ts`) via explicit `activate`/`pause`/`archive`
  endpoints — never as a side effect of a generic `PATCH`. Campaign/
  tracking-link domain assignment now requires a `VERIFIED`+active
  `TrackingDomain`, and tracking links are managed through campaign-nested
  routes (`/campaigns/:campaignId/tracking-links/...`). See
  `docs/architecture/campaign-manager.md`.
- **Conversion Tracking (Phase 7)** is implemented — a reported conversion
  is always attributed through a real `Click` (campaign/tracking-link
  IDs are derived server-side, never accepted from the client, and
  enforced immutable/matching by a database trigger), deduplicated via an
  optional caller-supplied `externalConversionId` under a real unique
  constraint, and moves through an explicit
  `PENDING -> APPROVED/REJECTED`, `APPROVED -> REVERSED` status lifecycle
  enforced in the backend. See
  `docs/architecture/conversion-tracking.md`.
- **Rules & Routing Engine (Phase 8)** is implemented — a campaign-scoped,
  priority-ordered `RoutingRule` model with typed/bounded conditions (bot
  classification, country, device type, browser, OS, referrer host) and
  the same three TARGET/SAFE_PAGE/BLOCK outcomes Phase 3/5 already
  execute (no arbitrary rule-configured URLs, no `eval`). Composes rather
  than duplicates Phase 5's bot-traffic policy: a `BOT` classification
  always routes to `SAFE_PAGE` regardless of any rule; routing rules are
  consulted for `HUMAN`/`SUSPICIOUS`/`UNKNOWN` traffic; a campaign with no
  rules configured behaves identically to before this phase existed. See
  `docs/architecture/rules-routing.md`.
- **Affiliate/Partner System (Phase 9)** is implemented — organizations
  can create/manage `AffiliatePartner` records with an explicit
  `PENDING -> ACTIVE -> PAUSED -> ARCHIVED` lifecycle, assign them to a
  campaign's roster (`CampaignAffiliatePartner`), and attribute a specific
  tracking link's clicks to exactly one roster partner
  (`TrackingLink.affiliatePartnerId`). `Click.affiliatePartnerId` is a
  denormalized snapshot copied from the resolving tracking link at write
  time (zero extra tracker queries); `Conversion` gains no new column and
  is attributed through the click it already references. Historical
  attribution survives partner archival; RBAC mirrors Campaign's own
  VIEWER/MEMBER/ADMIN tiering. Payouts, payment processing, webhooks, and
  a partner-facing portal are explicitly out of scope. See
  `docs/architecture/affiliate-partners.md`.
- **Attribution & Advanced Reporting (Phase 10)** is implemented — a
  read-only reporting layer
  (`/api/v1/organizations/:organizationId/reports/{overview,timeseries,
  campaigns,tracking-links,dimensions}`) built entirely on the existing
  Phase 4/7/9 `Click`/`Conversion` aggregation functions: no new
  attribution mechanism (Phase 10 documents and reports on Phase 7's
  existing `Conversion.clickId`-derived attribution, calling it
  "first-click" — one click per conversion, never multi-touch), no schema
  change, no new tracker code. Adds `approvedConversionRate`/`epc`
  (earnings-per-click) fields to the existing `ConversionSummary` and
  `AffiliatePartnerPerformanceRow` types (both additive, existing fields
  unchanged), a `getClicksByBotClassification` breakdown (the one
  dimension Phase 4 hadn't added), and dimension/timeseries filters for
  country/device/browser/OS/bot classification across every existing
  analytics endpoint too. See `docs/architecture/attribution-reporting.md`.
- **API + Integrations (Phase 11)** is implemented — organization-scoped
  `ApiKey` credentials (256-bit random secret, SHA-256 hashed, shown once)
  authenticate via `Authorization: Bearer atk_live_...` against the SAME
  campaign/tracking-link/conversion/analytics/reports routes dashboard
  sessions already use (`fastify.authenticateEither`/`requireOrgAccess` —
  additive to, never a replacement for, session auth), gated by
  READ/WRITE/REPORTS/CONVERSIONS scopes. POST conversions additionally
  accept an `Idempotency-Key` header, backed by a real `IdempotencyRecord`
  table and Postgres's own unique-constraint insert semantics (no
  in-memory map). A transactional outbox (`OutboxEvent`, written in the
  same transaction as each conversion/affiliate-partner/campaign/
  tracking-link mutation it describes) feeds a `WebhookDelivery` queue
  processed by a plain interval in `apps/api`'s own process — HMAC-SHA256
  signed, bounded exponential-backoff retries, and destination URLs
  validated against a real SSRF blocklist (loopback/private/link-local/
  cloud-metadata ranges, re-checked fresh immediately before every
  delivery attempt, not just at endpoint creation). No BullMQ/Redis: the
  REDIS_URL env var remains Phase-1-foundation-only (validated at startup,
  never connected to). `apps/tracker` is untouched — zero webhook/API-key
  code exists there, and no synchronous network call was added to its
  redirect hot path. See `docs/api/overview.md` and
  `docs/architecture/api-integrations.md`.
- **Any Google Transparent Click Tracker certification claim** — see
  `docs/compliance/google-transparent-tracker.md`.
