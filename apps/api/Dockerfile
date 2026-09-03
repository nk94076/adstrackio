#
# Production image for @adstrackio/api.
#
# Build from the MONOREPO ROOT (this app depends on several workspace
# packages under packages/*, so the build needs the whole workspace as
# context), e.g.:
#
#   docker build -f apps/api/Dockerfile -t adstrackio-api .
#   docker run --env-file .env.production -p 4000:4000 adstrackio-api
#
# See docs/deployment/production.md for the full production environment
# variable list, migration procedure, and reverse-proxy expectations.
# This single build stage installs, generates the Prisma client, builds,
# then prunes devDependencies before the runtime stage copies the result
# — correctness and a reasonably small image, not a fully pruned
# single-package bundle (see that doc for the tradeoff).

FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm exec turbo run build --filter=@adstrackio/api
RUN pnpm prune --prod

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
RUN addgroup -S adstrackio && adduser -S adstrackio -G adstrackio
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
USER adstrackio

EXPOSE 4000
CMD ["node", "dist/index.js"]
