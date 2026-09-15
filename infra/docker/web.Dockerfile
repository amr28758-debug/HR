# Web image. The build copies the browser face models from @vladmandic/human into
# public/models (scripts/copy-face-models.mjs) so terminals load them from our own origin.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter './packages/**' build \
 && pnpm --filter @burtplace/web exec node scripts/copy-face-models.mjs \
 && pnpm --filter @burtplace/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@burtplace/web", "start"]
