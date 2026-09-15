import { describe, expect, it } from 'vitest';
import { EXAMPLE_SETTLEMENT_POLICY, calculateSettlement, serviceLength } from '../src/settlement.js';

const P = EXAMPLE_SETTLEMENT_POLICY;

describe('service length', () => {
  it('splits calendar service into years / months / days inclusive of the last day', () => {
    const s = serviceLength('2020-01-01', '2024-12-31');
    expect(s.years).toBe(5); expect(s.months).toBe(0); expect(s.days).toBe(0);
    expect(s.totalDays).toBe(1827);
  });
  it('excludes unpaid leave from total days', () => {
    expect(serviceLength('2024-01-01', '2024-12-31', 31).totalDays).toBe(366 - 31);
  });
});

describe('final settlement (configuration-driven)', () => {
  it('walks progressive gratuity bands pro-rata and marks DRAFT until signed off', () => {
    // 7 years exactly on basic 3000: 5y × 21d + 2y × 30d = 165 days × 100/day = 16,500
    const r = calculateSettlement(P, { joiningDate: '2019-01-01', lastWorkingDate: '2025-12-31', basicSalary: 3000, grossSalary: 5000 });
    const g = r.lines.find((l) => l.code === 'GRATUITY')!;
    expect(r.status).toBe('DRAFT');
    expect(r.dailyRate.gratuity).toBe(100);
    expect(r.service.completedYears).toBe(7);
    expect(g.amount).toBeGreaterThan(16400); expect(g.amount).toBeLessThan(16600); // 2557 days / 365 ≈ 7.005 years
    expect(r.warnings[0]).toMatch(/not been signed off/);
  });
  it('pays nothing below the minimum service and applies the cap', () => {
    const short = calculateSettlement(P, { joiningDate: '2025-06-01', lastWorkingDate: '2025-12-31', basicSalary: 3000, grossSalary: 4000 });
    expect(short.lines.find((l) => l.code === 'GRATUITY')!.amount).toBe(0);
    const long = calculateSettlement({ ...P, gratuity: { ...P.gratuity, capMonths: 2 } }, { joiningDate: '2000-01-01', lastWorkingDate: '2025-12-31', basicSalary: 3000, grossSalary: 4000 });
    expect(long.lines.find((l) => l.code === 'GRATUITY')!.amount).toBe(6000);
    expect(long.trace.gratuityCapApplied).toBeTruthy();
  });
  it('adds encashment, bonuses, loans, deductions and notice shortfall into the net', () => {
    const r = calculateSettlement({ ...P, signedOff: true }, { joiningDate: '2023-01-01', lastWorkingDate: '2025-12-31', basicSalary: 3000, grossSalary: 4500, leaveBalanceDays: 10, pendingBonuses: 500, outstandingLoans: 1200, pendingDeductions: 250, noticeShortfallDays: 5, finalPeriodNet: 2100 });
    expect(r.status).toBe('SIGNED_OFF_POLICY');
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l.amount]));
    expect(by.LEAVE_ENCASH).toBe(1000);
    expect(by.BONUS).toBe(500); expect(by.LOAN).toBe(1200); expect(by.DEDUCTIONS).toBe(250); expect(by.NOTICE).toBe(500); expect(by.FINAL_SALARY).toBe(2100);
    expect(r.net).toBe(Math.round((r.totalEarnings - r.totalDeductions) * 100) / 100);
    expect(r.totalDeductions).toBe(1950);
  });
  it('uses gross basis and no pro-rata when configured', () => {
    const p = { ...P, gratuity: { ...P.gratuity, basis: 'GROSS' as const, proRata: false } };
    const r = calculateSettlement(p, { joiningDate: '2022-01-01', lastWorkingDate: '2025-06-30', basicSalary: 3000, grossSalary: 6000 });
    // 3 completed years × 21 days × (6000/30 = 200) = 12,600
    expect(r.lines.find((l) => l.code === 'GRATUITY')!.amount).toBe(12600);
  });
});
