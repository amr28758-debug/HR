# Releases & roadmap

Status legend: ✅ built & tested · 🟡 built, needs confirmation/real data · ⬜ not started

## Release 1 — Core (this repository state)

| Item | Status |
|---|---|
| Architecture, schema (11 migrations, 70+ tables), ERD, module & API structure | ✅ |
| Authentication (Entra JWKS / local / API keys), RBAC matrix, audit log | ✅ (Entra flow implemented; 🟡 needs tenant test) |
| Employee Master: profile, documents, banking, salary versions, lifecycle state machine, onboarding/clearance checklists | ✅ |
| Organization: departments, designations, cost centers, projects, sites, holidays | ✅ |
| Devices, biometric mappings, health dashboard, heartbeat | ✅ |
| Matrix integration layer (`BiometricProvider`, webhook adapter, VYOM skeleton, capability matrix) | ✅ layer · 🟡 VYOM REQUIRES VENDOR CONFIRMATION |
| Raw attendance ledger (immutable, fingerprint dedup, replay-safe ingest) | ✅ |
| Shift engine (fixed/overnight, patterns, employee/project/site assignments, holidays) | ✅ |
| Attendance engine (late/early/OT/half-day/missing/absent/leave/week-off/holiday/site mismatch) + exceptions + corrections workflow + reconciliation | ✅ |
| Dashboards (executive, HR, manager, payroll, self) | ✅ |

## Release 2 — Time & approvals

| Item | Status |
|---|---|
| Leave: types, policies, balances, accrual, requests, cancellation, team calendar → attendance | ✅ |
| Overtime: rules, requests, approval → attendance → timesheet | ✅ |
| Timesheets: generate, lines, approve, adjust, lock | ✅ |
| Generic workflow engine (JSON definitions, conditional steps, manager/role routing, notifications) | ✅ |
| Employee & manager portals (self dashboard, requests, approvals inbox) | ✅ |
| Email / Teams notification channels | ⬜ (in-app implemented; channel senders pending) |

## Release 3 — Payroll

| Item | Status |
|---|---|
| Salary structure & components, versioned payroll policies with validated formulas | ✅ |
| Payroll engine, register with calculation trace, deductions/allowances/OT/loans/adjustments | ✅ |
| Payroll workflow to LOCKED/PAID/CLOSED with segregation of duties | ✅ |
| Payslip data + printable EN/AR web payslip | ✅ (PDF rendering to object storage ⬜) |
| Bank file | 🟡 generic CSV; WPS SIF REQUIRES BANK/MOHRE SPECIFICATION |

## Release 4 — Lifecycle & assets

| Item | Status |
|---|---|
| Recruitment/offer states, onboarding checklist generation, probation tracking | ✅ (state machine + checklists) |
| Transfer / promotion history | ✅ |
| Resignation workflow → clearance checklist → final settlement state | ✅ states & workflow · ⬜ settlement formulas (REQUIRES LEGAL CONFIRMATION) |
| Assets & employee assets | 🟡 schema ready, API ⬜ |
| Document upload service (S3 pre-signed) | ⬜ |
| Legacy migration framework + Zoho mapper | ✅ |

## Next steps (recommended order)

1. Obtain Matrix documentation → implement/validate VYOM or direct ARGO FACE adapter (see MATRIX-INTEGRATION.md).
2. Confirm payroll policy with HR/Legal (OT rates, rate base, WPS SIF) → new policy version.
3. Entra tenant registration (API app + SPA), group→role mapping.
4. Document upload + payslip PDF generation to object storage.
5. Email/Teams notification senders; assets API; final settlement policy.
