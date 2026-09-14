import { describe, expect, it } from 'vitest';
import { summarizeTimesheet, type DailyLine } from '../src/timesheet.js';

function line(over: Partial<DailyLine>): DailyLine {
  return { date: '2026-09-01', status: 'PRESENT', scheduledMinutes: 480, workedMinutes: 480, netWorkedMinutes: 480, overtimeMinutes: 0, approvedOvertimeMinutes: 0, holidayMinutes: 0, weekendMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, isPaidDay: true, leaveTypeCode: null, ...over };
}

describe('summarizeTimesheet', () => {
  it('aggregates a mixed month', () => {
    const lines: DailyLine[] = [
      ...Array.from({ length: 19 }, () => line({})),
      line({ status: 'ABSENT', workedMinutes: 0, netWorkedMinutes: 0, isPaidDay: false }),
      line({ status: 'ON_LEAVE', leaveTypeCode: 'ANNUAL' }),
      line({ status: 'ON_LEAVE', leaveTypeCode: 'UNPAID' }),
      line({ status: 'HALF_DAY', workedMinutes: 200, netWorkedMinutes: 200 }),
      line({ status: 'MISSING_PUNCH', workedMinutes: 0, netWorkedMinutes: 0 }),
      line({ status: 'PRESENT', overtimeMinutes: 120, approvedOvertimeMinutes: 60, lateMinutes: 30 }),
      ...Array.from({ length: 4 }, () => line({ status: 'WEEK_OFF', scheduledMinutes: 0, workedMinutes: 0, netWorkedMinutes: 0 })),
      line({ status: 'WEEK_OFF', scheduledMinutes: 0, workedMinutes: 240, netWorkedMinutes: 0, overtimeMinutes: 240, approvedOvertimeMinutes: 240, weekendMinutes: 240 }),
      line({ status: 'PUBLIC_HOLIDAY', scheduledMinutes: 0, workedMinutes: 0, netWorkedMinutes: 0 }),
    ];
    const s = summarizeTimesheet(lines, { leaveTypeIsPaid: (c) => c !== 'UNPAID' });
    expect(s.calendarDays).toBe(31);
    expect(s.presentDays).toBe(20.5);
    expect(s.absentDays).toBe(1.5);
    expect(s.paidLeaveDays).toBe(1);
    expect(s.unpaidLeaveDays).toBe(1);
    expect(s.weekOffDays).toBe(5);
    expect(s.holidayDays).toBe(1);
    expect(s.missingPunchDays).toBe(1);
    expect(s.overtimeMinutes).toBe(60);
    expect(s.unapprovedOvertimeMinutes).toBe(60);
    expect(s.weekendOtMinutes).toBe(240);
    expect(s.lateMinutes).toBe(30);
    expect(s.lateCount).toBe(1);
    expect(s.paidDays).toBe(20.5 + 1 + 5 + 1);
  });
});
