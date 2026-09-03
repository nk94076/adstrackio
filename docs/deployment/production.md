# Production Deployment (Docker Compose, single VPS)

How to run AdstrackIO in production on a single Ubuntu VPS using Docker
Compose, behind an **existing** Apache reverse proxy (e.g. a Hostinger
VPS with Apache already configured and doing TLS termination). This
document does not configure or modify that Apache setup — it documents
exactly what Apache needs to reverse-proxy to, and nothing about how to
set Apache up.

This does not claim Google certification/approval of anything — see
`docs/compliance/google-transparent-click-tracker.md` for the tracker's
transparency architecture and certification-readiness status, unrelated
to and unaffected by this document.

## 1. Architecture

```
Internet
   │  HTTPS (Apache terminates TLS; not covered here)
   ▼
Apache (existing, on the same VPS, not modified by this document)
   │  reverse-proxies each public hostname to a LOOPBACK port
   ├── app.yourdomain.com    → http://127.0.0.1:3000  (dashboard)
   ├── api.yourdomain.com    → http://127.0.0.1:4000  (api)
   └── track.yourdomain.com  → http://127.0.0.1:4100  (tracker)
   │
   ▼
Docker Compose (docker/docker-compose.production.yml)
   ┌─────────────────────────────────────────────────────────┐
   │  adstrackio_internal (private bridge network)            │
   │                                                            │
   │   dashboard:3000  api:4000  tracker:4100                 │
   │        │              │           │                      │
   │        └──────────────┴───────────┴──── postgres:5432    │
   │                                          redis:6379       │
   │                                                            │
   │  postgres/redis: NO ports published to the host at all.  │
   │  api/tracker/dashboard: published ONLY to 127.0.0.1,     │
   │  never 0.0.0.0 — nothing but Apache (and anyone with a   │
   │  shell on the VPS) can reach them.                       │
   └─────────────────────────────────────────────────────────┘
```

No Nginx, no Caddy, no other reverse proxy is introduced by this
document or these files — Apache is the only public-facing HTTP server
on the VPS, exactly as it already is today.

## 2. Files this phase added

| File | Purpose |
| --- | --- |
| `apps/api/Dockerfile` | Multi-stage production image (`build` → `migrate` / `pruned` → `runtime`). |
| `apps/tracker/Dockerfile` | Multi-stage production image (`build` → `runtime`). |
| `apps/dashboard/Dockerfile` | Multi-stage production image using Next.js `output: "standalone"`. |
| `.dockerignore` | Keeps `node_modules`, `.git`, build artifacts, etc. out of the build context. |
| `docker/docker-compose.production.yml` | The 5 services (postgres, redis, api, tracker, dashboard) + the one-shot `migrate` job. |
| `.env.production.example` | Template for the real `.env.production` file you create on the VPS (never committed). |
| `apps/dashboard/next.config.mjs` | Added `output: "standalone"` + `outputFileTracingRoot` (Next.js/pnpm-workspace requirement for a lean Docker image). |
| `apps/api/src/app.ts`, `apps/tracker/src/app.ts` | Added `GET /ready` (database-connectivity healthcheck, separate from the pre-existing `/health` liveness check). |

`docker/docker-compose.yml` (dev-only Postgres+Redis for `pnpm dev`) is
unchanged and unrelated — do not run both compose files against the
same host at once (port/volume-name collisions).

## 3. One-time VPS setup

1. Install Docker Engine and the Docker Compose plugin on the VPS
   (`docker compose version` should report a v2 client). This document
   assumes both are already installed, per the brief's premise.
2. Clone this repository onto the VPS, e.g. `/opt/adstrackio`.
3. Copy the environment template and fill in real values:
   ```sh
   cp .env.production.example .env.production
   chmod 600 .env.production
   ```
   Generate `AUTH_SECRET`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and
   (optionally) `CLICK_IP_HASH_SALT` with `openssl rand -base64 48` (or
   similar) — every variable is documented inline in
   `.env.production.example`. Set `APP_URL`/`API_URL`/`TRACKER_URL`/
   `NEXT_PUBLIC_API_URL` to the real HTTPS hostnames Apache will front.
   **Never commit `.env.production`** — `.gitignore` excludes it
   (fixed this phase: the pre-existing pattern only excluded `.env`,
   `.env.local`, and `.env.*.local`, which does not match
   `.env.production` — a real gap, now closed).
4. Configure Apache's virtual hosts for `app.`/`api.`/`track.`
   yourdomain.com to reverse-proxy to `127.0.0.1:3000` / `127.0.0.1:4000`
   / `127.0.0.1:4100` respectively, with TLS termination on Apache's
   side (this document does not provide Apache config — that's the
   "existing Hostinger Apache configuration" this phase is explicitly
   not to touch). Forward the `Host` header unchanged for the tracker
   vhost specifically — the resolver matches on it
   (`apps/tracker/src/modules/tracker/tracker.routes.ts`'s
   `normalizeRequestHostname`). Do not let Apache cache, rewrite, or
   otherwise interfere with the tracker's `Location` response header —
   see §8.

## 4. Build

