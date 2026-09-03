# Production Deployment

Phase 13 (Production Launch & Certification Evidence). This document is
the operator-facing companion to
`docs/compliance/production-readiness.md` (what was audited/added in the
code) and `docs/compliance/google-certification-evidence.md` (what to
hand Google). It covers what an operator actually has to do to stand
this codebase up in production: build and run the three services, point
a real tracking domain at the tracker, run migrations, and roll back if
something goes wrong.

Nothing in this document claims the platform is already deployed,
already certified by Google, or that any of the steps below have been
performed against a real production environment as part of this phase
— see "What this phase did and did not do" at the bottom.

## 1. The three services

| Service | Package | Default port | Purpose |
| --- | --- | --- | --- |
| API | `@adstrackio/api` | 4000 | Authenticated control plane + versioned public API (`/api/v1`) |
| Tracker | `@adstrackio/tracker` | 4100 | The Google-facing transparent click tracker (`GET /:slug?redirection_url=...`) |
| Dashboard | `@adstrackio/dashboard` | 3000 | Internal admin UI (Next.js), calls the API from the browser |

All three are stateless Node processes in front of one PostgreSQL
database. None of them hold in-process session state beyond what a
single request needs — any of them can be scaled horizontally behind a
load balancer with no sticky-session requirement (the session is a
signed JWT cookie, not a server-side session store — see
`docs/architecture/security.md#session-model`).

## 2. Building production images

Each app has a `Dockerfile` at its package root, built from the
**monorepo root** as the build context (they depend on workspace
packages under `packages/*`):

```sh
docker build -f apps/api/Dockerfile       -t adstrackio-api       .
docker build -f apps/tracker/Dockerfile   -t adstrackio-tracker   .
docker build -f apps/dashboard/Dockerfile -t adstrackio-dashboard \
  --build-arg NEXT_PUBLIC_API_URL=https://api.yourdomain.com .
```

`apps/api/Dockerfile` and `apps/tracker/Dockerfile` install the full
workspace, generate the Prisma client, build with Turborepo, then run
`pnpm prune --prod` to drop devDependencies before the runtime stage
copies the result. `apps/dashboard/Dockerfile` uses Next.js's
`output: "standalone"` (`apps/dashboard/next.config.mjs`) to produce a
minimal, self-contained server bundle.

**`NEXT_PUBLIC_API_URL` is a build-time value**, not a runtime one — it
is a `NEXT_PUBLIC_*` variable, which Next.js inlines into the client
JavaScript bundle at `next build` time. Pass it as a `--build-arg`, not
as a `docker run -e` flag; setting it only at `docker run` time has no
effect on an already-built image.

Each Dockerfile runs the application as a non-root user (`adstrackio`)
and expects its `EXPOSE`d port (4000 / 4100 / 3000 respectively) to be
the only one published.

