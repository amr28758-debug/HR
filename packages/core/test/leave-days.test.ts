import { describe, expect, it } from 'vitest';
import { countLeaveDays } from '../src/leave-days.js';

describe('countLeaveDays', () => {
  it('excludes week offs and holidays by default policy', () => {
    // Mon 7 Sep → Sun 13 Sep 2026, Friday off, holiday on Wed 9
    expect(countLeaveDays('2026-09-07', '2026-09-13', [5], new Set(['2026-09-09']), { countWeekOffs: false, countHolidays: false })).toBe(5);
    expect(countLeaveDays('2026-09-07', '2026-09-13', [5], new Set(['2026-09-09']), { countWeekOffs: true, countHolidays: true })).toBe(7);
    expect(countLeaveDays('2026-09-07', '2026-09-07', [], new Set(), { countWeekOffs: false, countHolidays: false }, true)).toBe(0.5);
  });
});
