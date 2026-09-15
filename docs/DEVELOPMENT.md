# Development guide

## Prerequisites
Node 22, pnpm 10, Docker (or local PostgreSQL 16 + Redis 7).

## Commands

| Command | What |
|---|---|
| `./scripts/start.sh` (`scripts\start.ps1` on Windows) | one-command local run: prerequisites, `.env` secrets, PostgreSQL/Redis, install, migrate+seed, API + web. Flags: `--reset`, `--https`, `--stop` |
| `pnpm install` | install workspace |
| `pnpm -r --filter './packages/**' build` | build shared packages (required before API/web) |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:ensure` / `pnpm db:reset` | migrations / seed / migrate+seed-if-empty / drop+migrate+seed (dev only) |
| `pnpm dev:api`, `pnpm worker`, `pnpm dev:web` | run services |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test:unit` / `pnpm test:integration` | core unit tests / API integration tests (`DATABASE_URL_TEST`, must contain "test") |
| `docker compose up` | full stack: postgres, redis, minio, api, worker, web |

## Adding a module

1. `apps/api/src/modules/<name>/{routes.ts,service.ts}`; register in `app.ts` under `/api/v1/<name>`.
2. Validate with Zod (`schema.body/querystring/params/response`) — this also documents the route in `/docs`.
3. Guard with `requirePermission(...)`; add new permission codes to `packages/database/src/rbac.ts` and the role matrix.
4. Call `app.audit(req, {...})` for every mutation.
5. Keep business maths in `@burtplace/core` with unit tests; keep DB access in services.
6. Add an integration test under `apps/api/test`.

## Adding a migration

Create `packages/database/migrations/NNNN_name.sql` (sequential), update `packages/database/src/schema.ts` typings, run `pnpm db:migrate`. Migrations are forward-only and run in a transaction each.

## Background jobs

`apps/api/src/jobs/handlers.ts` implements each job; `queues.ts` schedules cron repeatables. When Redis is unavailable (or `enableQueues: false` in tests) jobs run inline through the same handlers.

## Conventions

- snake_case in SQL, camelCase in API/JSON.
- Money `number` (2 dp), minutes `integer`, dates `YYYY-MM-DD`, instants ISO with offset.
- Never modify raw punches or audit rows; never hard-code payroll or shift rules.
