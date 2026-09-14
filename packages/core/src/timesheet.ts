import type { DayStatus } from '@burtplace/types';

export interface DailyLine {
  date: string;
  status: DayStatus;
  scheduledMinutes: number;
  workedMinutes: number;
  netWorkedMinutes: number;
  overtimeMinutes: number;
  approvedOvertimeMinutes: number;
  holidayMinutes: number;
  weekendMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  isPaidDay: boolean;
  leaveTypeCode: string | null;
}

export interface TimesheetSummary {
  calendarDays: number;
  scheduledDays: number;
  presentDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  weekOffDays: number;
  holidayDays: number;
  missingPunchDays: number;
  scheduledMinutes: number;
  workedMinutes: number;
  normalMinutes: number;
  overtimeMinutes: number;            // approved normal-day OT
  unapprovedOvertimeMinutes: number;
  weekendOtMinutes: number;           // approved
  holidayOtMinutes: number;           // approved
  lateMinutes: number;
  earlyLeaveMinutes: number;
  lateCount: number;
  /** days that will be paid (present + paid leave + week off + holiday + half days at 0.5) */
  paidDays: number;
}

/**
 * Aggregate daily attendance into a monthly timesheet. `leaveTypeIsPaid` decides paid vs unpaid leave.
 * MISSING_PUNCH days are counted as present for pay purposes only when `treatMissingPunchAsPresent` (policy) is true.
 */
export function summarizeTimesheet(lines: DailyLine[], opts: { leaveTypeIsPaid: (code: string) => boolean; treatMissingPunchAsPresent?: boolean }): TimesheetSummary {
  const s: TimesheetSummary = {
    calendarDays: lines.length, scheduledDays: 0, presentDays: 0, absentDays: 0, paidLeaveDays: 0, unpaidLeaveDays: 0, weekOffDays: 0, holidayDays: 0, missingPunchDays: 0,
    scheduledMinutes: 0, workedMinutes: 0, normalMinutes: 0, overtimeMinutes: 0, unapprovedOvertimeMinutes: 0, weekendOtMinutes: 0, holidayOtMinutes: 0,
    lateMinutes: 0, earlyLeaveMinutes: 0, lateCount: 0, paidDays: 0,
  };
  for (const l of lines) {
    s.workedMinutes += l.workedMinutes;
    s.lateMinutes += l.lateMinutes;
    s.earlyLeaveMinutes += l.earlyLeaveMinutes;
    if (l.lateMinutes > 0) s.lateCount++;
    switch (l.status) {
      case 'PRESENT':
        s.scheduledDays++; s.presentDays++; s.paidDays++;
        s.scheduledMinutes += l.scheduledMinutes; s.normalMinutes += l.netWorkedMinutes;
        s.overtimeMinutes += l.approvedOvertimeMinutes; s.unapprovedOvertimeMinutes += Math.max(0, l.overtimeMinutes - l.approvedOvertimeMinutes);
        break;
      case 'HALF_DAY':
        s.scheduledDays++; s.presentDays += 0.5; s.absentDays += 0.5; s.paidDays += 0.5;
        s.scheduledMinutes += l.scheduledMinutes; s.normalMinutes += l.netWorkedMinutes;
        break;
      case 'ABSENT':
        s.scheduledDays++; s.absentDays++; s.scheduledMinutes += l.scheduledMinutes;
        break;
      case 'MISSING_PUNCH':
        s.scheduledDays++; s.missingPunchDays++; s.scheduledMinutes += l.scheduledMinutes;
        if (opts.treatMissingPunchAsPresent) { s.presentDays++; s.paidDays++; s.normalMinutes += l.scheduledMinutes; }
        break;
      case 'ON_LEAVE': {
        s.scheduledDays++; s.scheduledMinutes += l.scheduledMinutes;
        const paid = l.leaveTypeCode ? opts.leaveTypeIsPaid(l.leaveTypeCode) : l.isPaidDay;
        if (paid) { s.paidLeaveDays++; s.paidDays++; } else s.unpaidLeaveDays++;
        break;
      }
      case 'WEEK_OFF':
        s.weekOffDays++; s.paidDays++; s.weekendOtMinutes += l.approvedOvertimeMinutes;
        s.unapprovedOvertimeMinutes += Math.max(0, l.overtimeMinutes - l.approvedOvertimeMinutes);
        break;
      case 'PUBLIC_HOLIDAY':
        s.holidayDays++; s.paidDays++; s.holidayOtMinutes += l.approvedOvertimeMinutes;
        s.unapprovedOvertimeMinutes += Math.max(0, l.overtimeMinutes - l.approvedOvertimeMinutes);
        break;
      case 'NOT_YET_JOINED':
      case 'EXITED':
      case 'UNSCHEDULED':
        break;
    }
  }
  return s;
}
