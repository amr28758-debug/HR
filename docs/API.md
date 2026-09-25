# API

Base path `/api/v1`. OpenAPI 3.1 is generated from the Zod schemas and served at `/docs` (Swagger UI) and `/docs/json`.

## Conventions

- Auth: `Authorization: Bearer <token>` (Entra access token in production, local JWT in dev) or `X-API-Key` for service accounts.
- Pagination: `?page=1&pageSize=25&sort=<whitelisted column>&order=asc|desc` → `{ data: [], meta: { page, pageSize, total, totalPages } }`.
- Errors: `{ error: { code, message, details?, requestId } }` — `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `UNPROCESSABLE` 422.
- Dates: `YYYY-MM-DD`; instants ISO-8601 with offset.
- Every mutating call is audited.

## Resource map

| Prefix | Highlights |
|---|---|
| `/auth` | `GET /me`, `GET /config`, `POST /local/login` (dev), `POST /api-keys`, `DELETE /api-keys/:id` |
| `/employees` | list (scoped), create, `GET /:id`, `GET /by-number/:no`, patch, delete, `POST /:id/transition`, history, banking, documents, salary versions, checklists, `POST /checklist-tasks/:id/complete` |
| `/org` | departments, designations, cost-centers, projects, sites, holidays |
| `/devices` | list + health, register/update, heartbeat, biometric `mappings` |
| `/attendance` | `POST /events` (ingest), `raw-events`, `daily`, `daily/:emp/:date/punches`, `POST /process`, `exceptions` (+resolve), `corrections`, `calendar/:emp`, `POST /reconcile`, `reconcile/latest` |
| `/shifts` | shifts CRUD, `work-patterns`, `assignments`, `resolve/:emp` |
| `/leave` | types, `balances/:emp`, requests (+cancel), team `calendar`, `accrual/run`, `balances/adjust` |
| `/overtime` | rules, requests, `requests/:id/decide` |
| `/timesheets` | list, detail with lines, generate, regenerate, approve, adjust, lock |
| `/payroll` | policies, components, runs (create/calculate/transition/employees/bank-file), `employees/:id` (payslip data), `my-payslips`, adjustments, loans |
| `/workflows` | definitions, `tasks/mine` (`?all=true` for admins), `tasks/:id/decide`, `instances/:id`, notifications |
| `/dashboards` | executive, hr, manager, payroll, me |
| `/reports` | 15 reports under `hr/*`, `attendance/*`, `payroll/*` — `?format=csv` for export |
| `/search` | global search (`?q=BP-26-777`) |
| `/audit` | audit trail (`audit:read`) |
| `/integrations` | connections, `biometric/capabilities`, logs |
| `/migration` | batches (create+validate, apply) |

### HR Operating System (see HR-OS.md)

| Prefix | Purpose |
|---|---|
| `/employees/:id/summary`, `/timeline`, `/compensation`, `/employees/org-chart`, `/employees/documents/expiring`, `/employees/bulk` | Command Center, org chart, document center, bulk operations |
| `/employees/:id/promote|transfer|salary-change|bonus|deduction|loan|advance|assign-training|disciplinary|resign|terminate|generate-letter|start-clearance` | Business actions → HR requests |
| `/hr-requests` | Request center (list, detail with what-changed & approval trail, cancel, re-apply, types) |
| `/jobs` | Career levels, grades, families/functions, titles, job descriptions & versions, lookups |
| `/compensation` | Compensation management (grades, bands, profiles, salary changes, promotions, salary reviews, budgets, scenarios, dashboard, analysis, alerts, reports, audit — see [COMPENSATION.md](COMPENSATION.md)); deductions, bonuses, loans & instalments; grade check |
| `/letters` | Templates, preview, generate, list, HTML, revoke, public `verify/:code` |
| `/people` | Performance cycles/reviews, training catalog/records, disciplinary, notes |
| `/analytics` | Control center, HR analytics, workforce cost, HR calendar |
| `/assets` | Asset register, assign/return, per-employee assets |
| `/workflows/delegations` | Approval delegation |
| `/payroll/employee-history/:employeeId` | Payroll history per employee |
| `/auth/users` | User picker (emails only with `users:read`) |

### Mobile face recognition attendance (see MOBILE-FACE-ATTENDANCE.md)

| Prefix | Purpose |
|---|---|
| `/attendance/mobile/config`, `/attendance/mobile/terminals/pair`, `/attendance/mobile/recognize`, `/attendance/mobile/punch` | Terminal runtime: public config, kiosk pairing, 1:N recognition (signed ticket), punch into the raw ledger (`MOBILE_FACE`) |
| `/biometric/employees/:id/status|enroll|test|disable|enable|template` | Face template lifecycle (encrypted; never returned) |
| `/biometric/events`, `/biometric/settings`, `/biometric/terminals`, `/biometric/geofences` | Immutable recognition audit, versioned settings, kiosks (pairing codes / revoke / reissue), site geofences |

## Device gateway contract

`POST /api/v1/attendance/events` with `X-API-Key`. Body: one object or an array (≤5,000):

```json
{ "userId": "777", "deviceCode": "ARGO-C31-01", "timestamp": "2026-09-07T02:00:00Z", "direction": "IN", "method": "FACE", "eventId": "vendor-id" }
```

Response `202 { batchId, received, inserted, duplicates, rejected, unmapped, queuedProcessing }`. Replays are safe: identical events are deduplicated by fingerprint. `direction` and `method` are optional — when the device does not report direction, the engine infers it by alternation.
