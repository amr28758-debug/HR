# Legacy migration (Zoho People, Excel, COSEC exports)

Zoho is a **migration source only**. The removable mapper lives in `integrations/zoho` and is never imported by `apps/api` or `packages/*`. Deleting the folder does not affect the platform.

## Flow

```
Zoho People export (CSV/JSON)  ──mapZohoEmployees()──▶  normalised rows
Excel (any)                    ──your mapping────────▶  normalised rows
                                                         │
                                        POST /api/v1/migration/batches { source, entityType, rows }
                                                         │  validates every row (Zod), stores raw + normalised
                                        POST /api/v1/migration/batches/:id/apply
                                                         │  idempotent upsert by employee_no; creates biometric mapping,
                                                         │  initial salary structure, opening leave balances
                                                         ▼
                                                  Burtplace master data
```

Supported entity types today: `employees` (with optional salary lines) and `leave_balances`. Departments, designations, sites and projects are referenced by **code** and must exist first (create them via `/org/*`). Historical attendance is imported through the normal ingest endpoint (`/attendance/events`, source `IMPORT`), which keeps the ledger semantics identical to live data.

## Zoho export mapping

`DEFAULT_ZOHO_COLUMN_MAP` covers the standard "Employee Details" export (`EmployeeID`, `FirstName`, `Dateofjoining`, …). Column names vary per Zoho configuration — **REQUIRES CONFIRMATION** against the actual export; pass a custom `columnMap` when they differ. `zoho_record_id` is stored on the employee for traceability only.

## Coexistence

During coexistence Zoho may remain the UI for some HR processes, but Burtplace Workforce is the master for employee numbers, attendance, timesheets and payroll. Re-running a batch updates existing employees by employee number instead of duplicating them, so periodic re-exports are safe.
