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

## Install it on your machine

One command installs a copy in `HR/Burtplace`, puts a **Burtplace Workforce** icon on
the Desktop (and the Start Menu on Windows) and starts it. After that, opening the
program is a double-click — no commands.

**Windows** (PowerShell):
```powershell
git clone -b claude/gracious-brahmagupta-mcdn7j https://github.com/amr28758-debug/HR.git "$env:USERPROFILE\HR\Burtplace"; powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\HR\Burtplace\scripts\install.ps1"
```

**macOS / Linux**:
```bash
git clone -b claude/gracious-brahmagupta-mcdn7j https://github.com/amr28758-debug/HR.git ~/HR/Burtplace && ~/HR/Burtplace/scripts/install.sh
```

Install somewhere else with `-Path "D:\HR\Burtplace"` (Windows) or `--path ~/work/bp`.
Re-running the installer updates the copy to the latest commit.

**Requirements:** [Git](https://git-scm.com/downloads), [Node 22 LTS](https://nodejs.org)
and either [Docker Desktop](https://docker.com/products/docker-desktop) (the installer
runs PostgreSQL and Redis for you) or your own PostgreSQL 16 on port 5432 and Redis on 6379.

### Start it again later

Double-click the Desktop icon, or run the launcher directly. It checks the
prerequisites, generates the secrets in `.env`, starts PostgreSQL and Redis, installs,
migrates, seeds the demo data, runs the API and the web app and opens the browser.

```bash
./scripts/start.sh                 # macOS / Linux
```
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1    # Windows
```

Then open <http://localhost:3000>. Useful flags: `--reset` (wipe and re-seed the demo
data), `--https` (serve over HTTPS so a phone on the same Wi-Fi can use the camera),
`--stop` (stop the database containers). On Windows use `-Reset`, `-Https`, `-Stop`.

**Requirements:** [Node 22 LTS](https://nodejs.org) and either
[Docker Desktop](https://docker.com/products/docker-desktop) (the script runs PostgreSQL
and Redis for you) or your own PostgreSQL 16 on port 5432 and Redis on 6379.

<details><summary>Manual steps (what the script does)</summary>

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
</details>

### Try mobile face attendance

1. **Directory** → open an employee → **Biometric** tab → **Enroll face** (use your own
   face, three angles are captured automatically) → **Test recognition**.
2. Open **/attendance**, press Start and follow the steps to **CHECK IN**.
3. **Administration → Face recognition → Terminals** → Register terminal, then open
   **/kiosk/pair** on a tablet and type the 6-digit code to turn it into a gate kiosk.

Camera and GPS need `localhost` or HTTPS — use `--https` to test from a phone. Details in
[docs/MOBILE-FACE-ATTENDANCE.md](docs/MOBILE-FACE-ATTENDANCE.md).

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
- [Compensation & salary management — bands, reviews, promotions, budgets, scenarios](docs/COMPENSATION.md)
- [Mobile face recognition attendance — phone/tablet/kiosk terminals, enrollment, thresholds, privacy](docs/MOBILE-FACE-ATTENDANCE.md)
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
