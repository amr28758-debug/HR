import type { AttendanceExceptionType, DayStatus, PunchDirection } from '@burtplace/types';
import { minutesBetween } from './time.js';
import type { ScheduleResolution } from './shift-engine.js';

export interface Punch {
  id: string;
  punchedAt: Date;
  direction: PunchDirection; // may be UNKNOWN → resolved by alternation
  deviceId?: string | null;
  siteId?: string | null;
  isIgnored?: boolean;
}

export interface LeaveOnDay {
  leaveRequestId: string;
  leaveTypeCode: string;
  isPaid: boolean;
  isHalfDay: boolean;
}

export interface DailyCalculationInput {
  date: string;
  schedule: ScheduleResolution;
  punches: Punch[];
  leave: LeaveOnDay | null;
  employeeJoinedOn: string | null;
  employeeLastWorkingDate: string | null;
  employeeSiteId?: string | null;
  /** Minimum minutes between two punches; closer punches are duplicates (default 2). */
  duplicateWindowMinutes?: number;
  /** Which punch directions to trust: if the device reports IN/OUT reliably keep them; otherwise alternate. */
  trustDeviceDirection?: boolean;
}

export interface ExceptionFinding {
  type: AttendanceExceptionType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  details: Record<string, unknown>;
  rawEventId?: string;
}

export interface ResolvedPunch extends Punch {
  resolvedDirection: 'IN' | 'OUT';
  ignored: boolean;
  ignoreReason?: string;
}

export interface DailyCalculationResult {
  status: DayStatus;
  firstInAt: Date | null;
  lastOutAt: Date | null;
  scheduledMinutes: number;
  workedMinutes: number;        // presence minus unpaid break
  breakMinutes: number;
  netWorkedMinutes: number;     // counted toward normal hours (≤ scheduled)
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;      // computed (pre-approval), after rounding/min-block
  holidayMinutes: number;
  weekendMinutes: number;
  isPaidDay: boolean;
  punchCount: number;
  leaveRequestId: string | null;
  leaveTypeCode: string | null;
  exceptions: ExceptionFinding[];
  punches: ResolvedPunch[];
}

/** Sort, drop duplicates within window, resolve IN/OUT by alternation when the device does not report direction. */
export function resolvePunches(punches: Punch[], opts: { duplicateWindowMinutes: number; trustDeviceDirection: boolean }): { resolved: ResolvedPunch[]; exceptions: ExceptionFinding[] } {
  const sorted = [...punches].filter((p) => !p.isIgnored).sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
  const resolved: ResolvedPunch[] = [];
  const exceptions: ExceptionFinding[] = [];
  let expect: 'IN' | 'OUT' = 'IN';
  let last: ResolvedPunch | null = null;
  for (const p of sorted) {
    if (last && minutesBetween(last.punchedAt, p.punchedAt) < opts.duplicateWindowMinutes) {
      resolved.push({ ...p, resolvedDirection: last.resolvedDirection, ignored: true, ignoreReason: 'DUPLICATE_WITHIN_WINDOW' });
      exceptions.push({ type: 'DUPLICATE_PUNCH', severity: 'LOW', details: { punchedAt: p.punchedAt.toISOString(), previous: last.punchedAt.toISOString() }, rawEventId: p.id });
      continue;
    }
    let dir: 'IN' | 'OUT';
    if (opts.trustDeviceDirection && (p.direction === 'IN' || p.direction === 'OUT')) dir = p.direction;
    else dir = expect;
    const rp: ResolvedPunch = { ...p, resolvedDirection: dir, ignored: false };
    resolved.push(rp);
    last = rp;
    expect = dir === 'IN' ? 'OUT' : 'IN';
  }
  return { resolved, exceptions };
}

function roundDown(minutes: number, block: number): number {
  if (block <= 1) return minutes;
  return Math.floor(minutes / block) * block;
}

/**
 * The attendance engine. Pure. Given one employee-day (schedule, punches, leave), produce the daily record and exceptions.
 * Rules come from the shift definition — nothing here is hard-coded to Burtplace.
 */
