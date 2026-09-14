import { evaluate, type Vars } from './formula-engine.js';
import type { TimesheetSummary } from './timesheet.js';

export interface PayrollPolicyConfig {
  daysInMonthDivisor: number;
  hoursPerDay: number;
  rateBase: 'GROSS' | 'BASIC';
  overtime: { NORMAL: number; WEEK_OFF: number; PUBLIC_HOLIDAY: number };
  lateDeduction: { enabled: boolean; perMinute: boolean; graceMinutesPerMonth: number };
  earlyLeaveDeduction: { enabled: boolean; perMinute: boolean };
  absenceDeductionDays: number;
  rounding: number;
  formulas: Record<string, string>;
  treatMissingPunchAsPresent?: boolean;
}

export interface SalaryLine { componentCode: string; kind: 'EARNING' | 'DEDUCTION'; amount: number; isFixedPay: boolean; calcMethod: string; formula: string | null }
export interface SalaryStructure { basicSalary: number; grossSalary: number; currency: string; lines: SalaryLine[] }
export interface ExtraInput { componentCode: string; kind: 'EARNING' | 'DEDUCTION'; amount: number; description?: string; quantity?: number; rate?: number; adjustmentId?: string }

export interface PayrollLineOut { componentCode: string; description: string; quantity: number | null; rate: number | null; amount: number; isAdjustment: boolean; adjustmentId?: string }
export interface PayrollResult {
  dailyRate: number; hourlyRate: number; paidDays: number; workedDays: number; unpaidLeaveDays: number; absentDays: number; overtimeMinutes: number;
  earnings: PayrollLineOut[]; deductions: PayrollLineOut[]; totalEarnings: number; totalDeductions: number; netSalary: number;
  trace: Record<string, unknown>; warnings: string[];
}

function r2(x: number, d: number): number { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; }

/**
 * Compute one employee's payroll for a period from: salary structure + timesheet summary + policy (+ extras such as bonuses, loans, approved adjustments).
 * Every number is derived from configurable formulas in `policy.formulas`; the variables available are listed in `PAYROLL_VARIABLES`.
 * This is company policy computation — statutory compliance (WPS, end-of-service, legal OT rates) must be configured & reviewed, never assumed.
 */
