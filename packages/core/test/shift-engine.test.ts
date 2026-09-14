import { describe, expect, it } from 'vitest';
import { attributePunchDate, pickAssignment, resolveSchedule, shiftWindow } from '../src/shift-engine.js';
import { dxb, nightShift, pattern, siteAssignment, siteDayShift } from './helpers.js';

describe('shiftWindow', () => {
  it('computes a same-day window in the shift timezone', () => {
    const w = shiftWindow(siteDayShift(), '2026-09-07');
    expect(w.start.toISOString()).toBe('2026-09-07T02:00:00.000Z'); // 06:00 GST
    expect(w.end.toISOString()).toBe('2026-09-07T13:00:00.000Z');   // 17:00 GST
    expect(w.windowStart.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(w.windowEnd.toISOString()).toBe('2026-09-07T19:00:00.000Z');
  });
  it('rolls the end to the next day for cross-midnight shifts', () => {
    const w = shiftWindow(nightShift(), '2026-09-07');
    expect(w.start.toISOString()).toBe('2026-09-07T14:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-08T01:00:00.000Z');
  });
});

describe('pickAssignment', () => {
  it('prefers employee > project > site, then priority', () => {
    const site = siteAssignment();
    const project = siteAssignment({ id: 'asg-proj', scope: 'PROJECT' });
    const emp = siteAssignment({ id: 'asg-emp', scope: 'EMPLOYEE', effectiveTo: '2026-06-30' });
    expect(pickAssignment([site, project, emp], '2026-05-01')?.id).toBe('asg-emp');
    expect(pickAssignment([site, project, emp], '2026-09-01')?.id).toBe('asg-proj');
    expect(pickAssignment([site, siteAssignment({ id: 'asg-site-2', priority: 5 })], '2026-09-01')?.id).toBe('asg-site-2');
    expect(pickAssignment([site], '2025-12-31')).toBeNull();
  });
});

describe('resolveSchedule', () => {
  const shifts = new Map([['shift-day', siteDayShift()]]);
  const wps = new Map([['wp-1', pattern('shift-day', [5])]]);
  it('marks Friday as week off for a Fri-off pattern', () => {
    const r = resolveSchedule({ date: '2026-09-11', assignments: [siteAssignment()], shifts, workPatterns: wps, holidayDates: new Set() }); // Friday
    expect(r.isWeekOff).toBe(true);
    expect(r.isWorkingDay).toBe(false);
    expect(r.shift?.id).toBe('shift-day');
  });
  it('marks holidays', () => {
    const r = resolveSchedule({ date: '2026-12-02', assignments: [siteAssignment()], shifts, workPatterns: wps, holidayDates: new Set(['2026-12-02']) });
    expect(r.isHoliday).toBe(true);
    expect(r.isWorkingDay).toBe(false);
  });
  it('is a working day with a scheduled window otherwise', () => {
    const r = resolveSchedule({ date: '2026-09-07', assignments: [siteAssignment()], shifts, workPatterns: wps, holidayDates: new Set() });
    expect(r.isWorkingDay).toBe(true);
    expect(r.scheduledStart?.toISOString()).toBe('2026-09-07T02:00:00.000Z');
  });
  it('returns unscheduled when there is no assignment', () => {
    const r = resolveSchedule({ date: '2026-09-07', assignments: [], shifts, workPatterns: wps, holidayDates: new Set() });
    expect(r.isWorkingDay).toBe(false);
    expect(r.shift).toBeNull();
  });
  it('uses weekday shift overrides', () => {
    const wp2 = new Map([['wp-1', { ...pattern('shift-day'), weekdayShifts: { '1': 'shift-night' } }]]);
    const s2 = new Map([['shift-day', siteDayShift()], ['shift-night', nightShift()]]);
    const r = resolveSchedule({ date: '2026-09-07', assignments: [siteAssignment()], shifts: s2, workPatterns: wp2, holidayDates: new Set() }); // Monday
    expect(r.shift?.id).toBe('shift-night');
  });
});

describe('attributePunchDate', () => {
  const shifts = new Map([['shift-night', nightShift()]]);
  const wps = new Map([['wp-1', pattern('shift-night', [])]]);
  const resolveFor = (date: string) => resolveSchedule({ date, assignments: [siteAssignment()], shifts, workPatterns: wps, holidayDates: new Set() });
  it('assigns a 02:00 punch to the previous business date for a night shift', () => {
    expect(attributePunchDate(dxb('2026-09-08', '02:00'), resolveFor, 'Asia/Dubai')).toBe('2026-09-07');
  });
  it('assigns a 17:30 punch (early in) to the same date', () => {
    expect(attributePunchDate(dxb('2026-09-08', '17:30'), resolveFor, 'Asia/Dubai')).toBe('2026-09-08');
  });
});