There is no `docker-compose.prod.yml` in this repository —
`docker/docker-compose.yml` is development-only (a local Postgres +
Redis for `pnpm dev`). Production orchestration (Kubernetes, ECS, Nomad,
a managed PaaS, or a hand-rolled compose file with real secrets wired
through your platform's secret manager) is an operator decision outside
this codebase's scope; the Dockerfiles above are the reusable unit.

## 3. Production environment variables

Backend services (`apps/api`, `apps/tracker`) read and validate their
environment eagerly at startup via `packages/config/src/schema.ts` — a
misconfigured value fails the process immediately rather than
surfacing as a confusing runtime error later. See `.env.example` for
the full annotated list; the ones that matter specifically for a
production launch:

| Variable | Production requirement |
| --- | --- |
| `NODE_ENV` | Must be `production`. Governs `secure` on the session cookie (`apps/api/src/modules/auth/auth.routes.ts`) and log verbosity. |
| `DATABASE_URL` | A real PostgreSQL connection string. Use a connection pooler (PgBouncer, RDS Proxy, etc.) in front of Postgres if running more than a couple of instances of `api`/`tracker` — Prisma opens its own connection pool per process. |
| `REDIS_URL` | Still required by the schema (fails startup if unset) but **nothing in this codebase connects to it yet** — see the `.env.example` comment on this variable. Set it to a real Redis instance if you want it available for a future phase; it is not read anywhere today. |
| `AUTH_SECRET` | A long, random value (`openssl rand -base64 48`), at least 32 characters, not the `.env.example` placeholder — enforced by a zod refinement, not just documentation. Rotating it invalidates every session at once (see `docs/architecture/security.md`'s session model). |
| `APP_URL` / `API_URL` / `TRACKER_URL` | The real public HTTPS URLs of each service. `APP_URL` is also the API's CORS allow-list origin (`apps/api/src/plugins/security.ts`) — get this wrong and the dashboard cannot call the API at all. |
| `NEXT_PUBLIC_API_URL` | Build-time only — see §2 above. |
| `API_PORT` / `TRACKER_PORT` | Whatever your container platform expects each process to listen on internally (the Dockerfiles default to 4000/4100). |
| `CLICK_IP_HASH_SALT` | Optional; set a dedicated value in production to decouple IP-hash derivation from `AUTH_SECRET` (see `.env.example`). |
| `TRUSTED_EDGE_SECRET` | Optional, **and this decision matters for transparency**: leave it unset unless your CDN/edge is configured to inject a matching `x-adstrackio-edge-secret` header on every request it forwards, and to strip any client-supplied copy first. Setting it without that edge configuration does nothing (COUNTRY routing conditions simply never match); setting it *without* stripping the client header would let a client's own header be trusted — see `docs/architecture/rules-routing.md#country-signal-trust-boundary`. |

**Same-site deployment requirement.** `apps/api` and `apps/dashboard`
must be deployed on the same registrable "site" — e.g.
`api.yourdomain.com` and `app.yourdomain.com`, both under
`yourdomain.com` — not on unrelated domains. The session cookie is
`SameSite=Lax` and scoped to the API's own origin; the dashboard calls
the API directly from the browser with `credentials: "include"`, which
only works for a same-site (even if cross-origin/cross-port) request.
Deploying them on unrelated domains breaks authentication entirely, not
partially. See `docs/architecture/security.md#session-model`.

Never commit a filled-in `.env` (or equivalent secret file) — `.gitignore`
already excludes `.env*` except `.env.example`.

## 4. Real tracking-domain setup

This is what makes a tracking link Google-facing and is the part a
certification submission actually inspects.

1. **Choose a real subdomain you control** for tracking links, e.g.
   `track.yourdomain.com`. It does not need to be a subdomain of the
   dashboard/API's own domain (unlike §3's same-site cookie
   requirement, which is about the API and dashboard, not the tracker
   — the tracker has no session/cookie concept at all, see
   `apps/tracker/src/plugins/security.ts`).
2. **Create the domain** via the authenticated API/dashboard
   (`POST /api/v1/organizations/:organizationId/domains`, or the
   Domains page). This returns a DNS TXT verification token
   (`TrackingDomain.verificationToken`) — see
   `docs/architecture/domain-manager.md` for the full flow.
3. **Publish the DNS TXT record** the response names, at the hostname
   it specifies. Verification polls for this record; it is not
   instantaneous DNS propagation, so allow for normal DNS TTL delay.
4. **Trigger verification** (`POST .../domains/:id/verify`). The domain
   only becomes usable once `verificationStatus` is `VERIFIED` — the
   tracker's resolver hard-requires this (`apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts`)
   and a Postgres `CHECK` constraint additionally enforces that
   `isActive` can never be `true` while `verificationStatus` is not
   `VERIFIED`, so this cannot be bypassed by a raw SQL update either
   (`apps/api/test/domains-lifecycle.test.ts` proves the DB-level
   invariant, not just the service layer).
5. **Point DNS for that hostname at your tracker deployment** — an A/
   AAAA/CNAME record to wherever `apps/tracker`'s containers/load
   balancer live. This is separate from the TXT verification record in
   step 3 (which only needs to exist long enough to verify ownership;
   it does not need to keep pointing traffic anywhere).
6. **Terminate TLS in front of the tracker.** `TrackingDomain.sslStatus`
   deliberately stays `NOT_CONFIGURED` in this codebase — it does not
   provision a certificate for you (see
   `docs/compliance/google-transparent-click-tracker.md#12-known-limitations`).
   Use your platform's standard TLS termination: a managed load
   balancer/CDN with automatic certificate provisioning (e.g. ACM,
   Cloudflare, a Kubernetes ingress with cert-manager), or your own
   reverse proxy (nginx/Caddy/Envoy) with Let's Encrypt. Google Ads
   requires the tracking URL to be HTTPS; a self-signed or missing
   certificate is not acceptable for certification.
7. **Reverse proxy / load balancer requirements**, if you put one in
   front of the tracker (recommended for TLS termination and horizontal
   scaling):
   - Forward the `Host` header unchanged — the resolver matches on it
     (`normalizeRequestHostname` in `apps/tracker/src/modules/tracker/tracker.routes.ts`
     strips only the port and lowercases; it does not rewrite the
     hostname).
   - Do **not** rewrite, cache, or short-circuit the `Location` header
     the tracker returns. A CDN configured to "follow and cache
     redirects" would defeat the entire transparency mechanism this
     phase and Phase 12 exist to prove — the visible destination must
     reach the browser exactly as the tracker returned it.
   - Do not introduce your own redirect/rewrite rule in front of the
     tracker for tracking-link paths. Any additional hop between the ad
     click and the tracker's own redirect reintroduces exactly the
     "hidden intermediate redirect" pattern Phase 12's transparency
     audit confirmed does not exist in the application itself — adding
     one at the infrastructure layer would silently reintroduce it.
   - `trustProxy: true` is already set on both Fastify apps
     (`apps/api/src/app.ts`, `apps/tracker/src/app.ts`), so a standard
     `X-Forwarded-For`/`X-Forwarded-Proto`-setting proxy in front of
     them works without additional application changes.

## 5. Database migrations in production

- Migrations are Prisma migrations under `packages/database/prisma/migrations/`,
  applied with `pnpm db:migrate:deploy` (wraps `prisma migrate deploy`) —
  the non-interactive command intended for CI/CD and production, as
  opposed to `pnpm db:migrate` (`prisma migrate dev`), which is
  development-only and can prompt/reset.
- Run `pnpm db:migrate:deploy` as a **release step before** the new
  application code starts serving traffic (a deploy pipeline's
  pre-deploy hook, an init container, or a manual step immediately
  before rolling the deployment) — never let application instances
  race a schema migration.
- Check status non-destructively at any time with
  `pnpm --filter @adstrackio/database exec prisma migrate status`. This
  phase introduced no schema changes — see
  `docs/compliance/production-readiness.md` for the exact output this
  phase recorded.
- **This phase introduces no destructive migration** and did not modify
  `packages/database/prisma/schema.prisma`. Every phase since Phase 1
  has added columns/tables/indexes additively; no migration in this
  repository drops a column or table.
- **Indexes.** The tracker's hot-path lookup (`TrackingDomain.hostname`,
  `@@unique([trackingDomainId, slug])` on `TrackingLink`) and every
  reporting/analytics aggregation query
  (`Click`/`Conversion`'s `organizationId`+`occurredAt`,
  `campaignId`+`occurredAt`, `trackingLinkId`+`occurredAt` composite
  indexes, etc.) already have the indexes their query patterns need —
  added incrementally in Phases 3/4/7/9/10 as each query pattern was
  introduced. This phase re-verified them (see
  `docs/compliance/production-readiness.md#6-databasebackup-readiness`)
  and added none, per the brief's "do not introduce unnecessary schema
  changes."

