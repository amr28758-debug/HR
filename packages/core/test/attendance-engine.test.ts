import { describe, expect, it } from 'vitest';
import { calculateDay, resolvePunches, type Punch } from '../src/attendance-engine.js';
import { resolveSchedule, type ScheduleResolution } from '../src/shift-engine.js';
import { dxb, nightShift, pattern, siteAssignment, siteDayShift } from './helpers.js';

const shifts = new Map([['shift-day', siteDayShift()]]);
const wps = new Map([['wp-1', pattern('shift-day', [5])]]);
function schedule(date: string, holidays: string[] = []): ScheduleResolution {
  return resolveSchedule({ date, assignments: [siteAssignment()], shifts, workPatterns: wps, holidayDates: new Set(holidays) });
}
function p(id: string, date: string, time: string, direction: Punch['direction'] = 'UNKNOWN'): Punch {
  return { id, punchedAt: dxb(date, time), direction };
}
const MON = '2026-09-07';
const base = { employeeJoinedOn: '2025-01-01', employeeLastWorkingDate: null };

describe('resolvePunches', () => {
  it('alternates IN/OUT when direction unknown and drops duplicates in window', () => {
    const { resolved, exceptions } = resolvePunches([p('a', MON, '06:00'), p('b', MON, '06:01'), p('c', MON, '17:00')], { duplicateWindowMinutes: 2, trustDeviceDirection: false });
    expect(resolved.map((r) => [r.resolvedDirection, r.ignored])).toEqual([['IN', false], ['IN', true], ['OUT', false]]);
    expect(exceptions[0]?.type).toBe('DUPLICATE_PUNCH');
  });
  it('trusts device direction when configured', () => {
    const { resolved } = resolvePunches([p('a', MON, '06:00', 'OUT'), p('b', MON, '17:00', 'IN')], { duplicateWindowMinutes: 2, trustDeviceDirection: true });
    expect(resolved.map((r) => r.resolvedDirection)).toEqual(['OUT', 'IN']);
  });
});

describe('calculateDay — working day', () => {
  it('normal full day: 06:00→17:00 = 660 presence − 60 break = 600 worked, 480 normal, 120 OT (rounded), no late/early', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '17:00')], leave: null, ...base });
    expect(r.status).toBe('PRESENT');
    expect(r.workedMinutes).toBe(600);
    expect(r.breakMinutes).toBe(60);
    expect(r.netWorkedMinutes).toBe(480);
    expect(r.overtimeMinutes).toBe(0); // no time after scheduled end → no OT
    expect(r.lateMinutes).toBe(0);
    expect(r.earlyLeaveMinutes).toBe(0);
    expect(r.isPaidDay).toBe(true);
  });
  it('overtime after scheduled end: leaves 19:10 → 130 min after end, worked 730-60=670 → beyond 480 = 190 → min(130,190)=130 → rounded 120', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '19:10')], leave: null, ...base });
    expect(r.overtimeMinutes).toBe(120);
    expect(r.exceptions.map((e) => e.type)).toContain('UNAPPROVED_OT');
  });
  it('OT below min block is dropped', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '17:20')], leave: null, ...base });
    expect(r.overtimeMinutes).toBe(0);
  });
  it('excessive OT is flagged', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '22:30')], leave: null, ...base });
    expect(r.overtimeMinutes).toBe(330);
    expect(r.exceptions.map((e) => e.type)).toContain('EXCESSIVE_OT');
  });
  it('late beyond grace is counted in full; within grace is zero', () => {
    const late = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:20'), p('b', MON, '17:00')], leave: null, ...base });
    expect(late.lateMinutes).toBe(20);
    expect(late.exceptions.map((e) => e.type)).toContain('LATE');
    const ok = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:14'), p('b', MON, '17:00')], leave: null, ...base });
    expect(ok.lateMinutes).toBe(0);
  });
  it('early leave is measured against scheduled end', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '15:30')], leave: null, ...base });
    expect(r.earlyLeaveMinutes).toBe(90);
    expect(r.status).toBe('PRESENT');
  });
  it('half day when worked below threshold', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '10:00')], leave: null, ...base });
    expect(r.status).toBe('HALF_DAY');
    expect(r.workedMinutes).toBe(180); // 240 − 60 break
  });
  it('absent when no punches', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [], leave: null, ...base });
    expect(r.status).toBe('ABSENT');
    expect(r.isPaidDay).toBe(false);
    expect(r.exceptions[0]?.type).toBe('ABSENT');
  });
  it('missing out when only one punch', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:30')], leave: null, ...base });
    expect(r.status).toBe('MISSING_PUNCH');
    expect(r.exceptions.map((e) => e.type)).toEqual(expect.arrayContaining(['MISSING_OUT', 'LATE']));
    expect(r.lateMinutes).toBe(30);
  });
  it('full-day leave overrides punches', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '17:00')], leave: { leaveRequestId: 'L1', leaveTypeCode: 'ANNUAL', isPaid: true, isHalfDay: false }, ...base });
    expect(r.status).toBe('ON_LEAVE');
    expect(r.leaveRequestId).toBe('L1');
    expect(r.isPaidDay).toBe(true);
  });
  it('half-day leave halves the required minutes', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [p('a', MON, '06:00'), p('b', MON, '11:00')], leave: { leaveRequestId: 'L2', leaveTypeCode: 'ANNUAL', isPaid: true, isHalfDay: true }, ...base });
    expect(r.status).toBe('PRESENT');
    expect(r.netWorkedMinutes).toBe(240);
    expect(r.leaveRequestId).toBe('L2');
  });
  it('flags punches from another site', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON), punches: [{ ...p('a', MON, '06:00'), siteId: 'site-B' }, p('b', MON, '17:00')], leave: null, employeeSiteId: 'site-A', ...base });
    expect(r.exceptions.map((e) => e.type)).toContain('OUTSIDE_SITE');
  });
});

