# Architecture

## Target system

```
                      BURTPLACE WORKFORCE (single source of truth)
   ┌──────────────────┬──────────────────────┬──────────────────────┐
   │ Employee Master  │ Attendance Engine    │ Payroll Engine       │
   │ lifecycle, docs, │ raw ledger → dedup → │ policies/formulas →  │
   │ salary versions  │ shift → daily → OT   │ register → lock →    │
   │                  │ → timesheet          │ payslip → bank/WPS   │
   └──────────────────┴──────────┬───────────┴──────────────────────┘
                                 │  Integration layer (BiometricProvider)
                                 │
                       ┌─────────┴──────────┐
                       │   Device Gateway   │  Option A (target): gateway ↔ ARGO FACE
                       └─────────┬──────────┘
                       ┌─────────┴──────────┐
                       │  Matrix COSEC VYOM │  Option B (temporary): VYOM export/poll → Burtplace
                       └─────────┬──────────┘
                            Matrix ARGO FACE terminals
```

Both options terminate in the same endpoint/contract: `ExternalAttendanceEvent` → `POST /api/v1/attendance/events` (push) or `BiometricProvider.getAttendanceEvents()` (pull). Attendance and payroll never know which path delivered the punch, so VYOM can be removed without touching them.

## Processes

| Process | Role |
|---|---|
| `apps/api` (`main.ts`) | HTTP API, OpenAPI, auth, RBAC, audit. Stateless; scale horizontally. |
| `apps/api` (`worker.ts`) | BullMQ consumer + cron: attendance processing, reconciliation, timesheet generation, leave accrual, document expiry, device health, biometric sync. |
| `apps/web` | Next.js UI. Talks to the API through `/api/v1/*` (rewrite) so tokens stay first-party. |
| PostgreSQL | System of record. Immutable tables enforced by triggers (`attendance_raw_events`, `audit_logs`). |
| Redis | Queues only (no business data). If Redis is down the API runs jobs inline. |
| Object storage (S3/MinIO) | Documents, payslip PDFs (object keys stored in DB). |

## Data flow — the golden path

1. **Punch** arrives (gateway push with API key, VYOM sync, or manual import) → `ingestEvents()` computes `SHA256(user|ts|dir|device)`, inserts into `attendance_raw_events` (`ON CONFLICT DO NOTHING`), resolves device→site and user→employee, flags `UNMAPPED_USER`.
2. **Processor** (`processEmployeeDay`) loads the schedule context (assignments employee > project > site, work patterns, shifts, holidays), attributes punches to the business date (cross-midnight aware), applies approved corrections, calls the pure `calculateDay()` and upserts `attendance_daily`, `attendance_events`, `attendance_exceptions`. Locked days are skipped.
3. **Leave / OT** approvals (generic workflow engine) update `attendance_daily` (`ON_LEAVE`, `approved_overtime_minutes`) and trigger recalculation.
4. **Timesheet** (`generateTimesheet`) aggregates the month (`summarizeTimesheet()`), keeping day lines for audit.
5. **Payroll** (`calculateRun`) snapshots salary structure + timesheet + policy → `calculatePayroll()` → register lines with a full calculation trace. Lifecycle DRAFT → … → LOCKED freezes timesheets & days; later changes only via `payroll_adjustments`.
6. **Payslip / bank file** from the locked run.

## Design rules enforced in code

- Raw punches: UPDATE of punch fields and DELETE raise (`attendance_raw_events_guard`). Corrections are separate, approval-backed rows.
- Audit log: append-only trigger; every mutating endpoint calls `app.audit()` with old/new/reason/IP/request id.
- Salary: versioned structures, never edited in place. Reads require `salary:read` (or own).
- Payroll after LOCKED: status transitions only; recalculation refused (422).
- Identifiers: `employees.id` (UUID PK) · `employee_no` (business key) · `matrix_user_id` (external) · `zoho_record_id` (legacy, nullable, unused by core).
- No vendor endpoint is called unless it is documented; unconfirmed capabilities are reported as `UNKNOWN` by `BiometricProvider.capabilities()`.

## Scaling notes (5,000 employees / 100 sites)

- Ingest is O(events) with one upsert per event; batch endpoint accepts up to 5,000 events per call. Move to `COPY`/multi-row inserts if a site exceeds ~50 events/s.
- Processing is per employee-day and idempotent → partition by employee across workers (`WORKER_CONCURRENCY`).
- Hot tables are indexed by `(employee_id, date)`; consider monthly partitioning of `attendance_raw_events` beyond ~50M rows.
- API is stateless; Redis-backed rate limiting can replace the in-memory limiter when running >1 replica.