export function calculateDay(input: DailyCalculationInput): DailyCalculationResult {
  const { schedule, date } = input;
  const exceptions: ExceptionFinding[] = [];
  const { resolved, exceptions: dupEx } = resolvePunches(input.punches, {
    duplicateWindowMinutes: input.duplicateWindowMinutes ?? 2,
    trustDeviceDirection: input.trustDeviceDirection ?? false,
  });
  exceptions.push(...dupEx);
  const active = resolved.filter((p) => !p.ignored);
  const ins = active.filter((p) => p.resolvedDirection === 'IN');
  const outs = active.filter((p) => p.resolvedDirection === 'OUT');
  const firstIn = ins[0]?.punchedAt ?? null;
  const lastOut = outs.length ? outs[outs.length - 1]!.punchedAt : null;

  const base = {
    firstInAt: firstIn, lastOutAt: lastOut, scheduledMinutes: 0, workedMinutes: 0, breakMinutes: 0, netWorkedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0,
    overtimeMinutes: 0, holidayMinutes: 0, weekendMinutes: 0, isPaidDay: true, punchCount: active.length, leaveRequestId: null as string | null, leaveTypeCode: null as string | null,
    exceptions, punches: resolved,
  };

  // Employment boundaries
  if (input.employeeJoinedOn && date < input.employeeJoinedOn) return { ...base, status: 'NOT_YET_JOINED', isPaidDay: false };
  if (input.employeeLastWorkingDate && date > input.employeeLastWorkingDate) return { ...base, status: 'EXITED', isPaidDay: false };

  // Site mismatch: punches from a device at a different site than the employee's assigned site
  if (input.employeeSiteId) {
    for (const p of active) {
      if (p.siteId && p.siteId !== input.employeeSiteId) {
        exceptions.push({ type: 'OUTSIDE_SITE', severity: 'MEDIUM', details: { punchSiteId: p.siteId, employeeSiteId: input.employeeSiteId }, rawEventId: p.id });
        break;
      }
    }
  }

  // Presence computation (shared by working days, week-offs, holidays)
  let presence = 0;
  if (firstIn && lastOut && lastOut > firstIn) presence = minutesBetween(firstIn, lastOut);
  const shift = schedule.shift;

  // Full-day leave wins over everything else (attendance on leave day is still recorded as punches but the day is ON_LEAVE)
  if (input.leave && !input.leave.isHalfDay) {
    return { ...base, status: 'ON_LEAVE', leaveRequestId: input.leave.leaveRequestId, leaveTypeCode: input.leave.leaveTypeCode, isPaidDay: input.leave.isPaid,
      scheduledMinutes: shift && schedule.isWorkingDay ? shift.requiredMinutes : 0 };
  }

  // Week off / public holiday: any presence is weekend/holiday minutes (OT candidates), no absence.
  if (schedule.isHoliday || schedule.isWeekOff) {
    const unpaidBreak = shift && !shift.breakIsPaid && presence > shift.breakMinutes ? shift.breakMinutes : 0;
    const worked = Math.max(0, presence - unpaidBreak);
    const otBlock = shift ? roundDown(worked, shift.otRoundingMinutes) : worked;
    const ot = shift ? (otBlock >= shift.otMinBlockMinutes ? otBlock : 0) : otBlock;
    if (active.length % 2 === 1) exceptions.push({ type: outs.length === 0 ? 'MISSING_OUT' : 'MISSING_IN', severity: 'LOW', details: { punchCount: active.length, dayKind: schedule.isHoliday ? 'PUBLIC_HOLIDAY' : 'WEEK_OFF' } });
    if (shift?.otMaxMinutesPerDay && ot > shift.otMaxMinutesPerDay) exceptions.push({ type: 'EXCESSIVE_OT', severity: 'HIGH', details: { overtimeMinutes: ot, max: shift.otMaxMinutesPerDay } });
    if (ot > 0 && shift?.otRequiresApproval) exceptions.push({ type: 'UNAPPROVED_OT', severity: 'LOW', details: { overtimeMinutes: ot } });
    return {
      ...base, status: schedule.isHoliday ? 'PUBLIC_HOLIDAY' : 'WEEK_OFF', workedMinutes: worked, breakMinutes: unpaidBreak, overtimeMinutes: ot,
      holidayMinutes: schedule.isHoliday ? worked : 0, weekendMinutes: schedule.isHoliday ? 0 : worked, isPaidDay: schedule.isHoliday ? true : true,
    };
  }

  // Unscheduled (no assignment): record presence but no absence/late logic
  if (!shift || !schedule.scheduledStart || !schedule.scheduledEnd) {
    if (active.length % 2 === 1) exceptions.push({ type: 'MISSING_OUT', severity: 'LOW', details: { punchCount: active.length } });
    return { ...base, status: active.length ? 'PRESENT' : 'UNSCHEDULED', workedMinutes: presence, netWorkedMinutes: presence };
  }

  const scheduledMinutes = shift.requiredMinutes;
  const halfDayLeave = input.leave?.isHalfDay ? input.leave : null;
  const effectiveRequired = halfDayLeave ? Math.round(scheduledMinutes / 2) : scheduledMinutes;

  // No punches at all → ABSENT (or half-day leave + absent other half)
  if (active.length === 0) {
    exceptions.push({ type: 'ABSENT', severity: 'HIGH', details: { scheduledStart: schedule.scheduledStart.toISOString() } });
    return { ...base, status: 'ABSENT', scheduledMinutes, isPaidDay: false, leaveRequestId: halfDayLeave?.leaveRequestId ?? null, leaveTypeCode: halfDayLeave?.leaveTypeCode ?? null };
  }

  // Missing punch: odd count → we cannot compute a span; flag and treat as MISSING_PUNCH (HR must correct)
  if (active.length % 2 === 1 || !firstIn || !lastOut) {
    const type: AttendanceExceptionType = !firstIn ? 'MISSING_IN' : 'MISSING_OUT';
    exceptions.push({ type, severity: 'MEDIUM', details: { punchCount: active.length, firstIn: firstIn?.toISOString() ?? null, lastOut: lastOut?.toISOString() ?? null } });
    // Late can still be evaluated from first IN
    const lateRawMp = firstIn ? minutesBetween(schedule.scheduledStart, firstIn) : 0;
    const late = lateRawMp > shift.graceInMinutes ? lateRawMp : 0;
    if (late > 0) exceptions.push({ type: 'LATE', severity: 'LOW', details: { lateMinutes: late } });
    return { ...base, status: 'MISSING_PUNCH', scheduledMinutes, lateMinutes: late, isPaidDay: true, leaveRequestId: halfDayLeave?.leaveRequestId ?? null, leaveTypeCode: halfDayLeave?.leaveTypeCode ?? null };
  }

  // Full span available
  const unpaidBreak = !shift.breakIsPaid && presence > shift.breakMinutes ? shift.breakMinutes : 0;
  const worked = Math.max(0, presence - unpaidBreak);

  const lateRaw = minutesBetween(schedule.scheduledStart, firstIn);
  const late = lateRaw > shift.graceInMinutes ? lateRaw : 0;
  const earlyRaw = minutesBetween(lastOut, schedule.scheduledEnd);
  const early = earlyRaw > shift.graceOutMinutes ? earlyRaw : 0;

  // Overtime: minutes beyond the OT threshold, measured on worked minutes within (or beyond) the scheduled end.
  let ot = 0;
  if (shift.otEnabled) {
    const threshold = shift.otAfterMinutes ?? shift.requiredMinutes;
    // OT = worked minutes beyond the threshold. Unless the shift counts early arrival, OT is additionally capped
    // to the minutes actually worked after the scheduled end (arriving early does not create OT).
    const beyondThreshold = Math.max(0, worked - threshold);
    const afterEnd = Math.max(0, minutesBetween(schedule.scheduledEnd, lastOut));
    const otCandidate = shift.countEarlyInAsOt ? beyondThreshold : Math.min(beyondThreshold, afterEnd);
    const rounded = roundDown(otCandidate, shift.otRoundingMinutes);
    ot = rounded >= shift.otMinBlockMinutes ? rounded : 0;
    if (shift.otMaxMinutesPerDay && ot > shift.otMaxMinutesPerDay) {
      exceptions.push({ type: 'EXCESSIVE_OT', severity: 'HIGH', details: { overtimeMinutes: ot, max: shift.otMaxMinutesPerDay } });
    }
    if (ot > 0 && shift.otRequiresApproval) exceptions.push({ type: 'UNAPPROVED_OT', severity: 'LOW', details: { overtimeMinutes: ot } });
  }

  const net = Math.min(worked, effectiveRequired);
  let status: DayStatus = 'PRESENT';
  if (worked <= shift.absentThresholdMinutes) status = 'ABSENT';
  else if (shift.halfDayThresholdMinutes !== null && worked < shift.halfDayThresholdMinutes && !halfDayLeave) status = 'HALF_DAY';

  if (status === 'ABSENT') exceptions.push({ type: 'ABSENT', severity: 'HIGH', details: { workedMinutes: worked, threshold: shift.absentThresholdMinutes } });
  if (late > 0) exceptions.push({ type: 'LATE', severity: late > 60 ? 'MEDIUM' : 'LOW', details: { lateMinutes: late, grace: shift.graceInMinutes } });
  if (early > 0 && status !== 'ABSENT') exceptions.push({ type: 'EARLY_LEAVE', severity: early > 60 ? 'MEDIUM' : 'LOW', details: { earlyLeaveMinutes: early } });

  return {
    ...base, status, scheduledMinutes, workedMinutes: worked, breakMinutes: unpaidBreak, netWorkedMinutes: net, lateMinutes: late, earlyLeaveMinutes: early,
    overtimeMinutes: ot, isPaidDay: status !== 'ABSENT', leaveRequestId: halfDayLeave?.leaveRequestId ?? null, leaveTypeCode: halfDayLeave?.leaveTypeCode ?? null,
  };
}