### Rollback procedure

1. **Roll back application code first**, not the database. Every
   migration in this repository is additive (new nullable/defaulted
   columns, new tables, new indexes) — old application code continues
   to run correctly against a newer schema, so redeploying the previous
   container image resolves almost any incident without touching the
   database at all.
2. If a specific migration must actually be reverted (schema-level, not
   just the app), write and apply a new forward migration that undoes
   it — `prisma migrate deploy` has no built-in "undo" for an already-
   applied migration, and hand-editing applied migration history in
   production is a fast path to a divergent `_prisma_migrations` table.
   Treat "roll back the schema" as "author a new migration," the same
   review process as any other schema change.
3. If rollback requires restoring data (not just schema), restore from
   the backup taken before the migration ran (§6) rather than trying to
   algorithmically reverse application writes.

## 6. Backup and restore expectations

This codebase does not implement its own backup mechanism — Postgres
backup/restore is standard infrastructure, not application code, and is
an operator/platform responsibility (managed Postgres providers —
RDS, Cloud SQL, Neon, etc. — typically provide automated snapshots and
point-in-time recovery out of the box). What to actually back up and
when, specific to this schema:

- **Take a snapshot immediately before running `db:migrate:deploy`** in
  production, every time — the standard "backup before migration" rule,
  not specific to any migration in this repository being risky.
