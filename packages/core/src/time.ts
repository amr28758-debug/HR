import { DateTime, type DateTimeUnit } from 'luxon';

export type ISODate = string; // YYYY-MM-DD

export function localDateTime(date: ISODate, time: string, zone: string): DateTime {
  const [h, m, s = '0'] = time.split(':');
  return DateTime.fromISO(date, { zone }).set({ hour: Number(h), minute: Number(m), second: Number(s), millisecond: 0 });
}

export function toISODate(d: Date | DateTime, zone: string): ISODate {
  const dt = d instanceof Date ? DateTime.fromJSDate(d, { zone }) : d.setZone(zone);
  return dt.toISODate() as ISODate;
}

export function addDays(date: ISODate, days: number): ISODate {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate() as ISODate;
}

/** 0 = Sunday … 6 = Saturday (JS convention) for a calendar date. */
export function dayOfWeek(date: ISODate): number {
  const wd = DateTime.fromISO(date, { zone: 'utc' }).weekday; // 1 = Monday … 7 = Sunday
  return wd % 7;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function monthRange(year: number, month: number): { start: ISODate; end: ISODate; days: number } {
  const start = DateTime.utc(year, month, 1);
  const end = start.endOf('month');
  return { start: start.toISODate() as ISODate, end: end.toISODate() as ISODate, days: end.day };
}

export function eachDate(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  let cur = DateTime.fromISO(start, { zone: 'utc' });
  const last = DateTime.fromISO(end, { zone: 'utc' });
  while (cur <= last) {
    out.push(cur.toISODate() as ISODate);
    cur = cur.plus({ days: 1 });
  }
  return out;
}

export function startOf(d: Date, unit: DateTimeUnit, zone: string): Date {
  return DateTime.fromJSDate(d, { zone }).startOf(unit).toJSDate();
}
