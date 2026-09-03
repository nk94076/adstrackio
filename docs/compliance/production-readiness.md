# Production Readiness (Phase 13)

Audit results and changes from Phase 13 — Production Launch &
Certification Evidence. This document records what was checked, what
was found, and what was actually changed in the codebase. It does not
claim a production deployment exists, and does not claim Google
certification has been granted — see
`docs/compliance/google-certification-evidence.md` for the evidence
package and its own explicit disclaimer.

Phase 12 (`docs/compliance/google-transparent-click-tracker.md`,
`docs/compliance/redirect-audit.md`) already audited the tracker's
transparency, bot handling, routing, and security posture in depth.
This phase re-verifies the parts of that audit relevant to running in
production, and covers ground Phase 12 didn't: Docker/deployment
configuration, readiness observability, and DB/backup procedure. Where
this document says "unchanged from Phase 12," it means the finding was
re-confirmed against current code, not merely re-read from the old
document.

## 1. Production environment audit

**apps/api, apps/tracker, apps/dashboard reviewed.** Findings:

- **Graceful shutdown**: both `apps/api/src/index.ts` and
  `apps/tracker/src/index.ts` already handle `SIGINT`/`SIGTERM` by
  calling `app.close()` (which runs Fastify's `onClose` hooks, including
  `prismaPlugin`'s `prisma.$disconnect()`) before `process.exit(0)`.
  `apps/api`'s entrypoint additionally clears its webhook-delivery
  polling `setInterval` on shutdown. No changes needed — this was
  already correct.
- **CORS**: `apps/api/src/plugins/security.ts` registers `@fastify/cors`
  with `origin: [env.APP_URL]` (a single explicit origin from
  configuration, not a wildcard) and `credentials: true` — required for
  the session cookie to be sent at all, and the narrowest origin
  configuration that still lets the dashboard call the API. No changes
  needed.
- **Cookies/session**: the session cookie
  (`apps/api/src/modules/auth/auth.routes.ts`) is `httpOnly`,
  `sameSite: "lax"`, and `secure: env.NODE_ENV === "production"` —
  i.e. it is only sent over HTTPS once `NODE_ENV=production` is actually
  set, which is why that variable being correct in production is a hard
  requirement, not just documentation (see
  `docs/deployment/production.md#3-production-environment-variables`).
  No changes needed.
- **Secure headers**: `@fastify/helmet` is registered on both
  `apps/api` and `apps/tracker` with a maximally restrictive
  `default-src: 'none'` CSP (neither serves HTML). `apps/dashboard`
  gained equivalent response headers
  (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`) in
  Phase 12; unchanged this phase.
- **Database/Redis connections use environment variables**:
  `packages/config/src/schema.ts` requires `DATABASE_URL` and
  `REDIS_URL` and fails startup if either is missing — both come only
  from the environment, never hardcoded. `REDIS_URL` is validated but
  **still not connected to by any package** (unchanged from Phase 12's
  finding — rate limiting uses `@fastify/rate-limit`'s in-memory store,
  and the only queue in this codebase is the Postgres-backed webhook
  delivery worker). Documented plainly, not fixed by fabricating a
  Redis connection that has no current use — see `.env.example`.
- **Structured logging without secrets/tokens/raw IPs**: `apps/api` and
  `apps/tracker` both configure Pino with
  `redact: { paths: REDACT_PATHS, censor: "[REDACTED]" }`
  (`packages/logger`). Click IP addresses are never logged or stored raw
  at all — `Click.ipHash` is a salted one-way hash
  (`packages/shared/src/ip-hash.ts`), computed before anything touches
  the database or a log line. Re-confirmed by reading `REDACT_PATHS`
  and the click-recording path; unchanged from Phase 1/12.
- **`NODE_ENV`/production configuration**: `envSchema` validates
  `NODE_ENV` is one of `development`/`test`/`production` (defaulting to
  `development`, i.e. fails open toward the *safer* non-production
  default rather than silently running as production). `AUTH_SECRET`
  has a zod refinement rejecting the literal `.env.example` placeholder
  value and requires at least 32 characters, enforced at process
  startup regardless of `NODE_ENV` — a weak or placeholder secret fails
  to boot in any environment, not just production.

**Real, targeted changes made this phase** (see
`docs/deployment/production.md` for the operator-facing instructions):

- `apps/api/Dockerfile`, `apps/tracker/Dockerfile`,
  `apps/dashboard/Dockerfile`, `.dockerignore` — production container
  images. None existed before this phase; only a dev-only
  `docker/docker-compose.yml` (Postgres + Redis for local development)
  existed.
- `apps/dashboard/next.config.mjs` — added `output: "standalone"` and
  `outputFileTracingRoot` so the dashboard's Docker image can ship a
  minimal, self-contained server bundle instead of the whole workspace's
  `node_modules`. Verified with a real `pnpm --filter @adstrackio/dashboard build`
  (see §11 quality gates) — `.next/standalone/apps/dashboard/server.js`
  is produced as expected.
- `GET /ready` added to both `apps/api` and `apps/tracker` — see §7
  Observability.

**Not verified end-to-end in this session**: `docker build` for the
three new Dockerfiles could not be run to completion. This development
session's network policy blocks `production.cloudfront.docker.com` (the
CDN Docker Hub serves image layer blobs from), which the local `dockerd`
needs to pull the `node:20-alpine` base image — a sandboxed egress
restriction specific to this session, not a defect found in the
Dockerfiles. What *was* verified directly, without fabricating a Docker
build result:
- Every shell command each Dockerfile runs (`pnpm install`,
  `pnpm db:generate`, `pnpm exec turbo run build --filter=...`) is
  exactly what this phase's own quality-gate runs already exercise
  successfully outside a container (§11).
  `pnpm prune --prod` was deliberately **not** run directly against this
  session's own working tree (it would strip the devDependencies this
  same session still needs for lint/test/typecheck) — its behavior is
  standard, documented pnpm behavior, not something this phase
  independently re-verified.
- The dashboard's `output: "standalone"` build was run directly
  (outside Docker) and its output inspected — confirmed real, not
  assumed.
- Build these images in an environment with normal Docker Hub access
  before relying on them; this is a known limitation of this session,
  not a claim that the Dockerfiles are untested in principle.

## 2 & 3. Real tracking domain readiness / transparent redirect production verification

Covered in full in `docs/compliance/production-tracker-verification.md`
(the exact production `curl`/compliance-tool commands and expected
responses) and `docs/deployment/production.md#4-real-tracking-domain-setup`
(the DNS/HTTPS/reverse-proxy procedure). Summary of what's unchanged
from Phase 12's audit, re-confirmed against current code:

- `redirection_url` remains the immediate next hop —
  `apps/tracker/src/modules/tracker/tracker.routes.ts` still has exactly
  the two redirect call-sites Phase 12's `docs/compliance/redirect-audit.md`
  found (BOT→Safe Page, TARGET→`redirection_url`), unchanged.
- No hidden stored `Destination` can override it: the resolver
  (`apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts`)
  still never selects or returns `TrackingLink.destinationId`/
  `Destination` at all.
- Domain verification/activation gating unchanged: `VERIFIED` +
  `isActive` required at the service layer *and* a Postgres `CHECK`
  constraint (`tracking_domains_active_requires_verified`), re-confirmed
  by `apps/api/test/domains-lifecycle.test.ts`'s raw-SQL-bypass test,
  which still passes.
- Query parameters and fragments: `validateTransparentRedirectUrl`
  (`packages/shared/src/transparent-redirect.ts`) still parses once and
  redirects using that same parsed `URL` object — no re-derivation
  point where a query string or fragment could be dropped or altered.
- Paused/archived link behavior unchanged: an inactive `TrackingLink`
  (`status !== "ACTIVE"`) still 404s via the same resolver error path.
- Affiliate attribution: `Click.affiliatePartnerId` remains write-only
  from the redirect decision's point of view — still never read by
  `tracker.routes.ts` when deciding where to redirect (re-confirmed by
  reading the file; matches Phase 12's `redirect-audit.md` finding).

No code in the transparent-redirect path was changed this phase.

## 4. Production bot/routing verification

- **Single bot classification implementation**: `HeuristicBotDetectionEngine`
  (`apps/tracker/src/modules/bot-detection/heuristic-bot-detection-engine.ts`)
  remains the only `BotDetectionEngine` implementation wired into
  `buildTrackerApp`'s default (`apps/tracker/src/app.ts`) — grepped for
  any other `implements BotDetectionEngine`; none exist outside test
  fakes.
- **BOT → Safe Page remains authoritative**: `resolveRoutingDecision`
  (`packages/shared/src/routing-rules.ts`) still special-cases `BOT`
  ahead of any routing rule — unchanged.
- **Trusted country routing requires `TRUSTED_EDGE_SECRET`**:
  `isTrustedEdgeRequest`/`extractCountrySignal`
  (`packages/shared/src/routing-signals.ts`) still require a
  constant-time match against `env.TRUSTED_EDGE_SECRET`, which remains
  optional with no default — unset (the default) means COUNTRY never
  matches, full stop, regardless of what a request's geo headers claim.
- **Spoofed country headers cannot influence routing**: same mechanism
  as above — a header alone, without the matching secret header from a
  genuinely trusted edge, is inert. Re-confirmed by re-reading
  `constantTimeStringsEqual`'s use of `timingSafeEqual` over a SHA-256
  digest (not a naive `===`, which would leak timing information about
  a correct prefix).
- **No Google-vs-human deceptive cloaking introduced**: this phase added
  no new bot-detection or routing code at all — the only branch on
  traffic classification remains `BOT` vs. everything else, applied via
  the same policy for every request regardless of any signal that could
  identify "this specific request is a compliance reviewer."
- **Routing rules cannot create hidden destination behavior**: `RoutingRuleAction`
  remains constrained to `TARGET | SAFE_PAGE | BLOCK` in the schema
  (`packages/database/prisma/schema.prisma`) — there is no rule action
  that names an arbitrary URL.

## 5. Production security audit

Re-verified against current code (all Phase 11 findings, re-confirmed
rather than re-read from the old doc):

| Area | Finding |
| --- | --- |
| Authentication | Session JWT (HS256, `AUTH_SECRET`), `httpOnly`+`secure`(prod)+`SameSite=Lax` cookie. Unchanged. |
| RBAC | `fastify.requireOrganizationMember(minRole)` preHandler on every organization-scoped route; `OWNER`-role changes additionally gated by `assertActorCanManageOwnerRole`. Unchanged. |
| Organization isolation | Every query scoped by `organizationId` derived from the authenticated actor's membership or API key, never from client-supplied IDs alone — `apps/api/test/cross-org-isolation.test.ts` still passes (12 tests). |
| API-key authentication | `apps/api/src/plugins/api-key-auth.ts` dual-authenticates session-or-Bearer-key; keys are SHA-256 hashed, shown once at creation, never recoverable. |
| API scopes | Enforced per-route; a key's declared scopes gate which `/api/v1` operations it can perform. |
| API-key revocation/expiration | Both checked on every authenticated request; a revoked or expired key fails auth immediately (not just hidden from listings). |
| Idempotency | `IdempotencyRecord`'s `@@unique([organizationId, scope, key])` constraint makes concurrent duplicate `POST /conversions` requests with the same `Idempotency-Key` resolve to one record, not a race — this is a database constraint, not an application-level check that a race could slip past. |
| Webhook signing | HMAC-SHA256 over the exact raw request body, with a timestamp header and event ID (replay-resistant), signing secret encrypted at rest. |
| Webhook SSRF protection | Outbound webhook HTTP client uses a `net.BlockList`-based validator (`packages/shared/src/webhook-url.ts`) blocking private/loopback/link-local ranges, disables following redirects, and pins to the resolved IP (no DNS-rebinding window between validation and the actual request). |
| Webhook retry behavior | Bounded retries with backoff via the `WebhookDelivery` state machine; failures do not retry forever. |
| Rate limits | Global baseline (300/min production) plus a stricter per-route limit on auth endpoints (10/min production); `/api/v1` additionally rate-limits per API key/organization, not per IP, so one organization's traffic can't exhaust another's quota or the dashboard's own session traffic. The tracker route is deliberately **not** rate-limited — documented rationale: legitimate ad-click burst traffic often shares egress IPs, and this is unchanged Phase 3 policy. |
| Input validation | Every request body/query validated with `zod` schemas (`packages/validation`) before touching a service; Fastify's error handler maps validation failures to a uniform `400 VALIDATION_ERROR` shape that never echoes back which field leaked what. |
| SQL/Prisma safety | Prisma's query builder is used throughout; the handful of raw SQL usages (`$queryRaw`/`$executeRawUnsafe`) are either parameterized tagged templates or test-only DB-invariant probes (e.g. `apps/tracker/scripts/compliance-test.ts`'s new `/ready` check uses a literal, argument-free `SELECT 1` tagged template — no interpolation, no injection surface). |
| Security headers | `@fastify/helmet` on both backend services; dashboard headers added Phase 12 (§1 above). |
| CORS | Single explicit origin + credentials, not a wildcard (§1). |
| Secret handling | Never logged (redaction paths), never returned in API responses after creation (API keys, webhook secrets), never committed (`.env*` gitignored except `.env.example`). |
| Error responses | Uniform `{ error: { code, message } }` shape; internal errors return a generic 500 message in production, not a stack trace (`apps/api/src/plugins/error-handler.ts` / `apps/tracker/src/plugins/error-handler.ts`). |
| Logging | Structured JSON via Pino, redacted, silent in `NODE_ENV=test` to keep test output readable. |
| Audit logs | Every organization-scoped mutation (campaign/tracking-link/domain/referral/API-key/webhook lifecycle changes) writes an `AuditLog` row with the actor, action, and before/after where relevant — unchanged since Phase 6/9/11. |

No new vulnerability was found in this pass. No security-relevant code
was changed this phase (the `/ready` endpoints are read-only,
unauthenticated-by-design health probes with no user input and no
side effects — the same trust level as the pre-existing `/health`).

## 6. Database/backup readiness

- **Migration status**: `pnpm --filter @adstrackio/database exec prisma migrate status`
  reports "Database schema is up to date!" against this branch — see
  §11 for the exact run. This phase added **zero** migrations; `packages/database/prisma/schema.prisma`
  is byte-for-byte unchanged from the merged Phase 12 branch.
- **Production migration procedure**: documented in
  `docs/deployment/production.md#5-database-migrations-in-production`
  (`prisma migrate deploy`, run as a pre-deploy release step, never
  raced against application instances).
- **Backup/restore expectations**: documented in
  `docs/deployment/production.md#6-backup-and-restore-expectations` —
  this codebase does not implement backup/restore itself (that's
  infrastructure, typically a managed Postgres provider's job); the doc
  covers what's specific to this schema (which tables matter most,
  what a restore does to revoked secrets).
- **No destructive migration introduced**: confirmed — no migration
  file was added or modified this phase at all.
- **Indexes for production reporting and tracker queries**: reviewed
  every `@@index`/`@@unique` in the schema against the query patterns
  in `apps/tracker/src/modules/tracker/prisma-tracking-resolver.ts` and
  `apps/api/src/modules/analytics/analytics.service.ts`/
  `apps/api/src/modules/reports/reports.service.ts`. Every hot-path
  lookup and every reporting aggregation's filter/sort columns already
  have a covering index or unique constraint (added incrementally as
  each query pattern was introduced in Phases 3/4/7/9/10). No new index
  was needed; none was added, per the brief's "do not introduce
  unnecessary schema changes."

## 7. Observability

Added this phase, both deliberately kept off the tracker's redirect hot
path (a separate route registration, never called from or awaited by
`GET /:slug`):

- **`GET /health`** (pre-existing, both `apps/api` and `apps/tracker`):
  liveness only — proves the process is running and can respond, no
  dependency checks. `{ "status": "ok", "service": "api" | "tracker" }`.
- **`GET /ready`** (new, both services): readiness — additionally
  confirms the database is reachable via a trivial `SELECT 1`. Returns
  `200 { "status": "ready", "service": "..." }` on success, `503
  { "status": "not_ready", "service": "..." }` and logs the error on
  failure. Intended for a load balancer/orchestrator's readiness probe
  (stop routing traffic here without restarting the process, e.g.
  during a database failover) — distinct from liveness, which should
  restart the process on failure. Covered by
  `apps/api/src/app.test.ts` and `apps/tracker/src/app.test.ts`.
- **Structured logs**: already covered in §1 — Pino JSON logs, redacted,
  one line per request (Fastify's built-in request/response logging)
  plus explicit `app.log.error(...)` calls at every meaningful failure
  point already in the codebase:
  - **Tracker redirect failures**: the tracker's error handler
    (`apps/tracker/src/plugins/error-handler.ts`) logs every mapped
    error (validation, not-found, inactive-link) at an appropriate
    level before returning the uniform error response.
  - **Bot classification failures**: `classifyWithFallback`
    (`apps/tracker/src/modules/bot-detection/classify-with-fallback.ts`)
    already logs and falls back to a safe default classification rather
    than letting a detector exception break the redirect — unchanged,
    re-confirmed this phase.
  - **Routing failures**: routing-rule evaluation errors are caught and
    logged in the same request-handling path, falling back to the
    campaign default policy rather than 500ing a legitimate click.
  - **Webhook delivery failures**: `WebhookDelivery` rows record
    per-attempt failure reasons; the delivery worker
    (`apps/api/src/modules/webhooks/webhook-delivery-worker.ts`) logs
    each failed iteration without crashing the poll loop.
  - **Database/Redis connection failures**: the new `/ready` endpoints
    are exactly this — a database connection failure now has a
    dedicated, explicitly-logged, externally-pollable signal instead of
    only surfacing as scattered per-request errors. Redis is not
    connected to by anything (§1), so there is no Redis connection
    failure mode to observe; documented as a known gap, not
    fabricated.
- **Known gap, explicitly not addressed this phase**: no
  metrics/tracing (Prometheus, OpenTelemetry, etc.) is wired up — this
  codebase's observability is structured logs plus the two health
  endpoints, not a full metrics pipeline. Reasonable for the current
  scale and explicitly out of scope for "lightweight production
  observability" per the brief; a future phase can add a metrics
  exporter if operational needs demand it.

## Limitations / remaining manual production steps

Everything below is an operator action this codebase's code cannot
perform on its own — listed here once, referenced from the other Phase
13 documents rather than repeated:

- Building and pushing the Docker images in an environment with normal
  registry access (this session's `docker build` was blocked by
  network policy — §1).
- Provisioning a real server/cluster to run them.
- Registering a real tracking domain, publishing its DNS TXT record,
  and completing verification against a live deployment.
- Pointing DNS at the tracker deployment and terminating TLS in front
  of it.
- Provisioning a production PostgreSQL instance and configuring its
  backup/snapshot policy.
- Actually submitting a Google Ads Transparent Click Tracker
  certification application — this document, and this phase generally,
  prepares evidence for that submission; it does not perform it.
