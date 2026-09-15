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

## Scoping rules

- **Team** = direct reports (4 levels) ∪ employees of projects the user's employee record manages ∪ employees of departments they manage.
- **Own** = the employee linked to the user (`employees.user_id`).
- Salary and banking are separate permissions (`salary:read`, `employees:banking:read`) — a manager never sees team salaries.
- Payslips for employees are visible only once the run is LOCKED or later; the calculation trace is visible only with `payroll:read`.

## Entra ID mapping

Users are matched by `oid` → `entra_object_id`, then by UPN/email. Unknown Entra users are auto-provisioned with the EMPLOYEE role only if an employee record with that work email exists. Elevated roles are granted in `user_roles` by an IT admin (`users:write`); mapping Entra app roles/groups to Burtplace roles automatically is a planned enhancement (`REQUIRES CONFIRMATION` of the tenant's group model).
