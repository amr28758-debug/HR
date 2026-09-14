FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/core/package.json packages/core/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @burtplace/api... --filter @burtplace/database...

FROM deps AS build
COPY . .
RUN pnpm -r --filter './packages/**' build && pnpm --filter @burtplace/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
