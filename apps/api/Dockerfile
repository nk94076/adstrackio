#
# Production image for @adstrackio/api.
#
# Build from the MONOREPO ROOT (this app depends on several workspace
# packages under packages/*, so the build needs the whole workspace as
# context), e.g.:
#
#   docker build -f apps/api/Dockerfile --target runtime -t adstrackio-api .
#   docker run --env-file .env.production -p 127.0.0.1:4000:4000 adstrackio-api
#
# See docs/deployment/production.md for the full production environment
# variable list, migration procedure, and reverse-proxy expectations,
# and docker/docker-compose.production.yml for how this image is
# actually run alongside postgres/redis/tracker/dashboard.
#
# Stages:
#   build    - installs the whole workspace, generates the Prisma client,
#              builds this package with Turborepo. Still has
#              devDependencies (including the `prisma` CLI, which
#              `@adstrackio/database` only lists as a devDependency).
#   migrate  - same image as `build`, just a different ENTRYPOINT: runs
#              `prisma migrate deploy` (never `migrate dev` — that command
#              can prompt interactively and is development-only). This is
#              the ONLY stage in this repository's Docker images that
#              ships the `prisma` CLI; the runtime stage below does not.
#   deployed - `pnpm --filter @adstrackio/api deploy --prod` (see below
#              for why this replaced `pnpm prune --prod`): a
#              self-contained directory with this package's own files
#              plus every production dependency it resolves to,
#              INCLUDING @adstrackio/* workspace packages — real copies,
#              not symlinks back into this build stage's /repo. This is
#              what makes the runtime stage below independent of
#              anything outside itself.
#   runtime  - a fresh base image, running as a non-root user, with only
#              the deployed output copied in. This is the image actually
#              deployed for the api service.
#
# Why `pnpm deploy`, not `pnpm prune --prod`:
# The obvious approach — `pnpm prune --prod` on the built /repo, then
# copy all of /repo into the runtime stage — silently produces a BROKEN
# image in this workspace layout: `pnpm prune --prod` does not merely
# remove devDependency packages here, it removes node_modules content
# needed by @adstrackio/api's own runtime dependencies too (confirmed by
# direct inspection: apps/api/node_modules and the workspace symlinks
# under it, including @adstrackio/config, do not survive it), which is
# exactly what caused the ERR_MODULE_NOT_FOUND crash loop on
# @adstrackio/config in production. `pnpm deploy` is pnpm's own
# purpose-built command for extracting ONE package from a workspace
# into a standalone, runnable directory — it resolves the full
# production dependency graph (including workspace packages) into real
# files under the target directory's own node_modules, so the runtime
# stage below needs nothing from outside what gets copied into it.
# `--legacy` is required because this workspace does not set
# `inject-workspace-packages=true` in .npmrc (that setting changes how
# EVERY `pnpm install` links workspace packages, including for local
# development — out of scope for a production-packaging fix); the
# legacy deploy implementation works without it.
#
# Why node:20-slim (Debian), not node:20-alpine (musl):
# This image previously built FROM node:20-alpine. In production that
# repeatedly produced a Prisma query engine mismatch: Alpine's minimal
# image doesn't ship the `openssl` package, so Prisma's own OpenSSL
# version detection — both when `prisma generate` resolves what
# "native" means during the build stage below, and again when
# @prisma/client picks an engine to load at container startup — can
# silently fall back to identifying the platform as the legacy bare
# "linux-musl" target (an engine linked against OpenSSL 1.1.x, which
# this image never had and was never going to install, since that
# would mean shipping a known-EOL OpenSSL release as a workaround)
# instead of "linux-musl-openssl-3.0.x", crashing with
# `PrismaClientInitializationError: Error loading shared library
# libssl.so.1.1`. Explicit `binaryTargets` and a pinned
# PRISMA_QUERY_ENGINE_LIBRARY (both still present below) narrow this,
# but musl/OpenSSL-3 detection has proven persistently fragile across
# several rounds of fixing it directly. node:20-slim (Debian) uses
# Prisma's "debian-openssl-3.0.x" engine target — by far Prisma's most
# mature, most widely used engine target, and the one every quality
# gate and local dev/test run in this repository has already been
# exercising successfully throughout (this is a glibc/Debian-family
# sandbox). This also removes an entire class of native-addon
# compatibility risk beyond just Prisma: musl libc is a recurring
# source of subtle breakage for OTHER native Node addons this
# workspace depends on (e.g. argon2, used for password hashing) that
# simply doesn't exist under glibc. The image is somewhat larger than
# Alpine; that tradeoff is accepted deliberately for reliability, per
# an explicit production-fix requirement to make exactly this
# architecture call if it's materially safer than continuing to fight
# Alpine/musl OpenSSL detection.

FROM node:20-slim AS build
RUN corepack enable
# OpenSSL 3 + CA certificates, explicit rather than assumed present in
# the slim base — `prisma generate`'s own platform/OpenSSL-version
# detection (which decides what "native" resolves to, i.e. what engine
# gets generated for local dev/CI) needs the real `openssl` package on
# disk to detect correctly, not just whatever OpenSSL Node.js itself
# happens to be statically/dynamically linked against. ca-certificates
# is needed for this app's own outbound HTTPS calls (webhook delivery).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# pnpm 10 prompts for confirmation before removing/recreating the
# modules directory in some install/prune scenarios; with no TTY
# attached (every `docker build`, and CI generally), that prompt can't
# be answered and pnpm aborts with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY instead of hanging. Setting
# CI=true (pnpm's own recognized non-interactive signal, the same one
# npm/yarn honor) tells it to skip the prompt and proceed, for every
# pnpm command below and in the `migrate`/`deployed` stages that build
# FROM this one (install, db:generate, the turbo build, `prisma migrate
# deploy`, and `pnpm deploy`). This is scoped to this build stage only,
# not a global `pnpm config set confirmModulesPurge false` — it never
# weakens the safety check for a developer running these same commands
# locally.
ENV CI=true

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm exec turbo run build --filter=@adstrackio/api

FROM build AS migrate
WORKDIR /repo/packages/database
ENTRYPOINT ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM build AS deployed
RUN pnpm --filter @adstrackio/api deploy --prod --legacy /deploy

FROM node:20-slim AS runtime
ENV NODE_ENV=production
# OpenSSL 3 + CA certificates in the runtime image too — this is what
# the deployed Prisma query engine (libquery_engine-debian-openssl-3.0.x.so.node,
# pinned explicitly below) dynamically links against at container
# startup, and what this app's own outbound HTTPS calls need.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Pin the Prisma query engine explicitly rather than letting
# @prisma/client auto-detect it at startup — belt-and-suspenders on
# top of the node:20-slim switch above and the explicit `openssl`
# package install, not a substitute for either: even with the correct
# engine reliably generated and the right system libraries present,
# there's no reason to make container startup depend on Prisma's own
# platform-detection code path succeeding when the file to load can
# just be named directly. This is the x86_64 (amd64) engine, matching
# this image's actual VPS production architecture; an arm64 build of
# this image would need the sibling
# libquery_engine-linux-arm64-openssl-3.0.x.so.node file instead (also
# generated, not shipped-but-unused — see
# packages/database/prisma/schema.prisma's binaryTargets).
ENV PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/@adstrackio/database/generated/client/libquery_engine-debian-openssl-3.0.x.so.node
RUN groupadd --system adstrackio \
  && useradd --system --gid adstrackio --no-create-home --shell /usr/sbin/nologin adstrackio
WORKDIR /app
COPY --chown=adstrackio:adstrackio --from=deployed /deploy /app
USER adstrackio

EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
