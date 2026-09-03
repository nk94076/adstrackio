#
# Production image for @adstrackio/tracker — the Google-facing
# transparent click tracker. See
# docs/compliance/google-transparent-click-tracker.md for what this
# process does and docs/deployment/production.md for how it's expected
# to sit behind an existing Apache reverse proxy on a single VPS.
#
# Build from the MONOREPO ROOT (this app depends on several workspace
# packages under packages/*, so the build needs the whole workspace as
# context), e.g.:
#
#   docker build -f apps/tracker/Dockerfile --target runtime -t adstrackio-tracker .
#   docker run --env-file .env.production -p 127.0.0.1:4100:4100 adstrackio-tracker
#
# This image does not run migrations — see apps/api/Dockerfile's
# `migrate` stage, which is the one place in this repository that ships
# the `prisma` CLI.
#
# Why `pnpm deploy`, not `pnpm prune --prod`:
# The obvious approach — `pnpm prune --prod` on the built /repo, then
# copy all of /repo into the runtime stage — silently produces a BROKEN
# image in this workspace layout: `pnpm prune --prod` does not merely
# remove devDependency packages here, it removes node_modules content
# needed by @adstrackio/tracker's own runtime dependencies too
# (confirmed by direct inspection: apps/tracker/node_modules and the
# workspace symlinks under it, including @adstrackio/config, do not
# survive it), which is exactly what caused the ERR_MODULE_NOT_FOUND
# crash loop on @adstrackio/config in production. `pnpm deploy` is
# pnpm's own purpose-built command for extracting ONE package from a
# workspace into a standalone, runnable directory — it resolves the
# full production dependency graph (including workspace packages) into
# real files under the target directory's own node_modules, so the
# runtime stage below needs nothing from outside what gets copied into
# it. `--legacy` is required because this workspace does not set
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
# pnpm command below — install, db:generate, the turbo build, and
# `pnpm deploy`. This is scoped to this build stage only, not a global
# `pnpm config set confirmModulesPurge false` — it never weakens the
# safety check for a developer running these same commands locally.
ENV CI=true

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm exec turbo run build --filter=@adstrackio/tracker

FROM build AS deployed
RUN pnpm --filter @adstrackio/tracker deploy --prod --legacy /deploy

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Pin the Prisma query engine explicitly rather than letting
# @prisma/client auto-detect it at startup. On this exact base image
# (node:20-alpine, musl libc, OpenSSL 3), Prisma's own runtime platform
# detection has been observed to identify itself as the legacy bare
# "linux-musl" target (an OpenSSL-1.1-linked engine Prisma stopped
# building this Docker image against once OpenSSL 3 support was added)
# instead of "linux-musl-openssl-3.0.x", causing
# `Error loading shared library libssl.so.1.1: No such file or
# directory` — libssl.so.1.1 was never installed on this image and
# never will be; that's not a dependency this image is missing, it's
# Prisma choosing the wrong one of the several engines
# packages/database/prisma/schema.prisma's `binaryTargets` already
# generates and pnpm deploy already ships (see the "deployed" stage
# above). Setting PRISMA_QUERY_ENGINE_LIBRARY bypasses that detection
# entirely and always loads the correct, already-present OpenSSL-3
# musl engine. This is the x86_64 (amd64) engine, matching this
# image's actual VPS production architecture; an arm64 build of this
# image would need the sibling
# libquery_engine-linux-musl-arm64-openssl-3.0.x.so.node file instead
# (also generated, not shipped-but-unused — see binaryTargets).
ENV PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/@adstrackio/database/generated/client/libquery_engine-linux-musl-openssl-3.0.x.so.node
RUN addgroup -S adstrackio && adduser -S adstrackio -G adstrackio
WORKDIR /app
COPY --chown=adstrackio:adstrackio --from=deployed /deploy /app
USER adstrackio

EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
