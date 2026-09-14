# Payroll policy & formula engine

Payroll never hard-codes salary maths. Every number comes from a **versioned policy** (`payroll_policies.config`) evaluated by the safe formula engine in `packages/core/src/formula-engine.ts` (no `eval`; arithmetic, comparisons, `max/min/round/floor/ceil/abs/if`).

## Policy structure

```json
{
  "daysInMonthDivisor": 30, "hoursPerDay": 8, "rateBase": "GROSS",
  "overtime": { "NORMAL": 1.25, "WEEK_OFF": 1.5, "PUBLIC_HOLIDAY": 1.5 },
  "lateDeduction": { "enabled": true, "perMinute": true, "graceMinutesPerMonth": 60 },
  "earlyLeaveDeduction": { "enabled": true, "perMinute": true },
  "absenceDeductionDays": 1, "rounding": 2,
  "formulas": {
    "DAILY_RATE": "rate_base / days_in_month_divisor",
    "HOURLY_RATE": "daily_rate / hours_per_day",
    "OT": "hourly_rate * ot_hours * ot_multiplier_normal",
    "OT_WEEKEND": "hourly_rate * weekend_ot_hours * ot_multiplier_week_off",
    "OT_HOLIDAY": "hourly_rate * holiday_ot_hours * ot_multiplier_public_holiday",
    "UNPAID_LEAVE": "daily_rate * unpaid_leave_days",
    "ABSENCE": "daily_rate * absent_days * absence_deduction_days",
    "LATE": "(hourly_rate / 60) * max(0, late_minutes - late_grace_minutes_per_month)",
    "EARLY_LEAVE": "(hourly_rate / 60) * early_leave_minutes"
  }
}
```

Variables available to formulas: `PAYROLL_VARIABLES` in `packages/core/src/payroll-engine.ts` (basic/gross salary, rate base, divisors, day counts, OT hours by kind, late/early minutes, multipliers, `comp_<code>` for each salary line). New versions are validated (`POST /payroll/policies`) before they can be used.

## Statutory vs company policy

Each policy and OT rule carries `is_statutory`. Everything seeded is **company policy** and is labelled *REQUIRES HR/LEGAL CONFIRMATION*. In particular:

- OT multipliers and the rate base (gross vs basic) for OT must be confirmed against UAE Labour Law and company contracts.
- WPS: the bank file endpoint produces a **generic CSV**. The UAE WPS SIF layout is not implemented; it `REQUIRES VENDOR/BANK CONFIRMATION` (MOHRE/agent bank specification) and should be added as an exporter once the specification is available.
- End-of-service gratuity and final settlement formulas are not implemented; the `FINAL_SETTLEMENT` lifecycle state and clearance checklist exist, and the formula engine can host the confirmed formula as a policy version.

## Run lifecycle

`DRAFT → CALCULATING → HR_REVIEW → FINANCE_REVIEW → MANAGEMENT_APPROVAL → APPROVED → LOCKED → BANK_WPS → PAID → CLOSED`

| Transition | Permission | Effect |
|---|---|---|
| calculate (DRAFT/CALCULATING/HR_REVIEW) | payroll:run | rebuilds register from timesheets + salary + policy (+ loans, approved adjustments) |
| HR_REVIEW → FINANCE_REVIEW | payroll:review:hr | requires a note if any employee has exceptions |
| FINANCE_REVIEW → MANAGEMENT_APPROVAL | payroll:review:finance | |
| MANAGEMENT_APPROVAL → APPROVED | payroll:approve | |
| APPROVED → LOCKED | payroll:lock | locks timesheets & days, marks adjustments APPLIED, reduces loan balances, creates payslip records |
| LOCKED → BANK_WPS → PAID → CLOSED | payroll:pay | bank file export allowed from LOCKED |

Each register row stores a `calculation_trace` (all variables, formulas and policy parameters) so any payslip can be reproduced and audited.

## Exceptions surfaced per employee

`NO_SALARY_STRUCTURE`, `NO_TIMESHEET`, `NO_ATTENDANCE_DATA`, `MISSING_IBAN`, missing-punch days, unapproved OT excluded, deductions exceeding earnings (net floored at 0).
