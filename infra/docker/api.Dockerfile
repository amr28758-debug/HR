# API image. Debian (glibc) rather than Alpine: the face-recognition provider uses
# @tensorflow/tfjs-node, whose native TensorFlow library is only published for glibc.
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
# Build scripts must run so the tfjs-node native addon is fetched (see pnpm.onlyBuiltDependencies).
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter './packages/**' build && pnpm --filter @burtplace/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
