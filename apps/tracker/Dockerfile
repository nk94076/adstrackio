#
# Production image for @adstrackio/tracker — the Google-facing
# transparent click tracker. See docs/compliance/google-transparent-click-tracker.md
# for what this process does and docs/deployment/production.md for
# tracking-domain/reverse-proxy requirements in front of it.
#
# Build from the MONOREPO ROOT (this app depends on several workspace
# packages under packages/*, so the build needs the whole workspace as
# context), e.g.:
#
#   docker build -f apps/tracker/Dockerfile -t adstrackio-tracker .
#   docker run --env-file .env.production -p 4100:4100 adstrackio-tracker
#
# This single build stage installs, generates the Prisma client, builds,
# then prunes devDependencies before the runtime stage copies the result
# — correctness and a reasonably small image, not a fully pruned
# single-package bundle (see docs/deployment/production.md for the
# tradeoff).

FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo

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
CMD ["node", "dist/index.js"]