```sh
cd /opt/adstrackio
docker compose --env-file .env.production -f docker/docker-compose.production.yml build
```

Builds `api`, `tracker`, and `dashboard`'s `runtime` targets (the
`migrate` target, sharing the `api` Dockerfile's `build` stage, is built
on demand by the command in §5, not by a plain `build`). This can take
several minutes the first time (installs the whole pnpm workspace).

## 5. Migrate

**Always run this before starting `api`/`tracker` for the first time,
and again after every update that includes a new migration** — see §9
for the update procedure this fits into.

```sh
docker compose --env-file .env.production -f docker/docker-compose.production.yml \
  --profile tools run --rm migrate
```

This runs `prisma migrate deploy` (never `prisma migrate dev` — that
command is interactive/development-only and this repository's
Dockerfiles do not even ship the `prisma` CLI outside the dedicated
`migrate` build target, specifically so it can't be reached for by
accident in the `api`/`tracker` runtime images). `migrate` uses the
`--profile tools` flag specifically so it is never started by a plain
`docker compose up` — it is a one-shot job you run explicitly.

Check status non-destructively at any time, without applying anything:

```sh
docker compose --env-file .env.production -f docker/docker-compose.production.yml \
  --profile tools run --rm migrate sh -c \
  "cd /repo/packages/database && pnpm exec prisma migrate status"
```

## 6. Start

```sh
docker compose --env-file .env.production -f docker/docker-compose.production.yml up -d
```

Starts `postgres`, `redis`, `api`, `tracker`, `dashboard` (in that
dependency order — `api`/`tracker` wait for `postgres`'s healthcheck to
pass before starting). `migrate` is excluded (its `profiles: ["tools"]`
setting) and never starts as part of this command.

## 7. Logs

```sh
docker compose --env-file .env.production -f docker/docker-compose.production.yml logs -f
docker compose --env-file .env.production -f docker/docker-compose.production.yml logs -f tracker   # one service
```

Every application log line is structured JSON (Pino) with secrets/
tokens/session cookies/raw IPs redacted before they're ever written —
see `packages/logger`'s `REDACT_PATHS` and
`docs/architecture/security.md`'s security posture summary.
`postgres`/`redis` log their own startup and query/connection activity
as those images normally do; neither is configured by this repository
to log query contents that would include application secrets (the
application never sends secrets as SQL literals — Prisma parameterizes
every query it issues from application code).

## 8. Health checks

Every application service has a container-level `HEALTHCHECK`
(`docker ps` shows `healthy`/`unhealthy`/`starting`) hitting its own
`GET /ready` (api/tracker) or `GET /` (dashboard) over loopback from
inside the container — see each `Dockerfile`. `postgres`/`redis` use
their standard `pg_isready`/`redis-cli ping` checks.

```sh
docker compose --env-file .env.production -f docker/docker-compose.production.yml ps
```

To check from the VPS host itself (what Apache would see):

```sh
curl -s http://127.0.0.1:4000/ready    # api
curl -s http://127.0.0.1:4100/ready    # tracker
curl -s http://127.0.0.1:3000/         # dashboard
```

`/health` (liveness — process is running) is distinct from `/ready`
(readiness — the database is actually reachable); see
`apps/api/src/app.ts`/`apps/tracker/src/app.ts`.

**Verifying the tracker's transparent-redirect behavior specifically**
(the part that must never change): once a real tracking domain and link
exist, use `pnpm compliance:test -- --remote` with `TRACKER_URL`,
`COMPLIANCE_TEST_HOSTNAME`, and `COMPLIANCE_TEST_SLUG` set (see
`apps/tracker/scripts/compliance-test.ts`'s own header comment and
`docs/compliance/google-certification-checklist.md` for the exact
variables and expected `Location`-header results) — this document only
covers standing the containers up, not the tracker's redirect
semantics, which this phase does not touch.

## 9. Safe update / rollback procedure

1. `git pull` (or check out the new commit/tag) on the VPS.
2. Rebuild:
   ```sh
   docker compose --env-file .env.production -f docker/docker-compose.production.yml build
   ```
3. Run migrations (§5) — every migration in this repository to date is
   additive (new nullable/defaulted columns, new tables, new indexes;
   never a drop), so this is always safe to run before swapping the
   application containers, and old containers keep working correctly
   against a newer schema if a rollback is needed mid-update.
4. Recreate the application containers with the new images:
   ```sh
   docker compose --env-file .env.production -f docker/docker-compose.production.yml up -d
   ```
   Compose only recreates containers whose image/config actually
   changed — `postgres`/`redis` are left untouched if their service
   definitions didn't change.
5. Check health (§8) before considering the update complete.

**Rollback**: because every migration is additive, rolling back is
almost always just re-deploying the previous image tag/commit and
running step 4 again — the old code works fine against the (newer,
strictly additive) schema. Only if a specific migration must be
schema-level reverted, write and apply a new forward migration that
undoes it (`prisma migrate deploy` has no built-in "undo" for an
already-applied migration); this is the same review process as any
other schema change, not a special rollback command. If data must be
restored (not just schema), restore the `adstrackio_postgres_data`
volume (or your own external Postgres backup, if you've configured one
— this repository does not implement backup/restore itself) from
before the migration ran.