describe('calculateDay — non-working days', () => {
  const FRI = '2026-09-11';
  it('week off with no punches is WEEK_OFF, paid, no absence', () => {
    const r = calculateDay({ date: FRI, schedule: schedule(FRI), punches: [], leave: null, ...base });
    expect(r.status).toBe('WEEK_OFF');
    expect(r.exceptions).toHaveLength(0);
  });
  it('week off with work is weekend OT (rounded, min block)', () => {
    const r = calculateDay({ date: FRI, schedule: schedule(FRI), punches: [p('a', FRI, '07:00'), p('b', FRI, '12:10')], leave: null, ...base });
    expect(r.status).toBe('WEEK_OFF');
    expect(r.workedMinutes).toBe(250); // 310 − 60 break
    expect(r.weekendMinutes).toBe(250);
    expect(r.overtimeMinutes).toBe(240);
  });
  it('public holiday with work is holiday OT', () => {
    const r = calculateDay({ date: MON, schedule: schedule(MON, [MON]), punches: [p('a', MON, '06:00'), p('b', MON, '10:00')], leave: null, ...base });
    expect(r.status).toBe('PUBLIC_HOLIDAY');
    expect(r.holidayMinutes).toBe(180);
    expect(r.overtimeMinutes).toBe(180);
  });
  it('before joining / after exit', () => {
    expect(calculateDay({ date: MON, schedule: schedule(MON), punches: [], leave: null, employeeJoinedOn: '2026-10-01', employeeLastWorkingDate: null }).status).toBe('NOT_YET_JOINED');
    expect(calculateDay({ date: MON, schedule: schedule(MON), punches: [], leave: null, employeeJoinedOn: '2025-01-01', employeeLastWorkingDate: '2026-08-31' }).status).toBe('EXITED');
  });
  it('unscheduled employee with punches is PRESENT without absence logic', () => {
    const unsched = resolveSchedule({ date: MON, assignments: [], shifts, workPatterns: wps, holidayDates: new Set() });
    const r = calculateDay({ date: MON, schedule: unsched, punches: [p('a', MON, '08:00'), p('b', MON, '12:00')], leave: null, ...base });
    expect(r.status).toBe('PRESENT');
    expect(r.workedMinutes).toBe(240);
  });
});

describe('calculateDay — night shift across midnight', () => {
  const ns = new Map([['shift-night', nightShift()]]);
  const nwp = new Map([['wp-1', pattern('shift-night', [5])]]);
  it('computes worked minutes across the date boundary', () => {
    const sch = resolveSchedule({ date: MON, assignments: [siteAssignment()], shifts: ns, workPatterns: nwp, holidayDates: new Set() });
    const r = calculateDay({ date: MON, schedule: sch, punches: [p('a', MON, '18:00'), p('b', '2026-09-08', '05:00')], leave: null, ...base });
    expect(r.status).toBe('PRESENT');
    expect(r.workedMinutes).toBe(600);
    expect(r.lateMinutes).toBe(0);
    expect(r.earlyLeaveMinutes).toBe(0);
  });
});
