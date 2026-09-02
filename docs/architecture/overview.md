# Architecture Overview

## Status

This document describes AdstrackIO's architecture as of **Phase 4 (Click
Analytics)**. Phase 1 established the monorepo, data model,
authentication, and API foundation; Phase 2 (Domain Manager) added real
DNS verification and domain activation; Phase 3 added the real tracker
redirect endpoint; Phase 4 added User-Agent/geo enrichment on `Click` rows
and a read-only analytics API + dashboard on top of them — see
`docs/architecture/click-analytics.md`. Later phases (Bot Detection
Integration, Campaign Manager, Conversion Tracking, Rules & Routing
Engine, Affiliate/Partner System, Attribution & Advanced Reporting, API +
Integrations, Google Certification) build on top of what's here, without
requiring a rewrite of it.

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
  `TrackingResolver` is now implemented for real by
  `PrismaTrackingResolver` (`apps/tracker`, Phase 3); `BotDetectionEngine`
  currently has only the explicitly-provisional
  `HeuristicBotDetectionEngine` (`apps/tracker`) — the "product's
  existing/planned bot-detection capability" Phase 5 is meant to wire in
  through the same interface hasn't landed yet. See the inline
  documentation in `packages/shared/src/tracking-resolver.ts` and
  `packages/shared/src/bot-detection.ts`. Phase 4 added two more
  interfaces in the same package following the same pattern:
  `UserAgentParser` (`packages/shared/src/user-agent.ts`, implemented by
  `UaParserUserAgentParser` in `apps/tracker`) and `GeoLocationProvider`
  (`packages/shared/src/geo-location.ts`, implemented by default as a
  no-op `NullGeoLocationProvider`) — see
  `docs/architecture/click-analytics.md`.
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
- **Real bot detection** is not built. `BotEvent` schema and
  `BotDetectionEngine` interface exist and are now actually written to by
  Phase 3's tracker, but via `HeuristicBotDetectionEngine` — an explicitly
  provisional user-agent heuristic, not the product's existing/planned
  bot-detection capability Phase 5 is expected to wire in through the same
  interface.
- **Campaign routing rules** (Phase 8) are not built — Phase 3's Safe Page
  is a single `Campaign.safePageUrl` field, not a routing-rules engine.
- **Postbacks/webhooks for conversions** (Phase 7) are out of scope so far.
- **Any Google Transparent Click Tracker certification claim** — see
  `docs/compliance/google-transparent-tracker.md`.
