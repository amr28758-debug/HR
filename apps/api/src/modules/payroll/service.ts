import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { calculatePayroll, monthRange, type ExtraInput, type PayrollPolicyConfig, type SalaryStructure, type TimesheetSummary } from '@burtplace/core';
import { generateTimesheet } from '../timesheets/service.js';

export async function activePolicy(db: Kysely<DB>, date: string): Promise<{ id: string; config: PayrollPolicyConfig } | null> {
  const p = await db.selectFrom('payroll_policies').select(['id', 'config']).where('effective_from', '<=', date).where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', date)])).orderBy('effective_from', 'desc').orderBy('version', 'desc').executeTakeFirst();
  return p ? { id: p.id, config: p.config as PayrollPolicyConfig } : null;
}

/** Calculate (or recalculate) every employee in a run. Only allowed in DRAFT/CALCULATING/HR_REVIEW. */
export async function calculateRun(db: Kysely<DB>, runId: string): Promise<{ employees: number; totals: { gross: number; earnings: number; deductions: number; net: number }; exceptions: number }> {
  const run = await db.selectFrom('payroll_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
  if (!['DRAFT', 'CALCULATING', 'HR_REVIEW'].includes(run.status)) throw Object.assign(new Error(`Run is ${run.status}; recalculation not allowed`), { statusCode: 422 });
  const policy = run.policy_id ? { id: run.policy_id, config: (await db.selectFrom('payroll_policies').select('config').where('id', '=', run.policy_id).executeTakeFirstOrThrow()).config as PayrollPolicyConfig } : await activePolicy(db, run.period_end);
  if (!policy) throw Object.assign(new Error('No payroll policy effective for this period'), { statusCode: 422 });
  await db.updateTable('payroll_runs').set({ status: 'CALCULATING', policy_id: policy.id }).where('id', '=', runId).execute();
  const { start, end } = monthRange(run.period_year, run.period_month);
  const filters = (run.filters ?? {}) as { siteIds?: string[]; departmentIds?: string[]; projectIds?: string[] };
  let empQ = db.selectFrom('employees').selectAll().where('deleted_at', 'is', null).where('status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE']).where((eb) => eb.or([eb('joining_date', 'is', null), eb('joining_date', '<=', end)]));
  if (filters.siteIds?.length) empQ = empQ.where('site_id', 'in', filters.siteIds);
  if (filters.departmentIds?.length) empQ = empQ.where('department_id', 'in', filters.departmentIds);
  if (filters.projectIds?.length) empQ = empQ.where('project_id', 'in', filters.projectIds);
  const employees = await empQ.orderBy('employee_no').execute();
  const components = await db.selectFrom('salary_components').select(['id', 'code', 'kind', 'is_fixed_pay', 'calc_method', 'formula']).execute();
  const compByCode = new Map(components.map((c) => [c.code, c]));

  let totals = { gross: 0, earnings: 0, deductions: 0, net: 0 }, exceptions = 0, count = 0;
  await db.deleteFrom('payroll_employees').where('payroll_run_id', '=', runId).execute();
  for (const e of employees) {
    const ss = await db.selectFrom('employee_salary_structures').selectAll().where('employee_id', '=', e.id).where('effective_from', '<=', end).orderBy('effective_from', 'desc').orderBy('version', 'desc').executeTakeFirst();
    const exList: string[] = [];
    if (!ss) exList.push('NO_SALARY_STRUCTURE');
    const lines = ss ? await db.selectFrom('employee_salary_lines as l').innerJoin('salary_components as c', 'c.id', 'l.component_id').select(['c.code', 'c.kind', 'c.is_fixed_pay', 'c.calc_method', 'c.formula', 'l.amount']).where('l.salary_structure_id', '=', ss.id).execute() : [];
    const salary: SalaryStructure = { basicSalary: Number(ss?.basic_salary ?? 0), grossSalary: Number(ss?.gross_salary ?? 0), currency: ss?.currency ?? run.currency, lines: lines.map((l) => ({ componentCode: l.code, kind: l.kind, amount: Number(l.amount), isFixedPay: l.is_fixed_pay, calcMethod: l.calc_method, formula: l.formula })) };
    const tsId = await generateTimesheet(db, e.id, run.period_year, run.period_month, { treatMissingPunchAsPresent: policy.config.treatMissingPunchAsPresent ?? false });
    const t = tsId ? await db.selectFrom('timesheets').selectAll().where('id', '=', tsId).executeTakeFirstOrThrow() : null;
    if (!t) exList.push('NO_TIMESHEET');
    const paidLeave = Number(t?.paid_leave_days ?? 0), present = Number(t?.present_days ?? 0);
    const summary: TimesheetSummary = t ? { calendarDays: t.calendar_days, scheduledDays: t.scheduled_days, presentDays: present, absentDays: Number(t.absent_days), paidLeaveDays: paidLeave, unpaidLeaveDays: Number(t.unpaid_leave_days), weekOffDays: t.week_off_days, holidayDays: t.holiday_days, missingPunchDays: t.missing_punch_days, scheduledMinutes: t.scheduled_minutes, workedMinutes: t.worked_minutes, normalMinutes: t.normal_minutes, overtimeMinutes: t.overtime_minutes, unapprovedOvertimeMinutes: t.unapproved_overtime_minutes, weekendOtMinutes: t.weekend_ot_minutes, holidayOtMinutes: t.holiday_ot_minutes, lateMinutes: t.late_minutes, earlyLeaveMinutes: t.early_leave_minutes, lateCount: t.late_count, paidDays: present + paidLeave + t.week_off_days + t.holiday_days }
      : { calendarDays: 30, scheduledDays: 0, presentDays: 0, absentDays: 0, paidLeaveDays: 0, unpaidLeaveDays: 0, weekOffDays: 0, holidayDays: 0, missingPunchDays: 0, scheduledMinutes: 0, workedMinutes: 0, normalMinutes: 0, overtimeMinutes: 0, unapprovedOvertimeMinutes: 0, weekendOtMinutes: 0, holidayOtMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, lateCount: 0, paidDays: 0 };
    // extras: active loans, approved adjustments targeting this run (or unassigned)
    const extras: ExtraInput[] = [];
    const loans = await db.selectFrom('employee_loans').selectAll().where('employee_id', '=', e.id).where('status', '=', 'ACTIVE').where('start_period', '<=', start).execute();
    for (const l of loans) { const amt = Math.min(Number(l.installment), Number(l.outstanding)); if (amt > 0) extras.push({ componentCode: l.loan_type === 'ADVANCE' ? 'ADVANCE' : 'LOAN', kind: 'DEDUCTION', amount: amt, description: `${l.loan_type} instalment` }); }
    const adjs = await db.selectFrom('payroll_adjustments as a').innerJoin('salary_components as c', 'c.id', 'a.component_id').select(['a.id', 'a.amount', 'a.reason', 'c.code', 'c.kind']).where('a.employee_id', '=', e.id).where('a.status', '=', 'APPROVED').where((eb) => eb.or([eb('a.target_run_id', '=', runId), eb('a.target_run_id', 'is', null)])).execute();
    for (const a of adjs) extras.push({ componentCode: a.code, kind: a.kind, amount: Number(a.amount), description: a.reason, adjustmentId: a.id });
    const res = calculatePayroll(salary, summary, policy.config, extras);
    if (res.warnings.length) exList.push(...res.warnings);
    if (!e.bank_iban) exList.push('MISSING_IBAN');
    const pe = await db.insertInto('payroll_employees').values({
      payroll_run_id: runId, employee_id: e.id, timesheet_id: t?.id ?? null, salary_structure_id: ss?.id ?? null, employee_no: e.employee_no, employee_name: e.full_name_en, department_id: e.department_id, site_id: e.site_id, project_id: e.project_id, cost_center_id: e.cost_center_id,
      basic_salary: salary.basicSalary, gross_salary: salary.grossSalary, daily_rate: res.dailyRate, hourly_rate: res.hourlyRate, worked_days: res.workedDays, paid_days: res.paidDays, unpaid_leave_days: res.unpaidLeaveDays, absent_days: res.absentDays, overtime_minutes: res.overtimeMinutes,
      total_earnings: res.totalEarnings, total_deductions: res.totalDeductions, net_salary: res.netSalary, bank_iban: e.bank_iban, calculation_trace: JSON.stringify(res.trace), has_exceptions: exList.length > 0, exceptions: JSON.stringify(exList),
    }).returning('id').executeTakeFirstOrThrow();
    for (const l of res.earnings) await db.insertInto('payroll_earnings').values({ payroll_employee_id: pe.id, component_id: compByCode.get(l.componentCode)!.id, component_code: l.componentCode, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount, is_adjustment: l.isAdjustment, adjustment_id: l.adjustmentId ?? null }).execute();
    for (const l of res.deductions) await db.insertInto('payroll_deductions').values({ payroll_employee_id: pe.id, component_id: compByCode.get(l.componentCode)!.id, component_code: l.componentCode, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount, is_adjustment: l.isAdjustment, adjustment_id: l.adjustmentId ?? null }).execute();
    if (t) await db.updateTable('timesheets').set({ payroll_run_id: runId }).where('id', '=', t.id).execute();
    totals = { gross: totals.gross + salary.grossSalary, earnings: totals.earnings + res.totalEarnings, deductions: totals.deductions + res.totalDeductions, net: totals.net + res.netSalary };
    if (exList.length) exceptions++;
    count++;
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  await db.updateTable('payroll_runs').set({ status: 'HR_REVIEW', employee_count: count, total_gross: r2(totals.gross), total_earnings: r2(totals.earnings), total_deductions: r2(totals.deductions), total_net: r2(totals.net) }).where('id', '=', runId).execute();
  return { employees: count, totals: { gross: r2(totals.gross), earnings: r2(totals.earnings), deductions: r2(totals.deductions), net: r2(totals.net) }, exceptions };
}

/** Allowed status transitions with the permission required to perform them. */
export const PAYROLL_TRANSITIONS: Record<string, { to: string; permission: string }[]> = {
  DRAFT: [{ to: 'CALCULATING', permission: 'payroll:run' }],
  CALCULATING: [{ to: 'HR_REVIEW', permission: 'payroll:run' }],
  HR_REVIEW: [{ to: 'FINANCE_REVIEW', permission: 'payroll:review:hr' }, { to: 'DRAFT', permission: 'payroll:run' }],
  FINANCE_REVIEW: [{ to: 'MANAGEMENT_APPROVAL', permission: 'payroll:review:finance' }, { to: 'HR_REVIEW', permission: 'payroll:review:finance' }],
  MANAGEMENT_APPROVAL: [{ to: 'APPROVED', permission: 'payroll:approve' }, { to: 'HR_REVIEW', permission: 'payroll:approve' }],
  APPROVED: [{ to: 'LOCKED', permission: 'payroll:lock' }],
  LOCKED: [{ to: 'BANK_WPS', permission: 'payroll:pay' }],
  BANK_WPS: [{ to: 'PAID', permission: 'payroll:pay' }],
  PAID: [{ to: 'CLOSED', permission: 'payroll:pay' }],
  CLOSED: [],
};
