# Roles & permissions

The matrix lives in `packages/database/src/rbac.ts` and is seeded into `roles`, `permissions`, `role_permissions`. Permissions are `resource:action[:scope]`; scope suffixes `:team` and `:own` are enforced in services (`resolveScope`, `teamEmployeeIds`).

| Role | Summary |
|---|---|
| SUPER_ADMIN | everything |
| HR_ADMIN | employee master, documents, attendance corrections & exceptions, shifts, leave admin, timesheets, HR dashboard/reports |
| HR_MANAGER | HR_ADMIN + salary read/write, payroll HR review, timesheet lock, workflow definitions, audit read |
| PAYROLL_OFFICER | payroll runs/calculation/adjustments, salary, banking read, payroll dashboard/reports |
| FINANCE | finance review of payroll, banking, cost reports |
| FINANCE_MANAGER | FINANCE + approve/lock/pay payroll |
| PROJECT_MANAGER / DEPARTMENT_MANAGER | team scope: employees, attendance, leave/OT approvals, timesheet approval, manager dashboard |
| IT_ADMIN | users, API keys, devices, biometric mappings, integrations, attendance ingest/process |
| COMPENSATION_OFFICER | HR officer for compensation: salary read, prepares and submits salary changes, promotions, reviews and scenarios; cannot approve or configure |
| EMPLOYEE | own profile, attendance, leave requests, OT requests, timesheets, payslips |
| AUDITOR | read-only across all resources + audit trail |
| MANAGEMENT | executive dashboards, final approvals (payroll, salary change, resignation) |
| SERVICE_DEVICE_GATEWAY | machine account: `attendance:ingest`, `devices:read` |

## HR OS permissions

`jobs:read/write`, `compensation:read/write`, `requests:create:own|any`, `requests:read[:team|:own]`,
`disciplinary:read/write`, `performance:read[:team|:own]/write`, `training:read[:own]/write`,
`letters:generate`, `letters:read:own`, `letters:templates:write`, `notes:read/write/confidential`,
`analytics:read`, `config:write`, `delegation:manage`, `bulk:run`. Restricted request types
(salary, promotion, loans, bonuses, deductions, disciplinary, termination) hide their content from
callers without `compensation:read` / `disciplinary:read` unless the request is their own.

## Compensation permissions

`compensation:propose` (create/submit changes, promotions, reviews, scenarios), `compensation:config` (grades, bands,
job-title mapping, merit matrix, promotion & compression rules), `compensation:settings` (thresholds, rating levels,
approval chains — no amounts; granted to IT_ADMIN), `compensation:override` (beyond matrix/policy maximum, duplicate
override, budget override — always with justification), `compensation:budget`, `reports:compensation`. Individual
amounts always need `salary:read`. The requester of a compensation change can never approve it (segregation of duties).
Full matrix: [COMPENSATION.md](COMPENSATION.md#8-permission-matrix).

## Mobile face attendance permissions

`biometric:read` (status/quality metadata), `biometric:enroll` (enroll / re-enroll / disable / enable — never one's own
face), `biometric:test`, `biometric:delete` (irreversible template deletion), `biometric:events:read` (recognition audit),
`terminals:manage` (kiosk registration, pairing codes, revocation), `face:config:write` (thresholds, liveness, GPS,
retention — versioned). HR_ADMIN: read/enroll/test/events. HR_MANAGER: all. IT_ADMIN: read/enroll/test/events/terminals/config.
Employees see only their own status and events (`employees:read:own`, `attendance:read:own`). No role can read a template.

## Scoping rules

- **Team** = direct reports (4 levels) ∪ employees of projects the user's employee record manages ∪ employees of departments they manage.
- **Own** = the employee linked to the user (`employees.user_id`).
- Salary and banking are separate permissions (`salary:read`, `employees:banking:read`) — a manager never sees team salaries.
- Payslips for employees are visible only once the run is LOCKED or later; the calculation trace is visible only with `payroll:read`.

## Entra ID mapping

Users are matched by `oid` → `entra_object_id`, then by UPN/email. Unknown Entra users are auto-provisioned with the EMPLOYEE role only if an employee record with that work email exists. Elevated roles are granted in `user_roles` by an IT admin (`users:write`); mapping Entra app roles/groups to Burtplace roles automatically is a planned enhancement (`REQUIRES CONFIRMATION` of the tenant's group model).
