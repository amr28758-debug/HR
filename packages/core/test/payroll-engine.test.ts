import { describe, expect, it } from 'vitest';
import { calculatePayroll, type PayrollPolicyConfig, type SalaryStructure } from '../src/payroll-engine.js';
import type { TimesheetSummary } from '../src/timesheet.js';

const policy: PayrollPolicyConfig = {
  daysInMonthDivisor: 30, hoursPerDay: 8, rateBase: 'GROSS', overtime: { NORMAL: 1.25, WEEK_OFF: 1.5, PUBLIC_HOLIDAY: 1.5 },
  lateDeduction: { enabled: true, perMinute: true, graceMinutesPerMonth: 60 }, earlyLeaveDeduction: { enabled: true, perMinute: true }, absenceDeductionDays: 1, rounding: 2,
  formulas: {
    DAILY_RATE: 'rate_base / days_in_month_divisor', HOURLY_RATE: 'daily_rate / hours_per_day', OT: 'hourly_rate * ot_hours * ot_multiplier_normal',
    UNPAID_LEAVE: 'daily_rate * unpaid_leave_days', ABSENCE: 'daily_rate * absent_days * absence_deduction_days', LATE: '(hourly_rate / 60) * max(0, late_minutes - late_grace_minutes_per_month)',
  },
};
const salary: SalaryStructure = {
  basicSalary: 5000, grossSalary: 8000, currency: 'AED',
  lines: [
    { componentCode: 'BASIC', kind: 'EARNING', amount: 5000, isFixedPay: true, calcMethod: 'FIXED', formula: null },
    { componentCode: 'HOUSING', kind: 'EARNING', amount: 2000, isFixedPay: true, calcMethod: 'FIXED', formula: null },
    { componentCode: 'TRANSPORT', kind: 'EARNING', amount: 1000, isFixedPay: true, calcMethod: 'FIXED', formula: null },
  ],
};
function ts(over: Partial<TimesheetSummary> = {}): TimesheetSummary {
  return { calendarDays: 30, scheduledDays: 26, presentDays: 26, absentDays: 0, paidLeaveDays: 0, unpaidLeaveDays: 0, weekOffDays: 4, holidayDays: 0, missingPunchDays: 0, scheduledMinutes: 26 * 480, workedMinutes: 26 * 480, normalMinutes: 26 * 480, overtimeMinutes: 0, unapprovedOvertimeMinutes: 0, weekendOtMinutes: 0, holidayOtMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, lateCount: 0, paidDays: 30, ...over };
}

describe('calculatePayroll', () => {
  it('perfect month pays gross', () => {
    const r = calculatePayroll(salary, ts(), policy);
    expect(r.dailyRate).toBeCloseTo(266.6667, 3);
    expect(r.hourlyRate).toBeCloseTo(33.3333, 3);
    expect(r.totalEarnings).toBe(8000);
    expect(r.totalDeductions).toBe(0);
    expect(r.netSalary).toBe(8000);
  });
  it('matches the specification example (OT 650 ≈ 15.6h, unpaid 1d, absence 1d, late)', () => {
    // OT: hourly 33.3333 × h × 1.25 = 650 → h = 15.6 → 936 minutes
    const r = calculatePayroll(salary, ts({ overtimeMinutes: 936, unpaidLeaveDays: 1, absentDays: 1, lateMinutes: 150 }), policy, [
      { componentCode: 'BONUS', kind: 'EARNING', amount: 200 }, { componentCode: 'OTHER_DED', kind: 'DEDUCTION', amount: 100 },
    ]);
    const ot = r.earnings.find((e) => e.componentCode === 'OT')!;
    expect(ot.amount).toBe(650);
    expect(r.totalEarnings).toBe(8850);
    expect(r.deductions.find((d) => d.componentCode === 'UNPAID_LEAVE')!.amount).toBe(266.67);
    expect(r.deductions.find((d) => d.componentCode === 'ABSENCE')!.amount).toBe(266.67);
    expect(r.deductions.find((d) => d.componentCode === 'LATE')!.amount).toBe(50); // (33.33/60)*(150-60) = 50
    expect(r.totalDeductions).toBe(683.34);
    expect(r.netSalary).toBe(8166.66);
  });
  it('honours BASIC rate base and custom formulas', () => {
    const p2: PayrollPolicyConfig = { ...policy, rateBase: 'BASIC', formulas: { ...policy.formulas, UNPAID_LEAVE: 'daily_rate * unpaid_leave_days * 2' } };
    const r = calculatePayroll(salary, ts({ unpaidLeaveDays: 3 }), p2);
    expect(r.dailyRate).toBeCloseTo(166.6667, 3);
    expect(r.deductions[0]!.amount).toBe(1000);
  });
  it('never returns negative net and warns', () => {
    const r = calculatePayroll(salary, ts({ absentDays: 30, presentDays: 0, paidDays: 0 }), policy, [{ componentCode: 'LOAN', kind: 'DEDUCTION', amount: 5000 }]);
    expect(r.netSalary).toBe(0);
    expect(r.warnings.some((w) => /exceed/.test(w))).toBe(true);
  });
  it('warns about missing punches and unapproved OT', () => {
    const r = calculatePayroll(salary, ts({ missingPunchDays: 2, unapprovedOvertimeMinutes: 45 }), policy);
    expect(r.warnings).toHaveLength(2);
  });
});