export function calculatePayroll(salary: SalaryStructure, ts: TimesheetSummary, policy: PayrollPolicyConfig, extras: ExtraInput[] = []): PayrollResult {
  const warnings: string[] = [];
  const d = policy.rounding ?? 2;
  const rateBase = policy.rateBase === 'BASIC' ? salary.basicSalary : salary.grossSalary;
  const vars: Vars = {
    basic_salary: salary.basicSalary,
    gross_salary: salary.grossSalary,
    rate_base: rateBase,
    days_in_month_divisor: policy.daysInMonthDivisor,
    hours_per_day: policy.hoursPerDay,
    calendar_days: ts.calendarDays,
    scheduled_days: ts.scheduledDays,
    present_days: ts.presentDays,
    paid_days: ts.paidDays,
    absent_days: ts.absentDays,
    paid_leave_days: ts.paidLeaveDays,
    unpaid_leave_days: ts.unpaidLeaveDays,
    week_off_days: ts.weekOffDays,
    holiday_days: ts.holidayDays,
    ot_minutes: ts.overtimeMinutes,
    ot_hours: ts.overtimeMinutes / 60,
    weekend_ot_hours: ts.weekendOtMinutes / 60,
    holiday_ot_hours: ts.holidayOtMinutes / 60,
    late_minutes: ts.lateMinutes,
    early_leave_minutes: ts.earlyLeaveMinutes,
    ot_multiplier_normal: policy.overtime.NORMAL,
    ot_multiplier_week_off: policy.overtime.WEEK_OFF,
    ot_multiplier_public_holiday: policy.overtime.PUBLIC_HOLIDAY,
    late_grace_minutes_per_month: policy.lateDeduction.graceMinutesPerMonth,
    absence_deduction_days: policy.absenceDeductionDays,
  };
  for (const l of salary.lines) vars[`comp_${l.componentCode.toLowerCase()}`] = l.amount;

  const f = (key: string, fallback: string) => evaluate(policy.formulas[key] ?? fallback, vars);
  const dailyRate = f('DAILY_RATE', 'rate_base / days_in_month_divisor');
  vars.daily_rate = dailyRate;
  const hourlyRate = f('HOURLY_RATE', 'daily_rate / hours_per_day');
  vars.hourly_rate = hourlyRate;

  const earnings: PayrollLineOut[] = [];
  const deductions: PayrollLineOut[] = [];

  // Fixed pay (basic + allowances) — full monthly amounts; absence/unpaid leave are separate deductions (transparent payslip).
  for (const l of salary.lines.filter((x) => x.isFixedPay && x.kind === 'EARNING')) {
    earnings.push({ componentCode: l.componentCode, description: l.componentCode, quantity: null, rate: null, amount: r2(l.amount, d), isAdjustment: false });
  }

  // Overtime earnings (only approved minutes reach the timesheet totals)
  if (ts.overtimeMinutes > 0) earnings.push({ componentCode: 'OT', description: 'Overtime (normal days)', quantity: r2(vars.ot_hours!, 2), rate: r2(hourlyRate * policy.overtime.NORMAL, 4), amount: r2(f('OT', 'hourly_rate * ot_hours * ot_multiplier_normal'), d), isAdjustment: false });
  if (ts.weekendOtMinutes > 0) earnings.push({ componentCode: 'OT_WEEKEND', description: 'Overtime (week off)', quantity: r2(vars.weekend_ot_hours!, 2), rate: r2(hourlyRate * policy.overtime.WEEK_OFF, 4), amount: r2(f('OT_WEEKEND', 'hourly_rate * weekend_ot_hours * ot_multiplier_week_off'), d), isAdjustment: false });
  if (ts.holidayOtMinutes > 0) earnings.push({ componentCode: 'OT_HOLIDAY', description: 'Overtime (public holiday)', quantity: r2(vars.holiday_ot_hours!, 2), rate: r2(hourlyRate * policy.overtime.PUBLIC_HOLIDAY, 4), amount: r2(f('OT_HOLIDAY', 'hourly_rate * holiday_ot_hours * ot_multiplier_public_holiday'), d), isAdjustment: false });

  // Attendance deductions
  if (ts.unpaidLeaveDays > 0) deductions.push({ componentCode: 'UNPAID_LEAVE', description: 'Unpaid leave', quantity: ts.unpaidLeaveDays, rate: r2(dailyRate, 4), amount: r2(f('UNPAID_LEAVE', 'daily_rate * unpaid_leave_days'), d), isAdjustment: false });
  if (ts.absentDays > 0) deductions.push({ componentCode: 'ABSENCE', description: 'Absence', quantity: ts.absentDays, rate: r2(dailyRate * policy.absenceDeductionDays, 4), amount: r2(f('ABSENCE', 'daily_rate * absent_days * absence_deduction_days'), d), isAdjustment: false });
  if (policy.lateDeduction.enabled && ts.lateMinutes > policy.lateDeduction.graceMinutesPerMonth) {
    const amt = r2(f('LATE', '(hourly_rate / 60) * max(0, late_minutes - late_grace_minutes_per_month)'), d);
    if (amt > 0) deductions.push({ componentCode: 'LATE', description: 'Late arrival', quantity: ts.lateMinutes - policy.lateDeduction.graceMinutesPerMonth, rate: r2(hourlyRate / 60, 4), amount: amt, isAdjustment: false });
  }
  if (policy.earlyLeaveDeduction.enabled && ts.earlyLeaveMinutes > 0) {
    const amt = r2(f('EARLY_LEAVE', '(hourly_rate / 60) * early_leave_minutes'), d);
    if (amt > 0) deductions.push({ componentCode: 'EARLY_LEAVE', description: 'Early leave', quantity: ts.earlyLeaveMinutes, rate: r2(hourlyRate / 60, 4), amount: amt, isAdjustment: false });
  }

  // Extras: bonuses, commissions, loans, advances, approved adjustments
  for (const e of extras) {
    const line: PayrollLineOut = { componentCode: e.componentCode, description: e.description ?? e.componentCode, quantity: e.quantity ?? null, rate: e.rate ?? null, amount: r2(e.amount, d), isAdjustment: !!e.adjustmentId, adjustmentId: e.adjustmentId };
    (e.kind === 'EARNING' ? earnings : deductions).push(line);
  }

  const totalEarnings = r2(earnings.reduce((s, l) => s + l.amount, 0), d);
  let totalDeductions = r2(deductions.reduce((s, l) => s + l.amount, 0), d);
  if (totalDeductions > totalEarnings) {
    warnings.push(`Deductions (${totalDeductions}) exceed earnings (${totalEarnings}); net floored at 0 — review required`);
    totalDeductions = totalEarnings;
  }
  const netSalary = r2(totalEarnings - totalDeductions, d);
  if (ts.missingPunchDays > 0) warnings.push(`${ts.missingPunchDays} day(s) with missing punches — resolve before locking`);
  if (ts.unapprovedOvertimeMinutes > 0) warnings.push(`${ts.unapprovedOvertimeMinutes} unapproved overtime minute(s) excluded`);

  return {
    dailyRate: r2(dailyRate, 4), hourlyRate: r2(hourlyRate, 4), paidDays: ts.paidDays, workedDays: ts.presentDays, unpaidLeaveDays: ts.unpaidLeaveDays, absentDays: ts.absentDays,
    overtimeMinutes: ts.overtimeMinutes + ts.weekendOtMinutes + ts.holidayOtMinutes, earnings, deductions, totalEarnings, totalDeductions, netSalary,
    trace: { variables: vars, formulas: policy.formulas, policy: { rateBase: policy.rateBase, divisor: policy.daysInMonthDivisor, hoursPerDay: policy.hoursPerDay, overtime: policy.overtime } }, warnings,
  };
}

export const PAYROLL_VARIABLES = [
  'basic_salary', 'gross_salary', 'rate_base', 'days_in_month_divisor', 'hours_per_day', 'daily_rate', 'hourly_rate', 'calendar_days', 'scheduled_days', 'present_days', 'paid_days',
  'absent_days', 'paid_leave_days', 'unpaid_leave_days', 'week_off_days', 'holiday_days', 'ot_minutes', 'ot_hours', 'weekend_ot_hours', 'holiday_ot_hours', 'late_minutes',
  'early_leave_minutes', 'ot_multiplier_normal', 'ot_multiplier_week_off', 'ot_multiplier_public_holiday', 'late_grace_minutes_per_month', 'absence_deduction_days',
];
