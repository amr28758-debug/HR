# Burtplace Workforce

Enterprise HR, Attendance, Timesheet & Payroll platform for **Burtplace General Contracting**.
Zoho-free by design: Burtplace Workforce is the single source of truth for employees, attendance, timesheets and payroll.

```
Employee → Employment → Shift → Attendance → Leave / OT → Timesheet → Payroll → Payslip → Bank / WPS
```

| Layer | Stack |
|---|---|
| Web | Next.js 15 (App Router), React 19, Tailwind, TanStack Query, Recharts — EN/AR, LTR/RTL, dark/light |
| API | Node 22, TypeScript, Fastify 5, Zod, OpenAPI (`/docs`), BullMQ workers |
| Data | PostgreSQL 16 (SQL migrations, immutable raw-punch ledger & audit log), Redis 7 |
| Auth | Microsoft Entra ID (JWKS-validated tokens) · local dev login · API keys for device gateway |
| Domain | `@burtplace/core` — pure, unit-tested shift / attendance / timesheet / payroll engines |

## Quick start (development)

```bash
cp .env.example .env               # set AUTH_LOCAL_JWT_SECRET (any 32+ chars)
docker compose up -d postgres redis
pnpm install
pnpm -r --filter './packages/**' build
pnpm db:reset                      # migrate + seed (175 synthetic employees, sites, shifts, policies)
pnpm dev:api                       # http://localhost:4000  (OpenAPI at /docs)
pnpm worker                        # background jobs (optional in dev)
pnpm dev:web                       # http://localhost:3000
```

Seed logins (password `Password123!`): `admin@`, `hr.admin@`, `hr.manager@`, `payroll@`, `finance@`, `it.admin@`, `pm.c31@`, `management@`, `auditor@`, `employee@` — all `@burtplace.local`.

Push a punch (device gateway):
```bash
curl -X POST localhost:4000/api/v1/attendance/events -H "X-API-Key: <key>" -H 'content-type: application/json' \
  -d '[{"userId":"21","deviceCode":"ARGO-C31-01","timestamp":"2026-09-07T06:02:00+04:00"}]'
```

## Tests

```bash
pnpm test:unit          # @burtplace/core — 47 tests, engines
pnpm test:integration   # @burtplace/api  — 35+ tests against a real PostgreSQL test DB
pnpm test               # everything (needs DATABASE_URL_TEST)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [ERD & schema](docs/ERD.md) · [API](docs/API.md) · [RBAC](docs/RBAC.md)
- [Attendance engine rules](docs/ATTENDANCE.md) · [Payroll policy & formulas](docs/PAYROLL.md)
- [Matrix ARGO FACE / VYOM integration](docs/MATRIX-INTEGRATION.md) · [Legacy migration (Zoho)](docs/MIGRATION.md)
- [HR Operating System — Command Center, HR requests, talent, compensation, letters](docs/HR-OS.md)
- [Security](docs/SECURITY.md) · [Releases & roadmap](docs/RELEASES.md) · [Development guide](docs/DEVELOPMENT.md)

## Repository layout

```
apps/api            Fastify API + BullMQ worker (modules/* incl. hr-requests, jobs, compensation, letters, people, analytics, assets)
apps/web            Next.js web application
packages/core       Pure domain engines (shift, attendance, timesheet, formula, payroll, lifecycle)
packages/database   SQL migrations, Kysely typings, RBAC matrix, seed
packages/config     Validated environment
packages/types      Shared enums
integrations/zoho   LEGACY & REMOVABLE Zoho export mapper (core never imports it)
infra/docker        Dockerfiles
docs/               Architecture & operations documentation
```
