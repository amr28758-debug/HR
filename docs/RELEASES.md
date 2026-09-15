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
| Assets & employee assets | ✅ register, assign, return, employee view |
| Document upload service (S3 pre-signed) | ⬜ |
| Legacy migration framework + Zoho mapper | ✅ |

## Release 5 — HR Operating System (this repository state)

| Item | Status |
|---|---|
| Employee Command Center: summary (employment health, attention, cards), 19 RBAC-filtered tabs, smart Actions menu, unified timeline, compensation history with what-changed | ✅ |
| HR requests engine: typed payloads, before-snapshot, approval chains per type, automatic application (promotion, transfer, salary change, increment, loan/advance schedules, bonus, deduction, letter, training, disciplinary, resignation, termination), cancel / re-apply | ✅ |
| Job architecture: career levels, families → functions → titles, grades with salary bands, versioned & approved job descriptions | ✅ (bands 🟡 REQUIRES HR CONFIRMATION) |
| Compensation center: deductions, bonuses, loans + instalment schedules (reschedule/pause), increment cycles with bulk edit and application; payroll picks them up and marks APPLIED on lock | ✅ |
| Talent: performance cycles/reviews/goals, training catalog/records/certificate expiry, confidential disciplinary register, HR notes | ✅ (lightweight) |
| Letters: versioned templates EN/AR/bilingual, variables, numbering, letterhead, embedded QR code, public verify page, revocation | ✅ (PDF export to object storage ⬜) |
| Document center (expiry watch-list by category), asset register | ✅ |
| Workflow delegation, HR calendar, org chart, HR control center (NEEDS ATTENTION), HR analytics, workforce cost by project/site/department/cost center/grade/employee | ✅ |
| Directory: table / grid / compact views, talent & compliance filters, bulk operations (preview → confirm → per-employee results) | ✅ |
| New IA: Dashboard · People · Talent · Time · Leave · Compensation · Payroll · Documents · Assets · Workflows · Reports · Administration; ⌘K quick actions; ESS entry `/me` | ✅ |
| Configuration center: code lists, approval chains, policies, rules | ✅ (read + code lists; policy editing via module pages) |
| Final settlement calculator (configuration-driven, DRAFT until HR/Legal sign-off) on the profile | ✅ 🟡 policy REQUIRES HR/LEGAL SIGN-OFF |
| Email (SMTP) and Teams (incoming webhook) notification channels with per-channel delivery audit | ✅ (🟡 relay/webhook REQUIRE IT CONFIGURATION) |
| Employee search pickers (transfer, promotion, edit) | ✅ |
| Object storage for letters/attachments, mobile push | ⬜ |

## Release 6 — Mobile face recognition attendance (this repository state)

| Item | Status |
|---|---|
| Phone / tablet browser as a face terminal: 1:N identification (no ID entry), server-side anti-spoof + liveness + active challenge, GPS geofence, punch into the existing raw ledger (`MOBILE_FACE`) | ✅ |
| Three modes: employee mobile `/attendance`, supervisor sequential, site kiosk `/kiosk/:site` with one-time pairing codes and hashed device tokens | ✅ |
| Enrollment in the Command Center (Biometric tab): 3-angle live capture, quality/consistency/duplicate guards, encrypted multi-sample templates, disable / re-enroll / delete, self-test | ✅ |
| Administration → Attendance → Face recognition: versioned thresholds & policies, terminals, geofences, immutable recognition audit | ✅ |
| Lifecycle: recognition disabled on TERMINATED/ARCHIVED; optional deletion after exit; retention & consent settings | ✅ 🟡 REQUIRES HR/LEGAL APPROVAL |
| Provider: on-prem `@vladmandic/human` behind `FaceRecognitionProvider` (documented evaluation; passive liveness limits stated) | ✅ (PAD-certified provider ⬜ optional) |
| Offline punch queue | ⬜ by design (recognition is server-side; page shows "Network connection required") |

## Next steps (recommended order)

1. Obtain Matrix documentation → implement/validate VYOM or direct ARGO FACE adapter (see MATRIX-INTEGRATION.md).
2. Confirm payroll policy with HR/Legal (OT rates, rate base, WPS SIF) → new policy version.
3. Entra tenant registration (API app + SPA), group→role mapping.
4. Document upload + payslip PDF generation to object storage.
5. HR/Legal sign-off of the settlement policy (`finalSettlement.signedOff`); SMTP relay and Teams webhook from IT.
6. Letter PDF rendering to object storage; e-signature; performance calibration; succession.
7. Mobile face attendance pilot on one site (surveyed geofences, `BIOMETRIC_TEMPLATE_KEY`, consent notice approved) → threshold review from the recognition events → rollout (docs/MOBILE-FACE-ATTENDANCE.md §12).
