import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { monthRange, summarizeTimesheet, type DailyLine } from '@burtplace/core';

/** Generate (or regenerate, if not locked) the monthly timesheet for one employee from attendance_daily. */
export async function generateTimesheet(db: Kysely<DB>, employeeId: string, year: number, month: number, opts: { treatMissingPunchAsPresent?: boolean } = {}): Promise<string | null> {
  const { start, end, days } = monthRange(year, month);
  const existing = await db.selectFrom('timesheets').select(['id', 'status', 'locked_at']).where('employee_id', '=', employeeId).where('period_year', '=', year).where('period_month', '=', month).executeTakeFirst();
  if (existing?.locked_at || existing?.status === 'LOCKED') return existing.id;
  const emp = await db.selectFrom('employees').select(['id', 'site_id', 'project_id', 'department_id', 'cost_center_id']).where('id', '=', employeeId).executeTakeFirstOrThrow();
  const daily = await db.selectFrom('attendance_daily').selectAll().where('employee_id', '=', employeeId).where('attendance_date', '>=', start).where('attendance_date', '<=', end).orderBy('attendance_date').execute();
  const leaveTypes = await db.selectFrom('leave_types').select(['code', 'is_paid']).execute();
  const paid = new Map(leaveTypes.map((l) => [l.code, l.is_paid]));
  const lines: DailyLine[] = daily.map((d) => ({ date: d.attendance_date, status: d.status, scheduledMinutes: d.scheduled_minutes, workedMinutes: d.worked_minutes, netWorkedMinutes: d.net_worked_minutes, overtimeMinutes: d.overtime_minutes, approvedOvertimeMinutes: d.approved_overtime_minutes, holidayMinutes: d.holiday_minutes, weekendMinutes: d.weekend_minutes, lateMinutes: d.late_minutes, earlyLeaveMinutes: d.early_leave_minutes, isPaidDay: d.is_paid_day, leaveTypeCode: d.leave_type_code }));
  const s = summarizeTimesheet(lines, { leaveTypeIsPaid: (c) => paid.get(c) ?? true, treatMissingPunchAsPresent: opts.treatMissingPunchAsPresent ?? false });
  const values = {
    employee_id: employeeId, period_year: year, period_month: month, period_start: start, period_end: end, status: 'GENERATED' as const, site_id: emp.site_id, project_id: emp.project_id, department_id: emp.department_id, cost_center_id: emp.cost_center_id,
    calendar_days: days, scheduled_days: s.scheduledDays, present_days: s.presentDays, absent_days: s.absentDays, paid_leave_days: s.paidLeaveDays, unpaid_leave_days: s.unpaidLeaveDays, week_off_days: s.weekOffDays, holiday_days: s.holidayDays, missing_punch_days: s.missingPunchDays,
    scheduled_minutes: s.scheduledMinutes, worked_minutes: s.workedMinutes, normal_minutes: s.normalMinutes, overtime_minutes: s.overtimeMinutes, unapproved_overtime_minutes: s.unapprovedOvertimeMinutes, weekend_ot_minutes: s.weekendOtMinutes, holiday_ot_minutes: s.holidayOtMinutes,
    late_minutes: s.lateMinutes, early_leave_minutes: s.earlyLeaveMinutes, late_count: s.lateCount, generated_at: new Date(),
  };
  return db.transaction().execute(async (trx) => {
    const t = await trx.insertInto('timesheets').values(values).onConflict((oc) => oc.columns(['employee_id', 'period_year', 'period_month']).doUpdateSet({ ...values, status: existing?.status === 'APPROVED' ? 'APPROVED' : 'GENERATED' })).returning('id').executeTakeFirstOrThrow();
    await trx.deleteFrom('timesheet_lines').where('timesheet_id', '=', t.id).execute();
    for (const d of daily) {
      const dayKind = d.status === 'WEEK_OFF' ? 'WEEK_OFF' : d.status === 'PUBLIC_HOLIDAY' ? 'PUBLIC_HOLIDAY' : 'NORMAL';
      await trx.insertInto('timesheet_lines').values({ timesheet_id: t.id, attendance_date: d.attendance_date, attendance_daily_id: d.id, status: d.status, scheduled_minutes: d.scheduled_minutes, worked_minutes: d.worked_minutes, normal_minutes: d.net_worked_minutes, overtime_minutes: d.approved_overtime_minutes, late_minutes: d.late_minutes, early_leave_minutes: d.early_leave_minutes, day_kind: dayKind, leave_type_code: d.leave_type_code, is_paid: d.is_paid_day }).execute();
    }
    return t.id;
  });
}

export async function generateTimesheetsForPeriod(db: Kysely<DB>, year: number, month: number, filter: { siteId?: string; projectId?: string; employeeIds?: string[] } = {}): Promise<{ generated: number; skippedLocked: number }> {
  let q = db.selectFrom('employees').select('id').where('deleted_at', 'is', null).where('status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE']);
  if (filter.siteId) q = q.where('site_id', '=', filter.siteId);
  if (filter.projectId) q = q.where('project_id', '=', filter.projectId);
  if (filter.employeeIds?.length) q = q.where('id', 'in', filter.employeeIds);
  let generated = 0, skippedLocked = 0;
  for (const e of await q.execute()) {
    const before = await db.selectFrom('timesheets').select('locked_at').where('employee_id', '=', e.id).where('period_year', '=', year).where('period_month', '=', month).executeTakeFirst();
    if (before?.locked_at) { skippedLocked++; continue; }
    await generateTimesheet(db, e.id, year, month);
    generated++;
  }
  return { generated, skippedLocked };
}

/** Lock a timesheet and all its days (no more recalculation). */
export async function lockTimesheet(db: Kysely<DB>, timesheetId: string): Promise<void> {
  const run = (fn: (trx: Kysely<DB>) => Promise<void>) => (db.isTransaction ? fn(db) : db.transaction().execute(fn));
  await run(async (trx) => {
    const t = await trx.selectFrom('timesheets').select(['employee_id', 'period_start', 'period_end']).where('id', '=', timesheetId).forUpdate().executeTakeFirstOrThrow();
    await trx.updateTable('timesheets').set({ status: 'LOCKED', locked_at: new Date() }).where('id', '=', timesheetId).execute();
    await trx.updateTable('attendance_daily').set({ locked_at: new Date() }).where('employee_id', '=', t.employee_id).where('attendance_date', '>=', t.period_start).where('attendance_date', '<=', t.period_end).execute();
  });
}
