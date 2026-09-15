# HR Operating System — Command Center, HR requests, talent & compensation

This document describes the "Full HR Operating System" layer added on top of the core platform
(employee master → attendance → timesheets → payroll). Everything here is data-driven: approval
chains, grades, code lists, letter templates and policies are configuration, never code.

## 1. Employee Command Center

`GET /api/v1/employees/:id/summary` powers the profile page (`/employees/:id`):

| Block | Source |
|---|---|
| Header (photo, tenure, status, designation, grade, level, family, probation, contract) | `employees` + job architecture joins |
| **Employment health** indicators: PASSPORT, EMIRATES_ID, VISA, LABOUR_CARD, INSURANCE, CONTRACT, PROBATION → `VALID / EXPIRING_SOON / EXPIRED / MISSING / NOT_APPLICABLE` | `employee_documents` (latest per type), contract/probation dates. Warn window 60 d (contract 90 d, probation 14 d) |
| **Needs attention** | expired/expiring/missing documents, missing IBAN, missing biometric mapping, pending HR requests, expiring certificates |
| Attendance card (current month), leave balances, compensation card (restricted), counts per tab | operational tables |
| `tabs[]` | RBAC-filtered list of the 19 tabs the caller may open |
| `actions[]` | smart Actions menu — each entry carries `enabled` + `reason` (permission or lifecycle) |

Other Command Center endpoints:

- `GET /employees/:id/timeline` — unified business timeline: append-only `employee_timeline_events`
  (promotion, transfer, salary, bonus, deduction, loan, letter, training, disciplinary, request, asset…)
  merged with status history, leave/OT/corrections, documents and employment movements.
  Visibility levels `EMPLOYEE / MANAGER / HR / RESTRICTED` are enforced per caller. The technical
  audit trail (`/audit`) stays separate.
- `GET /employees/:id/compensation` — every salary version with per-component deltas ("what changed"),
  grade band & compa-ratio, deductions, bonuses, loans with instalment progress. Restricted (`salary:read`
  or own with `salary:read:own`).
- `GET /employees/org-chart?rootId&departmentId&depth` — reporting-line tree (team-scoped for managers).
- `GET /employees/documents/expiring?days&type` — document center watch-list (numbers masked to last 4).
- `POST /employees/bulk` — preview (`confirm=false`) then confirm; one HR request per employee with
  per-employee results.
- Directory filters: `gradeId, careerLevelId, jobFamilyId, nationality, costCenterId, probation=due|overdue|on,
  contract=expiring, missing=iban|biometric|salary`.

## 2. HR requests (business actions with approval)

Every sensitive change is an `hr_requests` row with a typed `payload`, a `before_snapshot`, a
workflow instance and, once applied, a `result` containing the `changes` diff.

```
POST /employees/:id/promote | transfer | salary-change | bonus | deduction | loan | advance
     | assign-training | disciplinary | resign | terminate | generate-letter | start-clearance
POST /hr-requests                (generic)      GET /hr-requests, GET /hr-requests/:id
POST /hr-requests/:id/cancel     POST /hr-requests/:id/apply (re-apply after FAILED, config:write)
GET  /hr-requests/types          (types + configured approval steps)
```

Flow: `createHrRequest` → validate payload → snapshot → `startWorkflow(code = request type)` →
approvers decide in `/approvals` (or `/requests/:id`) → on final approval the workflow hook calls
`applyHrRequest`, which runs the side effects in one transaction:

| Type | Side effects on approval |
|---|---|
| PROMOTION | designation/grade/level/department/manager update, employment_history `PROMOTION`, optional new salary version (`source=PROMOTION`), promotion letter, timeline |
| TRANSFER | dept/project/site/cost center/manager update, employment_history `TRANSFER`, shift re-evaluation enqueued from the effective date |
| SALARY_CHANGE / INCREMENT | new salary version (lines, `newBasic` or `percentage`), previous version closed the day before |
| LOAN / ADVANCE | `employee_loans` + `loan_installments` schedule (last instalment absorbs rounding) |
| BONUS / DEDUCTION | `employee_bonuses` / `employee_deductions` rows in APPROVED |
| LETTER | letter issued with the request as approval reference |
| TRAINING | `training_records` PLANNED |
| DISCIPLINARY | confidential `disciplinary_cases` row, optional PENALTY deduction for the next period |
| RESIGNATION / TERMINATION | lifecycle transition (`RESIGNED` / `TERMINATED`), exit fields, clearance workflow started for resignations |

