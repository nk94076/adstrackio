#
# Production image for @adstrackio/dashboard. Not part of the
# Google-facing tracker surface — this is the internal, session-cookie
# authenticated admin UI.
#
# Build from the MONOREPO ROOT, e.g.:
#
#   docker build -f apps/dashboard/Dockerfile --target runtime -t adstrackio-dashboard \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.yourdomain.com .
#   docker run -p 127.0.0.1:3000:3000 adstrackio-dashboard
#
# Uses Next.js's `output: "standalone"` (see next.config.mjs) so the
# runtime image only needs the traced-as-used node_modules plus the
# compiled server, not the whole workspace.
#
# NEXT_PUBLIC_API_URL is baked in AT BUILD TIME (it is a `NEXT_PUBLIC_*`
# variable, inlined into the client bundle by `next build`) — pass it as
# a build arg, not a container runtime env var, or the dashboard will
# call the wrong API origin. See docs/deployment/production.md.

FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo

ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NODE_ENV=production

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@adstrackio/dashboard

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
RUN addgroup -S adstrackio && adduser -S adstrackio -G adstrackio
WORKDIR /app

COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build /repo/apps/dashboard/public ./apps/dashboard/public

USER adstrackio
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/dashboard/server.js"]
