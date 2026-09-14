import { sql, type Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '@burtplace/database';
import {
  calculateDay, resolveSchedule, eachDate, type Punch, type ShiftDefinition, type WorkPatternDefinition, type ShiftAssignmentDefinition, type ScheduleResolution, type LeaveOnDay,
} from '@burtplace/core';

export interface ScheduleContext {
  employee: { id: string; site_id: string | null; project_id: string | null; joining_date: string | null; last_working_date: string | null; status: string };
  assignments: ShiftAssignmentDefinition[];
  shifts: Map<string, ShiftDefinition>;
  workPatterns: Map<string, WorkPatternDefinition>;
  holidays: Set<string>;
  zone: string;
}

function toShiftDef(s: Record<string, any>): ShiftDefinition {
  return {
    id: s.id, code: s.code, startTime: String(s.start_time).slice(0, 5), endTime: String(s.end_time).slice(0, 5), requiredMinutes: s.required_minutes, breakMinutes: s.break_minutes, breakIsPaid: s.break_is_paid,
    graceInMinutes: s.grace_in_minutes, graceOutMinutes: s.grace_out_minutes, earlyInWindowMinutes: s.early_in_window_minutes, lateOutWindowMinutes: s.late_out_window_minutes,
    halfDayThresholdMinutes: s.half_day_threshold_minutes, absentThresholdMinutes: s.absent_threshold_minutes, otEnabled: s.ot_enabled, otAfterMinutes: s.ot_after_minutes,
    otMinBlockMinutes: s.ot_min_block_minutes, otMaxMinutesPerDay: s.ot_max_minutes_per_day, otRoundingMinutes: s.ot_rounding_minutes, otRequiresApproval: s.ot_requires_approval,
    countEarlyInAsOt: s.count_early_in_as_ot, timezone: s.timezone,
  };
}

/** Load everything needed to resolve an employee's schedule for any date (one round of queries per employee). */
export async function loadScheduleContext(db: Kysely<DB>, employeeId: string, from: string, to: string): Promise<ScheduleContext | null> {
  const employee = await db.selectFrom('employees').select(['id', 'site_id', 'project_id', 'joining_date', 'last_working_date', 'status']).where('id', '=', employeeId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!employee) return null;
  const rows = await db.selectFrom('shift_assignments').selectAll()
    .where((eb) => eb.or([eb('employee_id', '=', employeeId), ...(employee.site_id ? [eb('site_id', '=', employee.site_id)] : []), ...(employee.project_id ? [eb('project_id', '=', employee.project_id)] : [])]))
    .where('effective_from', '<=', to).where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', from)])).execute();
  const assignments: ShiftAssignmentDefinition[] = rows.map((a) => ({ id: a.id, scope: a.employee_id ? 'EMPLOYEE' : a.project_id ? 'PROJECT' : 'SITE', workPatternId: a.work_pattern_id, shiftId: a.shift_id, effectiveFrom: a.effective_from, effectiveTo: a.effective_to, priority: a.priority }));
  const wpIds = [...new Set(assignments.map((a) => a.workPatternId).filter((x): x is string => !!x))];
  const wps = wpIds.length ? await db.selectFrom('work_patterns').selectAll().where('id', 'in', wpIds).execute() : [];
  const workPatterns = new Map<string, WorkPatternDefinition>(wps.map((w) => [w.id, { id: w.id, weekOffs: w.week_offs, defaultShiftId: w.default_shift_id, weekdayShifts: (w.weekday_shifts ?? {}) }]));
  const shiftIds = new Set<string>();
  for (const a of assignments) if (a.shiftId) shiftIds.add(a.shiftId);
  for (const w of workPatterns.values()) { if (w.defaultShiftId) shiftIds.add(w.defaultShiftId); for (const s of Object.values(w.weekdayShifts)) shiftIds.add(s); }
  const shiftRows = shiftIds.size ? await db.selectFrom('shifts').selectAll().where('id', 'in', [...shiftIds]).execute() : [];
  const shifts = new Map(shiftRows.map((s) => [s.id, toShiftDef(s)]));
  const hol = await db.selectFrom('holidays').select(['holiday_date', 'end_date']).where('holiday_date', '<=', to).where((eb) => eb.or([eb('applies_to_site_id', 'is', null), ...(employee.site_id ? [eb('applies_to_site_id', '=', employee.site_id)] : [])])).execute();
  const holidays = new Set<string>();
  for (const h of hol) for (const d of eachDate(h.holiday_date, h.end_date ?? h.holiday_date)) holidays.add(d);
  const site = employee.site_id ? await db.selectFrom('sites').select('timezone').where('id', '=', employee.site_id).executeTakeFirst() : null;
  return { employee, assignments, shifts, workPatterns, holidays, zone: site?.timezone ?? 'Asia/Dubai' };
}

export function resolveFor(ctx: ScheduleContext, date: string): ScheduleResolution {
  return resolveSchedule({ date, assignments: ctx.assignments, shifts: ctx.shifts, workPatterns: ctx.workPatterns, holidayDates: ctx.holidays });
}

/** Punch attribution window for a date: the shift window if scheduled, else the local calendar day. */
export function windowFor(ctx: ScheduleContext, date: string, sch: ScheduleResolution): { start: Date; end: Date } {
  if (sch.windowStart && sch.windowEnd) return { start: sch.windowStart, end: sch.windowEnd };
  const start = DateTime.fromISO(date, { zone: ctx.zone }).startOf('day');
  return { start: start.toJSDate(), end: start.endOf('day').toJSDate() };
}

export interface ProcessDayResult { employeeId: string; date: string; status: string; exceptions: number; overtimeMinutes: number }

/**
 * Recalculate one employee-day from the immutable ledger + approved corrections. Idempotent; safe to re-run any time.
 * Locked days (timesheet locked) are skipped.
 */
export async function processEmployeeDay(db: Kysely<DB>, ctx: ScheduleContext, date: string, opts: { trustDeviceDirection?: boolean } = {}): Promise<ProcessDayResult | null> {
  const existing = await db.selectFrom('attendance_daily').select(['id', 'locked_at', 'approved_overtime_minutes', 'is_manual_override']).where('employee_id', '=', ctx.employee.id).where('attendance_date', '=', date).executeTakeFirst();
  if (existing?.locked_at) return null;

  const sch = resolveFor(ctx, date);
  const win = windowFor(ctx, date, sch);
  // Punches in the window, excluding those already attributed to the neighbouring date by a longer-overlapping window (handled by ordering: earlier date wins in attributePunchDate).
  const raw = await db.selectFrom('attendance_raw_events').select(['id', 'punched_at', 'direction', 'device_id', 'site_id']).where('employee_id', '=', ctx.employee.id).where('punched_at', '>=', win.start).where('punched_at', '<=', win.end).orderBy('punched_at').execute();
  // Exclude punches that belong to the previous date's shift window (cross-midnight): if previous date is scheduled and its window contains the punch, previous wins.
  const prevDate = DateTime.fromISO(date).minus({ days: 1 }).toISODate()!;
  const prevSch = resolveFor(ctx, prevDate);
  const filtered = raw.filter((p) => !(prevSch.windowEnd && new Date(p.punched_at) <= prevSch.windowEnd && prevSch.windowStart && new Date(p.punched_at) >= prevSch.windowStart && new Date(p.punched_at) < win.start!) );
  const corrections = await db.selectFrom('attendance_corrections').selectAll().where('employee_id', '=', ctx.employee.id).where('attendance_date', '=', date).where('status', '=', 'APPROVED').execute();
  const ignored = new Set(corrections.filter((c) => c.correction_type === 'IGNORE_PUNCH' && c.raw_event_id).map((c) => c.raw_event_id!));
  const directionOverride = new Map(corrections.filter((c) => c.correction_type === 'CHANGE_DIRECTION' && c.raw_event_id).map((c) => [c.raw_event_id!, c.direction!]));

  const punches: Punch[] = filtered.map((p) => ({ id: p.id, punchedAt: new Date(p.punched_at), direction: directionOverride.get(p.id) ?? p.direction, deviceId: p.device_id, siteId: p.site_id, isIgnored: ignored.has(p.id) }));
  for (const c of corrections.filter((c) => c.correction_type === 'ADD_PUNCH' && c.punched_at)) punches.push({ id: `corr:${c.id}`, punchedAt: new Date(c.punched_at!), direction: c.direction ?? 'UNKNOWN' });

  // Leave on this date
  const leaveRow = await db.selectFrom('leave_requests as lr').innerJoin('leave_types as lt', 'lt.id', 'lr.leave_type_id').select(['lr.id', 'lt.code', 'lt.is_paid', 'lr.is_half_day']).where('lr.employee_id', '=', ctx.employee.id).where('lr.status', '=', 'APPROVED').where('lr.start_date', '<=', date).where('lr.end_date', '>=', date).executeTakeFirst();
  const leave: LeaveOnDay | null = leaveRow ? { leaveRequestId: leaveRow.id, leaveTypeCode: leaveRow.code, isPaid: leaveRow.is_paid, isHalfDay: leaveRow.is_half_day } : null;

  let result = calculateDay({ date, schedule: sch, punches, leave, employeeJoinedOn: ctx.employee.joining_date, employeeLastWorkingDate: ctx.employee.last_working_date, employeeSiteId: ctx.employee.site_id, trustDeviceDirection: opts.trustDeviceDirection ?? (directionOverride.size > 0) });

  // Day override correction (HR sets the status/worked minutes explicitly, with approval)
  const override = corrections.find((c) => c.correction_type === 'OVERRIDE_DAY');
  if (override) {
    result = { ...result, status: override.override_status ?? result.status, workedMinutes: override.override_worked_minutes ?? result.workedMinutes, netWorkedMinutes: Math.min(override.override_worked_minutes ?? result.netWorkedMinutes, result.scheduledMinutes || (override.override_worked_minutes ?? 0)), exceptions: [] , isPaidDay: (override.override_status ?? result.status) !== 'ABSENT' };
  }
  const approvedOt = existing?.approved_overtime_minutes ?? 0;

  await db.transaction().execute(async (trx) => {
    const values = {
      employee_id: ctx.employee.id, attendance_date: date, shift_id: sch.shift?.id ?? null, site_id: ctx.employee.site_id, project_id: ctx.employee.project_id, status: result.status,
      first_in_at: result.firstInAt, last_out_at: result.lastOutAt, scheduled_start_at: sch.scheduledStart, scheduled_end_at: sch.scheduledEnd, scheduled_minutes: result.scheduledMinutes,
      worked_minutes: result.workedMinutes, break_minutes: result.breakMinutes, net_worked_minutes: result.netWorkedMinutes, late_minutes: result.lateMinutes, early_leave_minutes: result.earlyLeaveMinutes,
      overtime_minutes: result.overtimeMinutes, approved_overtime_minutes: Math.min(approvedOt, result.overtimeMinutes), holiday_minutes: result.holidayMinutes, weekend_minutes: result.weekendMinutes,
      leave_request_id: result.leaveRequestId, leave_type_code: result.leaveTypeCode, is_paid_day: result.isPaidDay, punch_count: result.punchCount, is_manual_override: !!override, override_correction_id: override?.id ?? null,
      calculated_at: new Date(),
    };
    await trx.insertInto('attendance_daily').values(values).onConflict((oc) => oc.columns(['employee_id', 'attendance_date']).doUpdateSet(values)).execute();

    // Rebuild processed events for the day
    await trx.deleteFrom('attendance_events').where('employee_id', '=', ctx.employee.id).where('attendance_date', '=', date).execute();
    for (const p of result.punches) {
      const isCorr = p.id.startsWith('corr:');
      await trx.insertInto('attendance_events').values({ employee_id: ctx.employee.id, raw_event_id: isCorr ? null : p.id, correction_id: isCorr ? p.id.slice(5) : null, attendance_date: date, punched_at: p.punchedAt, direction: p.resolvedDirection, device_id: p.deviceId ?? null, site_id: p.siteId ?? null, is_ignored: p.ignored, ignore_reason: p.ignoreReason ?? null }).execute();
    }
    const rawIds = result.punches.filter((p) => !p.id.startsWith('corr:')).map((p) => p.id);
    if (rawIds.length) await trx.updateTable('attendance_raw_events').set({ processed_at: new Date(), processing_error: null }).where('id', 'in', rawIds).execute();

    // Exceptions: close stale OPEN ones for this day that no longer apply, insert new ones (keep resolved history)
    const currentTypes = result.exceptions.map((e) => e.type);
    await trx.updateTable('attendance_exceptions').set({ status: 'RESOLVED', resolved_at: new Date(), resolution_note: 'auto-resolved by recalculation' }).where('employee_id', '=', ctx.employee.id).where('attendance_date', '=', date).where('status', 'in', ['OPEN', 'IN_REVIEW'])
      .where((eb) => currentTypes.length ? eb('exception_type', 'not in', currentTypes) : sql`true`).execute();
    for (const ex of result.exceptions) {
      const rawId = ex.rawEventId && !ex.rawEventId.startsWith('corr:') ? ex.rawEventId : null;
      const dup = await trx.selectFrom('attendance_exceptions').select('id').where('employee_id', '=', ctx.employee.id).where('attendance_date', '=', date).where('exception_type', '=', ex.type).where('status', 'in', ['OPEN', 'IN_REVIEW']).executeTakeFirst();
      if (dup) { await trx.updateTable('attendance_exceptions').set({ details: JSON.stringify(ex.details), severity: ex.severity }).where('id', '=', dup.id).execute(); continue; }
      await trx.insertInto('attendance_exceptions').values({ employee_id: ctx.employee.id, attendance_date: date, exception_type: ex.type, severity: ex.severity, details: JSON.stringify(ex.details), raw_event_id: rawId }).onConflict((oc) => oc.doNothing()).execute();
    }
  });
  return { employeeId: ctx.employee.id, date, status: result.status, exceptions: result.exceptions.length, overtimeMinutes: result.overtimeMinutes };
}

/** Process a range for a set of employees (or all working employees). */
export async function processRange(db: Kysely<DB>, from: string, to: string, employeeIds?: string[]): Promise<{ processed: number; skipped: number; byStatus: Record<string, number> }> {
  let q = db.selectFrom('employees').select('id').where('deleted_at', 'is', null).where('status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE']);
  if (employeeIds?.length) q = q.where('id', 'in', employeeIds);
  const ids = (await q.execute()).map((r) => r.id);
  let processed = 0, skipped = 0;
  const byStatus: Record<string, number> = {};
  for (const id of ids) {
    const ctx = await loadScheduleContext(db, id, from, to);
    if (!ctx) { skipped++; continue; }
    for (const d of eachDate(from, to)) {
      const r = await processEmployeeDay(db, ctx, d);
      if (!r) { skipped++; continue; }
      processed++;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }
  }
  return { processed, skipped, byStatus };
}

/** Process only the (employee, date) pairs touched by an ingest batch. */
export async function processAffected(db: Kysely<DB>, pairs: { employeeId: string; date: string }[]): Promise<number> {
  const byEmp = new Map<string, string[]>();
  for (const p of pairs) byEmp.set(p.employeeId, [...(byEmp.get(p.employeeId) ?? []), p.date]);
  let n = 0;
  for (const [employeeId, dates] of byEmp) {
    const sorted = [...new Set(dates)].sort();
    const ctx = await loadScheduleContext(db, employeeId, sorted[0]!, sorted[sorted.length - 1]!);
    if (!ctx) continue;
    for (const d of sorted) if (await processEmployeeDay(db, ctx, d)) n++;
  }
  return n;
}
