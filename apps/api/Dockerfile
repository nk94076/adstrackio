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

FROM node:20-alpine AS build
RUN corepack enable
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

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
RUN addgroup -S adstrackio && adduser -S adstrackio -G adstrackio
WORKDIR /app
COPY --chown=adstrackio:adstrackio --from=deployed /deploy /app
USER adstrackio

EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
