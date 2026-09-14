import type { ShiftDefinition, WorkPatternDefinition, ShiftAssignmentDefinition } from '../src/shift-engine.js';

export const TZ = 'Asia/Dubai';

export function siteDayShift(over: Partial<ShiftDefinition> = {}): ShiftDefinition {
  return {
    id: 'shift-day', code: 'SITE-DAY', startTime: '06:00', endTime: '17:00', requiredMinutes: 480, breakMinutes: 60, breakIsPaid: false,
    graceInMinutes: 15, graceOutMinutes: 0, earlyInWindowMinutes: 120, lateOutWindowMinutes: 360, halfDayThresholdMinutes: 240, absentThresholdMinutes: 0,
    otEnabled: true, otAfterMinutes: null, otMinBlockMinutes: 30, otMaxMinutesPerDay: 240, otRoundingMinutes: 15, otRequiresApproval: true, countEarlyInAsOt: false, timezone: TZ,
    ...over,
  };
}

export function nightShift(over: Partial<ShiftDefinition> = {}): ShiftDefinition {
  return siteDayShift({ id: 'shift-night', code: 'SITE-NIGHT', startTime: '18:00', endTime: '05:00', ...over });
}

export function pattern(shiftId: string, weekOffs = [5]): WorkPatternDefinition {
  return { id: 'wp-1', weekOffs, defaultShiftId: shiftId, weekdayShifts: {} };
}

export function siteAssignment(over: Partial<ShiftAssignmentDefinition> = {}): ShiftAssignmentDefinition {
  return { id: 'asg-site', scope: 'SITE', workPatternId: 'wp-1', shiftId: null, effectiveFrom: '2026-01-01', effectiveTo: null, priority: 0, ...over };
}

/** Dubai local time → Date */
export function dxb(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+04:00`);
}