Statuses: `PENDING → APPROVED → APPLIED`, or `REJECTED`, `CANCELLED`, `FAILED` (error kept in
`apply_error`; re-apply after fixing). If no active workflow definition exists for a type the request
is applied immediately (still audited).

Workflow codes: the request type, except `HR_RESIGNATION` / `HR_TERMINATION` (the employee-level
`RESIGNATION` clearance workflow is kept separate). Seeded chains live in `packages/database/src/seed-hros.ts`
and can be re-versioned via `POST /workflows/definitions`.

Delegation: `POST /workflows/delegations` (from/to/dates). Delegates see the delegator's tasks in
`/workflows/tasks/mine` and may decide them; decisions are recorded under the delegate's user.

## 3. Job architecture & compensation

- `career_levels` (L1–L10), `job_families` → `job_functions`, `grades` (min/mid/max band), designations
  linked to family/function/default grade/level (`PATCH /jobs/titles/:id`).
- Job descriptions: `job_descriptions` + `job_description_versions` (DRAFT → APPROVED → SUPERSEDED);
  `POST /jobs/descriptions/:id/link-employees` stamps `job_description_version_id` on employees.
- Compensation center (`/compensation`): deductions, bonuses, loans (pause/resume/close/reschedule),
  increment cycles (`DRAFT → IN_REVIEW → APPROVED → APPLIED`; APPLIED creates an INCREMENT request per
  included employee with the workflow bypassed because the cycle itself was approved — requires `salary:write`).
- `GET /compensation/grade-check?gradeId&basic` → BELOW_MIN / IN_BAND / ABOVE_MAX + compa-ratio.
- Payroll integration (`calculateRun`): scheduled `loan_installments` for the period (legacy loans
  without a schedule fall back to the fixed instalment), APPROVED deductions of the period, APPROVED
  bonuses (one-off or recurring window; amount or % of basic). On `LOCKED` they are marked
  `APPLIED` / `DEDUCTED` with the run id.

## 4. People development

- Performance: cycles (rating scale + competencies) → `launch` creates one review per working employee
  with the manager as reviewer → self / manager / HR sections, goals, finalisation. Final ratings feed
  increment cycles.
- Training: catalog (validity months, mandatory flag) → records → completion, score, certificate,
  auto expiry from validity → expiring-certificate alerts on the profile, calendar and control center.
- Disciplinary: confidential case register (`disciplinary:read/write` only; never in search, timeline
  events are `RESTRICTED`).
- HR notes: `notes:read/write`, confidential notes need `notes:confidential`.

## 5. Letters

Templates (`letter_templates`, versioned, EN/AR/bilingual, `requires_approval`) render with
`{{path}}` variables (`employee.*`, `salary.*`, `letter.*`, `company.*`, `change.*`). Each issued
letter gets a number `BP-LTR-YYYY-000001`, a verification code, letterhead HTML with an embedded SVG QR code (encoding the verify URL)
and the public page `/verify/<code>` (`GET /letters/verify/:code`). Revocation flips the verification
result. Employees may *request* letters (LETTER request); `letters:generate` issues instantly unless the
template requires approval.

## 6. Analytics, control center, calendar

- `GET /analytics/control-center` — headcount pulse + NEEDS ATTENTION queue (expired/expiring documents,
  probation due/overdue, contracts, missing IBAN/biometric/salary, pending/failed requests, overdue
  tasks, open checklists, expiring certificates, missing punches, open cases).