## 10. Security decisions specific to this deployment

- **postgres/redis are never published to the host.** No `ports:` entry
  for either service in `docker-compose.production.yml` — the only way
  to reach them is from another container on the `adstrackio_internal`
  network. This is the actual isolation mechanism, not marking the
  network `internal: true` (which would also cut off `api`/`tracker`'s
  legitimate outbound internet access, e.g. webhook delivery to
  external endpoints).
- **api/tracker/dashboard are published to `127.0.0.1` only, never
  `0.0.0.0`.** Apache (running directly on the VPS, not in a container)
  reaches them over loopback; nothing external can reach these ports
  directly even if the VPS's firewall were misconfigured to allow
  inbound traffic to them, because Docker never binds them to a
  non-loopback interface in the first place.
- **Every application container runs as a non-root user** (`adstrackio`,
  created in each Dockerfile's runtime stage) — a container escape or a
  dependency RCE inside one of these processes does not hand over root
  inside the container, let alone the host.
- **`security_opt: no-new-privileges:true`** on every application/
  database/cache service — blocks a process inside the container from
  gaining privileges beyond its starting set (e.g. via a setuid binary),
  standard defense-in-depth for a service that shouldn't need it.
- **`prisma` (the CLI) is not present in the `api`/`tracker` runtime
  images** — only the dedicated `migrate` build target has it (built
  from the pre-`pnpm prune --prod` `build` stage). The application
  processes never need it at runtime, so it's not there to be a
  misconfigured entry point or an accidentally-exposed migration
  command.
- **Credentials only ever come from environment variables**
  (`.env.production`, never committed, `chmod 600`'d) — nothing in any
  Dockerfile or compose file hardcodes a password, secret, or
  connection string. `POSTGRES_PASSWORD`/`REDIS_PASSWORD` use Compose's
  `${VAR:?message}` syntax, so `docker compose` itself refuses to start
  anything if they're unset, rather than silently starting an
  unauthenticated database.
- **Secrets are never printed in application logs** — Pino's redaction
  config (`packages/logger`) strips `AUTH_SECRET`/API keys/webhook
  secrets/session cookies from every log line before it's written, not
  just in this deployment but everywhere the logger is used (including
  local development).
- **NEXT_PUBLIC_API_URL is a build-time value.** It's a `NEXT_PUBLIC_*`
  variable, which Next.js inlines into the browser-shipped JavaScript
  bundle at `next build` — passing it only as a container runtime env
  var (`docker run -e`) has no effect on an already-built image. The
  dashboard Dockerfile takes it as a build ARG specifically so this
  can't be gotten wrong silently.

## 11. What this phase did not change

- **The transparent redirect is unchanged, byte-for-byte, in behavior.**
  `GET /:slug?redirection_url=<visible-destination>` still redirects to
  exactly that validated destination; no hidden stored `Destination` can
  override it; `BOT` traffic still routes to the campaign's Safe Page
  and nothing else does. This phase touched zero lines in
  `apps/tracker/src/modules/tracker/tracker.routes.ts`,
  `packages/shared/src/transparent-redirect.ts`, or
  `packages/shared/src/routing-rules.ts`. See
  `docs/compliance/redirect-audit.md` (Phase 12) for the full,
  still-accurate audit of every redirect-shaped code path in this
  repository.
- **No new synchronous external calls were added to the tracker's hot
  path.** The new `GET /ready` endpoint is a separate route, never
  called from or awaited by `GET /:slug`.
- **No database schema changes.** `packages/database/prisma/schema.prisma`
  is unchanged; `prisma migrate status` reports up to date (see §12).
- **This does not claim Google certification, approval, or verification
  of anything.** See `docs/compliance/google-transparent-click-tracker.md`
  for the actual (not-certified) status of the transparency work; this
  document is purely about running the existing, unmodified application
  in containers.

## 12. Commands run to verify this phase (recorded results)

See this phase's pull request description for the exact recorded
output of:

```sh
pnpm lint
pnpm typecheck
pnpm turbo run test --force
pnpm build
pnpm --filter @adstrackio/database exec prisma migrate status
```

## 13. Limitations

- `docker compose build`/`docker build` for these images may not
  succeed in every environment — building requires pulling
  `node:20-alpine`, `postgres:16-alpine`, and `redis:7-alpine` from
  Docker Hub, which some sandboxed/firewalled environments (including,
  at times, this repository's own CI/development sandbox) block at the
  network-policy level. That is an environment limitation, not a defect
  in these Dockerfiles — see this phase's PR description for exactly
  what was and wasn't possible to verify directly in the session that
  authored them.
- No backup/restore automation is included — see §9's rollback section
  for what this repository assumes about restoring the `postgres`
  volume; the actual backup schedule/mechanism is an operator decision.
- No metrics/tracing pipeline — `/health`, `/ready`, and structured logs
  are the only observability surface this repository provides.
- This document assumes Apache is already correctly configured with
  valid TLS certificates for all three hostnames; it does not provide
  or validate that configuration.
