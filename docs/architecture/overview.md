# Architecture Overview

## Status

This document describes the **Phase 1 (Foundation)** architecture of AdstrackIO.
Phase 1 establishes the monorepo, data model, authentication, and API
foundation that later phases (Domain Manager, Transparent Click Tracker,
Click Analytics, Bot Detection Integration, Campaign Manager, Conversion
Tracking, Rules & Routing Engine, Affiliate/Partner System, Attribution &
Advanced Reporting, API + Integrations, Google Certification) build on top
of, without requiring a rewrite of what's here.

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
    tracker/     Fastify service boundary for the future Transparent Click
                 Tracker — currently health-check only
  packages/
    database/    Prisma schema + generated client, shared by apps/api and
                 apps/tracker
    auth/        Password hashing, session tokens, role helpers
    config/      Typed, validated environment configuration
    validation/  Zod request schemas shared by apps/api (and reusable by
                 apps/dashboard)
    shared/      Cross-cutting types: API error shape, URL normalization,
                 and the TrackingResolver / BotDetectionEngine interfaces
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

Phase 1 only creates this boundary — `apps/tracker` exposes a `/health`
endpoint and a `TrackingResolver` interface
(`packages/shared/src/tracking-resolver.ts`) that unconditionally rejects
with "not implemented". This is intentional: nothing pretends to redirect
traffic until Phase 3 actually implements it.

## Request flow (Phase 1)

```
Dashboard (Next.js, browser)
  --fetch, credentials: include-->  apps/api (Fastify)
                                        |
                                        v
                                   packages/database (Prisma)
                                        |
                                        v
                                    PostgreSQL
```

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
  `BotDetectionEngine` interfaces. These are Phase 1's explicit contract
  for what Phase 3 (Transparent Click Tracker) and Phase 5 (Bot Detection
  Integration) will implement — see the inline documentation in
  `packages/shared/src/tracking-resolver.ts` and
  `packages/shared/src/bot-detection.ts`.
- **packages/validation** holds Zod schemas so the same validation rules
  can be reused by the API (server-side enforcement) and, if useful later,
  by the dashboard for client-side form validation — without duplicating
  the rules.

## What Phase 1 deliberately does not implement

- Real DNS/SSL verification for tracking domains (`TrackingDomain` starts
  `PENDING`). **Update: DNS verification and the activation lifecycle have
  since been implemented in Phase 2 (Domain Manager)** — see
  `docs/architecture/data-model.md` and
  `docs/architecture/security.md#domain-activation-invariant`. SSL/TLS
  certificate provisioning remains unimplemented (`sslStatus` stays
  `NOT_CONFIGURED`).
- Actual click redirection (`TrackingResolver` rejects; see Transparent
  Click Tracker, Phase 3).
- Click/conversion analytics dashboards (the schema exists; reporting is
  Phase 4 / Phase 10).
- Bot detection logic (`BotEvent` schema and `BotDetectionEngine` interface
  exist; the engine itself is Phase 5, and is expected to be the product's
  existing/planned bot-detection capability, not a new one built here).
- Campaign routing rules (Phase 8).
- Postbacks/webhooks for conversions (Phase 7 mentions foundation only;
  postbacks are explicitly out of scope for Phase 1).
- Any Google Transparent Click Tracker certification claim — see
  `docs/compliance/google-transparent-tracker.md`.
