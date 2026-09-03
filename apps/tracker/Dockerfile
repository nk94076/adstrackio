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
# the `prisma` CLI. This build stage installs, generates the Prisma
# client, builds, then prunes devDependencies before the runtime stage
# copies the result — correctness and a reasonably small image, not a
# fully pruned single-package bundle (see docs/deployment/production.md
# for the tradeoff).

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
# `pnpm prune --prod`. This is scoped to this build stage only, not a
# global `pnpm config set confirmModulesPurge false` — it never weakens
# the safety check for a developer running these same commands locally.
ENV CI=true

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm exec turbo run build --filter=@adstrackio/tracker
RUN pnpm prune --prod

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
RUN addgroup -S adstrackio && adduser -S adstrackio -G adstrackio
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/tracker
USER adstrackio

EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
