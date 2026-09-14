# Burtplace Workforce — working notes for AI assistants

- Monorepo (pnpm). Build shared packages before API/web: `pnpm -r --filter './packages/**' build`.
- Local services: PostgreSQL on 5432 (`burtplace_dev`, `burtplace_test`), Redis on 6379. `.env` holds dev settings; never commit secrets.
- Tests: `pnpm --filter @burtplace/core test` (unit), `pnpm --filter @burtplace/api test` (integration; resets `burtplace_test`).
- Rules that must never be broken: raw attendance and audit rows are immutable; payroll/shift rules are configuration; Zoho stays under `integrations/zoho` and is never imported by core; never fabricate Matrix/Zoho/Microsoft/WPS endpoints — mark them `REQUIRES VENDOR CONFIRMATION`.
- Docs index: `docs/`. API reference: run the API and open `/docs`.