- **`Click` and `Conversion` are the highest-volume, highest-value
  tables** (attribution data — see `docs/architecture/data-model.md`).
  If your backup provider supports differentiated retention, prioritize
  point-in-time recovery granularity for these over lower-volume
  configuration tables (`Organization`, `Campaign`, `TrackingDomain`,
  etc.), which change far less often and matter less to lose a few
  minutes of.
- **`ApiKey.hashedSecret` and `WebhookEndpoint`'s encrypted signing
  secret are one-way/encrypted at rest** (Phase 11 — see
  `docs/architecture/security.md`) — a database restore recovers them
  correctly with no separate secret-recovery step, but a restore to an
  earlier point in time will resurrect any API key or webhook secret
  that was revoked/rotated after that snapshot. Treat a restore as
  equivalent to un-revoking anything revoked since, and re-revoke as
  part of the restore runbook if that matters for the incident.
- **Restore into a separate instance first** and run
  `pnpm --filter @adstrackio/database exec prisma migrate status`
  against it before cutting production traffic over, to confirm the
  restored schema version matches what the currently-deployed
  application code expects.

## 7. Deploying the dashboard

The dashboard has no backend of its own — it is a Next.js app whose
authenticated pages are client components calling the API directly from
the browser (`apps/dashboard/src/lib/api-client.ts`, `credentials:
"include"`). Deploy it anywhere that can run `node apps/dashboard/server.js`
(the standalone output's entrypoint) or serve a Next.js app generally —
its own platform (Vercel, etc.), or the same container platform as the
other two services. It is not part of the Google-facing tracker surface
and has no bearing on certification.

## 8. Observability

See `docs/compliance/production-readiness.md#7-observability` for what
`/health` and `/ready` return on both backend services, what gets
logged (and what deliberately never does), and the known gap (no metrics/
tracing wired up yet — structured logs only).

## What this phase did and did not do

This phase authored the Dockerfiles above, added `/ready` endpoints, and
wrote this deployment procedure — it did **not** provision a real
tracking domain, run these Dockerfiles against a live cloud environment,
or perform an actual production deployment. `docker build` for these
images could not be executed in this development session because the
session's network policy does not permit reaching Docker Hub's image
CDN (a sandboxed egress restriction, not a defect in the Dockerfiles
themselves) — see
`docs/compliance/production-readiness.md#1-production-environment-audit`
for exactly what was and was not possible to verify directly, and build
these images yourself in an environment with normal registry access
before relying on them.