- `GET /analytics/hr?months` — headcount trend, attrition, tenure bands, grade distribution, request
  throughput with average decision time, training and performance KPIs.
- `GET /analytics/workforce-cost?groupBy=project|site|department|cost_center|grade|employee` — latest
  gross per working employee (restricted to `salary:read`).
- `GET /analytics/calendar?from&to` — holidays, approved leave, probation/contract ends, document
  expiries, scheduled training, payroll period ends, work anniversaries.

## 7. Assets

`/assets`: register, assign, return (with damage flag → raise an ASSET_DAMAGE deduction from the
profile). `GET /assets/employee/:id` feeds the Assets tab and the clearance checklist.

## 7b. Final settlement (end of service)

`GET /employees/:id/final-settlement?lastWorkingDate&exitType` returns an itemised statement computed by
`@burtplace/core` `calculateSettlement` from the payroll policy block `finalSettlement`:

```json
{ "signedOff": false,
  "gratuity": { "basis": "BASIC", "bands": [{ "uptoYears": 5, "daysPerYear": 21 }, { "uptoYears": null, "daysPerYear": 30 }],
                "minServiceYears": 1, "capMonths": 24, "proRata": true, "daysInMonthDivisor": 30 },
  "leaveEncashment": { "enabled": true, "basis": "BASIC", "daysInMonthDivisor": 30 },
  "excludeUnpaidLeaveFromService": true, "recoverNoticeShortfall": true }
```

Inputs are read live: latest salary, approved unpaid leave, annual-leave balance, outstanding loans/advances,
approved unapplied deductions and bonuses, notice shortfall (notice days vs. resignation → last working date)
and the final period's payroll net if that run exists. The statement is **DRAFT** (warning on every result)
until HR/Legal set `signedOff: true` in a new policy version — the engine ships no statutory values of its own.
Termination cases add a warning that forfeiture/reduction is a legal determination. The card lives on the
profile's Compensation tab (payroll:read / salary:read).

## 7c. Notifications

In-app notifications are always written. `apps/api/src/notifications/channels.ts` fans them out to
**email** (SMTP via nodemailer, when `SMTP_HOST` is set) and **Microsoft Teams** (incoming webhook `text`
payload for `approval.*` events, when `TEAMS_WEBHOOK_URL` is set). Delivery runs through the
`notifications.deliver` job (every 2 minutes and right after request creation / decisions); every attempt is
stored as its own `notifications` row per channel with `sent_at` or `send_error`, so delivery is auditable and
nothing is fabricated when a channel is unconfigured.

## 8. Data privacy

Salary, banking, passport/EID numbers, disciplinary and performance data are restricted by RBAC
(`salary:*`, `employees:banking:*`, `disciplinary:*`, `performance:*`, `compensation:*`). Restricted
request types hide payload/before/result from callers without those permissions; document numbers
are masked in search and in the document center; timeline `RESTRICTED` events are filtered; audit
masks IBAN/account numbers. Nothing sensitive is written to application logs.

## 9. Configurable / requires sign-off

| Item | Where | Status |
|---|---|---|
| Grade salary bands | `/talent/jobs` → Grades | seeded examples — **REQUIRES HR CONFIRMATION** |
| Approval chains per request type | `/admin/config` → Approval chains, `POST /workflows/definitions` | configurable |
| Code lists (bonus types, disciplinary categories, exit reasons, document categories…) | `/admin/config` → Code lists | configurable |
| Letter wording (NOC, experience, salary transfer, warning) | `/documents/letters` → Templates | **REQUIRES HR/LEGAL SIGN-OFF** |
| Termination grounds, notice, end-of-service | policy | **REQUIRES HR/LEGAL SIGN-OFF** — not computed by the system |
| Document deadlines / grace periods | reminder thresholds 30/60/90 d | **REQUIRES HR/LEGAL SIGN-OFF** |
| Disciplinary penalties | company policy | **REQUIRES HR/LEGAL SIGN-OFF** |
