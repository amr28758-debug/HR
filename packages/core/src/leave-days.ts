import { dayOfWeek, eachDate, type ISODate } from './time.js';

export interface LeaveDayPolicy { countWeekOffs: boolean; countHolidays: boolean }

/** Count chargeable leave days between two dates given week-offs and holidays and the leave policy. */
export function countLeaveDays(start: ISODate, end: ISODate, weekOffs: number[], holidays: Set<ISODate>, policy: LeaveDayPolicy, isHalfDay = false): number {
  if (isHalfDay) return 0.5;
  let n = 0;
  for (const d of eachDate(start, end)) {
    const isWeekOff = weekOffs.includes(dayOfWeek(d));
    const isHoliday = holidays.has(d);
    if (isWeekOff && !policy.countWeekOffs) continue;
    if (isHoliday && !policy.countHolidays) continue;
    n++;
  }
  return n;
}
