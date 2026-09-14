import { DateTime } from 'luxon';
import { addDays, dayOfWeek, localDateTime, type ISODate } from './time.js';

/** Shift definition as stored in `shifts` (subset the engine needs). All times are local to `timezone`. */
export interface ShiftDefinition {
  id: string;
  code: string;
  startTime: string; // 'HH:mm'
  endTime: string;   // 'HH:mm' — if <= startTime, shift crosses midnight
  requiredMinutes: number;
  breakMinutes: number;
  breakIsPaid: boolean;
  graceInMinutes: number;
  graceOutMinutes: number;
  earlyInWindowMinutes: number;
  lateOutWindowMinutes: number;
  halfDayThresholdMinutes: number | null;
  absentThresholdMinutes: number;
  otEnabled: boolean;
  otAfterMinutes: number | null;
  otMinBlockMinutes: number;
  otMaxMinutesPerDay: number | null;
  otRoundingMinutes: number;
  otRequiresApproval: boolean;
  countEarlyInAsOt: boolean;
  timezone: string;
}

export interface WorkPatternDefinition {
  id: string;
  weekOffs: number[];                 // 0=Sun..6=Sat
  defaultShiftId: string | null;
  weekdayShifts: Record<string, string>; // '0'..'6' → shiftId
}

export interface ShiftAssignmentDefinition {
  id: string;
  scope: 'EMPLOYEE' | 'PROJECT' | 'SITE';
  workPatternId: string | null;
  shiftId: string | null;
  effectiveFrom: ISODate;
  effectiveTo: ISODate | null;
  priority: number;
}

export interface ScheduleResolution {
  isWorkingDay: boolean;
  isWeekOff: boolean;
  isHoliday: boolean;
  shift: ShiftDefinition | null;
  assignmentId: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  /** window in which punches are attributed to this business date */
  windowStart: Date | null;
  windowEnd: Date | null;
}

const SCOPE_RANK: Record<ShiftAssignmentDefinition['scope'], number> = { EMPLOYEE: 3, PROJECT: 2, SITE: 1 };

function activeOn(a: ShiftAssignmentDefinition, date: ISODate): boolean {
  return a.effectiveFrom <= date && (a.effectiveTo === null || a.effectiveTo >= date);
}

/** Pick the winning assignment for a date: employee > project > site, then priority, then latest effectiveFrom. */
export function pickAssignment(assignments: ShiftAssignmentDefinition[], date: ISODate): ShiftAssignmentDefinition | null {
  const candidates = assignments.filter((a) => activeOn(a, date));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] || b.priority - a.priority || b.effectiveFrom.localeCompare(a.effectiveFrom));
  return candidates[0] ?? null;
}

/** Compute the scheduled shift window (UTC instants) for a business date. Handles cross-midnight shifts. */
export function shiftWindow(shift: ShiftDefinition, date: ISODate): { start: Date; end: Date; windowStart: Date; windowEnd: Date } {
  const start = localDateTime(date, shift.startTime, shift.timezone);
  let end = localDateTime(date, shift.endTime, shift.timezone);
  if (end <= start) end = end.plus({ days: 1 });
  return {
    start: start.toJSDate(),
    end: end.toJSDate(),
    windowStart: start.minus({ minutes: shift.earlyInWindowMinutes }).toJSDate(),
    windowEnd: end.plus({ minutes: shift.lateOutWindowMinutes }).toJSDate(),
  };
}

export interface ResolveScheduleInput {
  date: ISODate;
  assignments: ShiftAssignmentDefinition[];
  shifts: Map<string, ShiftDefinition>;
  workPatterns: Map<string, WorkPatternDefinition>;
  holidayDates: Set<ISODate>;
}

/** Resolve whether an employee is scheduled on `date`, and with which shift. Pure function. */
export function resolveSchedule(input: ResolveScheduleInput): ScheduleResolution {
  const none: ScheduleResolution = { isWorkingDay: false, isWeekOff: false, isHoliday: input.holidayDates.has(input.date), shift: null, assignmentId: null, scheduledStart: null, scheduledEnd: null, windowStart: null, windowEnd: null };
  const assignment = pickAssignment(input.assignments, input.date);
  if (!assignment) return none;

  let shiftId: string | null = assignment.shiftId;
  let isWeekOff = false;
  if (assignment.workPatternId) {
    const wp = input.workPatterns.get(assignment.workPatternId);
    if (wp) {
      const dow = dayOfWeek(input.date);
      isWeekOff = wp.weekOffs.includes(dow);
      shiftId = shiftId ?? wp.weekdayShifts[String(dow)] ?? wp.defaultShiftId;
    }
  }
  const shift = shiftId ? input.shifts.get(shiftId) ?? null : null;
  const isHoliday = input.holidayDates.has(input.date);
  if (!shift) return { ...none, isWeekOff, isHoliday, assignmentId: assignment.id };
  const w = shiftWindow(shift, input.date);
  return {
    isWorkingDay: !isWeekOff && !isHoliday,
    isWeekOff,
    isHoliday,
    shift,
    assignmentId: assignment.id,
    scheduledStart: w.start,
    scheduledEnd: w.end,
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
  };
}

/**
 * Attribute a punch instant to a business date. For a cross-midnight shift, a punch at 02:00 belongs to the
 * previous calendar day's shift. Strategy: test the calendar date of the punch and the previous date; return the
 * one whose window contains the punch, preferring the earlier date (shift that started first).
 */
export function attributePunchDate(punchedAt: Date, resolveFor: (date: ISODate) => ScheduleResolution, zone: string): ISODate {
  const calDate = DateTime.fromJSDate(punchedAt, { zone }).toISODate() as ISODate;
  const prev = addDays(calDate, -1);
  for (const candidate of [prev, calDate]) {
    const r = resolveFor(candidate);
    if (r.windowStart && r.windowEnd && punchedAt >= r.windowStart && punchedAt <= r.windowEnd) return candidate;
  }
  return calDate;
}
