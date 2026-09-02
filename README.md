# AdstrackIO

AdstrackIO is a performance marketing / attribution / click-tracking
platform, built toward Google Transparent Click Tracker certification.

**Current milestone: Phase 1 — Foundation.** This establishes the monorepo,
core data model, authentication, organizations/roles, and the API/dashboard
foundation that later phases build on. See `docs/architecture/overview.md`
for what's implemented vs. deliberately deferred, and
`docs/compliance/google-transparent-tracker.md` — **no certification has
been obtained or claimed.**

## Stack

- **Monorepo**: pnpm workspaces + Turborepo
- **Frontend**: Next.js (App Router), TypeScript, Tailwind CSS
- **Backend**: Node.js, TypeScript, Fastify
- **Database**: PostgreSQL + Prisma
- **Cache/queues**: Redis (wired for future use; no queues yet)
- **Testing**: Vitest (integration tests run against a real Postgres)
- **DevOps**: Docker Compose (Postgres + Redis only — apps run locally via pnpm)

## Repository layout

```
apps/
  api/         Fastify backend — auth, organizations, campaigns, tracking
               links, destinations, referrals, audit logs
  dashboard/   Next.js admin dashboard
  tracker/     Separate service boundary for the future Transparent Click
               Tracker (health check only in Phase 1)
packages/
  database/    Prisma schema + client
  auth/        Password hashing, session tokens, role helpers
  config/      Typed environment validation
  validation/  Zod request schemas
  shared/      API error shape, URL validation, TrackingResolver /
               BotDetectionEngine interfaces
  logger/      Structured logging with secret redaction
docker/        docker-compose.yml (Postgres + Redis)
docs/
  architecture/  overview.md, data-model.md, security.md
  compliance/    google-transparent-tracker.md
```

## Prerequisites

- Node.js 20+
- pnpm 9+ (`corepack enable` will provide the pinned version)
- Docker (for local Postgres + Redis)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres + Redis
docker compose -f docker/docker-compose.yml up -d

# 3. Configure environment variables
cp .env.example .env
cp apps/dashboard/.env.example apps/dashboard/.env.local
# Edit .env and set a real AUTH_SECRET, e.g.:
#   openssl rand -base64 48

# 4. Generate the Prisma client and run migrations
pnpm db:generate
pnpm db:migrate

# 5. (Optional) seed a demo organization/user for local login
pnpm db:seed
# creates owner@example.com / ChangeMe123! in a "Demo Organization"

# 6. Start everything
pnpm dev
```

This starts:

- API on `http://localhost:4000`
- Dashboard on `http://localhost:3000`
- Tracker on `http://localhost:4100` (health check only)

Visit `http://localhost:3000`, register an account (or log in with the
seeded demo account), and you'll land on the dashboard shell.

## Scripts

Run from the repo root (fanned out to every workspace by Turborepo):

| Command | Description |
| --- | --- |
| `pnpm dev` | Run all apps in development mode |
| `pnpm build` | Build all apps/packages |
| `pnpm test` | Run all test suites (Vitest) |
| `pnpm lint` | Lint all workspaces (ESLint) |
| `pnpm typecheck` | Type-check all workspaces (`tsc --noEmit`) |
| `pnpm format` | Format the repo with Prettier |
| `pnpm db:generate` | Generate the Prisma client |
| `pnpm db:migrate` | Run Prisma migrations (dev, interactive) |
| `pnpm db:migrate:deploy` | Apply migrations non-interactively (CI/prod) |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm db:seed` | Seed a demo organization/user |

## Running the API's integration tests

`apps/api`'s tests hit a real Postgres database (no mocking of Prisma) and
truncate tables between tests. By default they use
`postgresql://adstrackio:adstrackio@localhost:5432/adstrackio_test`, a
**separate database** from the one your app uses in development, so
running tests never wipes your local dev data:

```bash
# with docker/docker-compose.yml already up:
docker exec -it $(docker compose -f docker/docker-compose.yml ps -q postgres) \
  psql -U adstrackio -d adstrackio -c "CREATE DATABASE adstrackio_test;"

DATABASE_URL_TEST="postgresql://adstrackio:adstrackio@localhost:5432/adstrackio_test?schema=public" \
  pnpm --filter @adstrackio/database exec prisma migrate deploy \
  --schema packages/database/prisma/schema.prisma

pnpm --filter @adstrackio/api test
```

(`pnpm test` from the root runs this same suite along with every other
package's unit tests, once `adstrackio_test` exists and has migrations
applied.)

## Environment variables

See `.env.example` for the full list (`DATABASE_URL`, `REDIS_URL`,
`AUTH_SECRET`, `APP_URL`, `API_URL`, `TRACKER_URL`, ports). Validation lives
in `packages/config` — the API and tracker refuse to start with a missing,
too-short, or placeholder `AUTH_SECRET`. The dashboard additionally needs
`NEXT_PUBLIC_API_URL` in `apps/dashboard/.env.local` (Next.js only reads
env files from its own app directory, not the repo root).

## Known limitations

See `docs/architecture/security.md#known-limitations` for the full list
(no server-side session revocation, no email verification/password reset
yet, no explicit CSRF token, in-memory rate limiting). These are documented
tradeoffs for a Phase 1 foundation, not oversights.

## What's next (not implemented — do not build ahead of the roadmap)

**Phase 2 (Domain Manager) is implemented**: organizations can create
tracking domains, verify ownership via a real, server-checked DNS TXT
record, and activate a domain only once verified. See
`docs/architecture/data-model.md` and
`docs/architecture/security.md#domain-activation-invariant`. It is a
control-plane feature only — no redirect, destination resolution, click
logging, or bot routing.

Phase 3 onward (Transparent Click Tracker, Click Analytics, Bot Detection
Integration, Campaign Manager, Conversion Tracking, Rules & Routing Engine,
Affiliate/Partner System, Attribution & Advanced Reporting, API +
Integrations, Google Certification Preparation & Submission) build on this
foundation. See `docs/architecture/overview.md` for the boundaries Phase 1
set up specifically so those phases don't require a rewrite.
