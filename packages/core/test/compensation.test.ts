import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_STATUS_THRESHOLDS as T, bandPosition, budgetUsage, calculateIncrease, calculatePromotionSalary, checkBudget, classifyBandStatus, detectCompression,
  distributeToTotal, evaluateEligibility, findDuplicateAnnualIncrease, formatMoney, monthsBetween, recommendMeritIncrease, resolveRatingLevel, runScenario,
  salaryStats, selectPromotionRule, validateBand, validateMeritCells, validateThresholds, type EligibilityFacts, type MeritCell, type RatingLevel,
} from '../src/compensation.js';

const G4 = { min: 5000, mid: 6500, max: 8000 };

describe('band position: compa-ratio, range penetration, headroom', () => {
  it('salary exactly at minimum', () => {
    const p = bandPosition(5000, G4);
    expect(p.rangePenetration).toBe(0); expect(p.compaRatio).toBe(76.92); expect(p.remainingToMax).toBe(3000); expect(p.maxPossibleIncreasePct).toBe(60);
    expect(classifyBandStatus(p, T).code).toBe('NORMAL');
  });
  it('salary exactly at midpoint', () => {
    const p = bandPosition(6500, G4);
    expect(p.compaRatio).toBe(100); expect(p.rangePenetration).toBe(50);
  });
  it('salary exactly at maximum', () => {
    const p = bandPosition(8000, G4);
    expect(p.rangePenetration).toBe(100); expect(p.remainingToMax).toBe(0); expect(p.maxPossibleIncreasePct).toBe(0);
    expect(classifyBandStatus(p, T)).toMatchObject({ code: 'AT_MAX', color: 'RED' });
  });
  it('salary above maximum', () => {
    const p = bandPosition(8250, G4);
    expect(p.rangePenetration).toBe(108.33); expect(p.aboveMaxBy).toBe(250); expect(p.remainingToMax).toBe(0); expect(p.maxPossibleIncreasePct).toBe(0);
    expect(classifyBandStatus(p, T)).toMatchObject({ code: 'ABOVE_MAX', color: 'RED' });
  });
  it('salary below minimum is BLUE', () => {
    const p = bandPosition(4800, G4);
    expect(p.belowMinBy).toBe(200); expect(p.rangePenetration).toBeLessThan(0);
    expect(classifyBandStatus(p, T)).toMatchObject({ code: 'BELOW_MIN', color: 'BLUE' });
  });
  it('UX example: 7,800 in 5,000–8,000 → 93.3% penetration, 120% compa, near ceiling', () => {
    const p = bandPosition(7800, { min: 5000, mid: 6500, max: 8000 });
    expect(p.rangePenetration).toBe(93.33); expect(p.compaRatio).toBe(120);
    expect(classifyBandStatus(p, T)).toMatchObject({ code: 'NEAR_CEILING', color: 'ORANGE' });
  });
  it('threshold boundaries are [from, to)', () => {
    expect(classifyBandStatus(bandPosition(7400, G4), T).code).toBe('WATCH'); // 80%
    expect(classifyBandStatus(bandPosition(7399.99, G4), T).code).toBe('NORMAL');
    expect(classifyBandStatus(bandPosition(7700, G4), T).code).toBe('NEAR_CEILING'); // 90%
  });
  it('custom thresholds change classification (not hard-coded)', () => {
    const custom = { ...T, ranges: [{ code: 'OK', label: 'OK', color: 'GREEN' as const, fromPct: 0, toPct: 50 }, { code: 'HIGH', label: 'High', color: 'YELLOW' as const, fromPct: 50, toPct: 100 }] };
    expect(validateThresholds(custom)).toEqual([]);
    expect(classifyBandStatus(bandPosition(6600, G4), custom).code).toBe('HIGH');
  });
  it('no band → NO_BAND; invalid thresholds and bands are reported', () => {
    expect(classifyBandStatus(null, T).code).toBe('NO_BAND');
    expect(validateThresholds({ ...T, ranges: [{ code: 'A', label: 'A', color: 'GREEN', fromPct: 0, toPct: 70 }, { code: 'B', label: 'B', color: 'YELLOW', fromPct: 75, toPct: 100 }] })[0]).toMatch(/contiguous/);
    expect(validateBand({ min: 5000, mid: 4000, max: 8000 })).toContain('minimum must not exceed midpoint');
    expect(validateBand(G4)).toEqual([]);
  });
});

describe('increment calculation and the salary ceiling', () => {
  it('10% on 5,000 → 5,500 inside the band', () => {
    const r = calculateIncrease({ currentSalary: 5000, band: G4, increasePct: 10 });
    expect(r.finalSalary).toBe(5500); expect(r.finalIncreaseAmount).toBe(500); expect(r.outcome).toBe('OK'); expect(r.applicable).toBe(true);
  });
  it('10% on 7,500 exceeds max 8,000 by 250 → never silently applied', () => {
    const r = calculateIncrease({ currentSalary: 7500, band: G4, increasePct: 10, currency: 'AED' });
    expect(r.proposedSalary).toBe(8250); expect(r.exceedsMaxBy).toBe(250);
    expect(r.outcome).toBe('ACTION_REQUIRED'); expect(r.applicable).toBe(false);
    expect(r.alerts[0]!.message).toBe('Proposed salary exceeds the maximum salary band by AED 250.');
  });
  it('cap at maximum', () => {
    const r = calculateIncrease({ currentSalary: 7500, band: G4, increasePct: 10, ceilingAction: 'CAP_AT_MAX' });
    expect(r.finalSalary).toBe(8000); expect(r.finalIncreasePct).toBe(6.67); expect(r.outcome).toBe('CAPPED'); expect(r.applicable).toBe(true);
  });
  it('request exception keeps the proposal but flags it', () => {
    const r = calculateIncrease({ currentSalary: 7800, band: G4, increasePct: 10, ceilingAction: 'REQUEST_EXCEPTION' });
    expect(r.finalSalary).toBe(8580); expect(r.requiresException).toBe(true); expect(r.exceedsMaxBy).toBe(580);
    expect(r.alerts[0]!.message).toBe('Proposed salary exceeds the maximum salary band by AED 580.');
  });
  it('cancel and change-grade leave the salary unchanged and are not applicable as increases', () => {
    expect(calculateIncrease({ currentSalary: 7500, band: G4, increasePct: 10, ceilingAction: 'CANCEL' })).toMatchObject({ finalSalary: 7500, outcome: 'CANCELLED', applicable: false });
    expect(calculateIncrease({ currentSalary: 7500, band: G4, increasePct: 10, ceilingAction: 'CHANGE_GRADE' })).toMatchObject({ finalSalary: 7500, outcome: 'GRADE_CHANGE_REQUIRED', applicable: false });
  });
  it('cap when already above max yields no increase and a warning', () => {
    const r = calculateIncrease({ currentSalary: 8200, band: G4, increasePct: 5, ceilingAction: 'CAP_AT_MAX' });
    expect(r.finalSalary).toBe(8200); expect(r.alerts.map((a) => a.code)).toContain('NO_ROOM_IN_BAND');
  });
  it('disallowed ceiling action throws', () => {
    expect(() => calculateIncrease({ currentSalary: 7500, band: G4, increasePct: 10, ceilingAction: 'REQUEST_EXCEPTION', allowedCeilingActions: ['CAP_AT_MAX'] })).toThrow(/not allowed/);
  });
  it('increase exactly to the maximum is fine', () => {
    expect(calculateIncrease({ currentSalary: 7500, band: G4, increaseAmount: 500 })).toMatchObject({ finalSalary: 8000, outcome: 'OK', exceedsMaxBy: 0 });
  });
  it('max increase % and decreases raise alerts; exactly one input required', () => {
    expect(calculateIncrease({ currentSalary: 5000, band: G4, increasePct: 12, maxIncreasePct: 10 }).exceedsMaxIncreasePct).toBe(true);
    expect(calculateIncrease({ currentSalary: 6000, band: G4, newSalary: 5800 }).alerts.map((a) => a.code)).toContain('SALARY_DECREASE');
    expect(() => calculateIncrease({ currentSalary: 5000, band: G4 })).toThrow();
    expect(calculateIncrease({ currentSalary: 5000, band: null, increasePct: 5 }).alerts[0]!.code).toBe('SALARY_BAND_MISSING');
  });
  it('formats money for alert messages', () => { expect(formatMoney(1250.5)).toBe('AED 1,250.50'); expect(formatMoney(250, 'USD')).toBe('USD 250'); });
});

const LEVELS: RatingLevel[] = [
  { code: 'EXCELLENT', label: 'Excellent', minScore: 4.5, maxScore: 5, sortOrder: 1 }, { code: 'VERY_GOOD', label: 'Very good', minScore: 3.75, maxScore: 4.49, sortOrder: 2 },
  { code: 'GOOD', label: 'Good', minScore: 3, maxScore: 3.74, sortOrder: 3 }, { code: 'AVERAGE', label: 'Average', minScore: 2, maxScore: 2.99, sortOrder: 4 }, { code: 'POOR', label: 'Poor', minScore: 0, maxScore: 1.99, sortOrder: 5 },
];
const CELLS: MeritCell[] = [
  { ratingCode: 'EXCELLENT', minCompa: null, maxCompa: 90, recommendedPct: 10, maxPct: 12 }, { ratingCode: 'EXCELLENT', minCompa: 90, maxCompa: 105, recommendedPct: 7, maxPct: 9 }, { ratingCode: 'EXCELLENT', minCompa: 105, maxCompa: null, recommendedPct: 4, maxPct: 6 },
  { ratingCode: 'GOOD', minCompa: null, maxCompa: null, recommendedPct: 3, maxPct: 4 }, { ratingCode: 'POOR', minCompa: null, maxCompa: null, recommendedPct: 0, maxPct: 0 },
];
describe('merit matrix', () => {
  it('maps scores to configured rating levels', () => {
    expect(resolveRatingLevel(LEVELS, 4.6)!.code).toBe('EXCELLENT'); expect(resolveRatingLevel(LEVELS, 3)!.code).toBe('GOOD'); expect(resolveRatingLevel(LEVELS, null)).toBeNull();
  });
  it('excellent with compa < 90 gets more than excellent with compa > 105', () => {
    expect(recommendMeritIncrease(CELLS, 'EXCELLENT', 85)!.recommendedPct).toBe(10);
    expect(recommendMeritIncrease(CELLS, 'EXCELLENT', 110)!.recommendedPct).toBe(4);
    expect(recommendMeritIncrease(CELLS, 'EXCELLENT', 90)!.recommendedPct).toBe(7); // lower bound inclusive
    expect(recommendMeritIncrease(CELLS, 'GOOD', 130)!.recommendedPct).toBe(3);
    expect(recommendMeritIncrease(CELLS, null, 100)).toBeNull();
  });
  it('validates overlapping ranges and recommended > max', () => {
    expect(validateMeritCells(CELLS)).toEqual([]);
    expect(validateMeritCells([...CELLS, { ratingCode: 'EXCELLENT', minCompa: 100, maxCompa: 110, recommendedPct: 5, maxPct: 4 }]).join()).toMatch(/overlap.*|recommended/);
  });
});

describe('promotion salary', () => {
  const G5 = { min: 6000, mid: 9000, max: 12000 };
  it('rule selection: most specific wins', () => {
    const rules = [{ id: 'default', method: 'PERCENT_INCREASE' as const, value: 10, capAtMax: true }, { id: 'to5', toGradeId: 'g5', method: 'TO_MINIMUM' as const, value: 0, capAtMax: true }, { id: '4to5', fromGradeId: 'g4', toGradeId: 'g5', method: 'GREATER_OF_PERCENT_OR_MINIMUM' as const, value: 15, capAtMax: true }];
    expect(selectPromotionRule(rules, 'g4', 'g5')!.id).toBe('4to5'); expect(selectPromotionRule(rules, 'g3', 'g5')!.id).toBe('to5'); expect(selectPromotionRule(rules, 'g3', 'g6')!.id).toBe('default');
  });
  it('greater of 15% or target minimum', () => {
    expect(calculatePromotionSalary(5000, G5, { method: 'GREATER_OF_PERCENT_OR_MINIMUM', value: 15, capAtMax: true }).recommendedSalary).toBe(6000);
    expect(calculatePromotionSalary(6000, G5, { method: 'GREATER_OF_PERCENT_OR_MINIMUM', value: 15, capAtMax: true }).recommendedSalary).toBe(6900);
  });
  it('percent of midpoint, min/max increase clamps, cap at max', () => {
    expect(calculatePromotionSalary(7000, G5, { method: 'PERCENT_OF_MIDPOINT', value: 90, capAtMax: true }).recommendedSalary).toBe(8100);
    expect(calculatePromotionSalary(7000, G5, { method: 'PERCENT_INCREASE', value: 3, minIncreasePct: 5, capAtMax: true }).recommendedSalary).toBe(7350);
    expect(calculatePromotionSalary(11500, G5, { method: 'PERCENT_INCREASE', value: 10, capAtMax: true }).recommendedSalary).toBe(12000);
  });
  it('promotion into a lower salary than current is flagged', () => {
    const r = calculatePromotionSalary(9000, G5, { method: 'PERCENT_OF_MIDPOINT', value: 80, capAtMax: true });
    expect(r.recommendedSalary).toBe(7200); expect(r.alerts.map((a) => a.code)).toContain('PROMOTION_SALARY_DECREASE');
  });
  it('below minimum / above maximum alerts', () => {
    expect(calculatePromotionSalary(4000, G5, { method: 'PERCENT_INCREASE', value: 10, capAtMax: true }).alerts.map((a) => a.code)).toContain('PROMOTION_BELOW_MIN');
    expect(calculatePromotionSalary(11500, G5, { method: 'PERCENT_INCREASE', value: 10, capAtMax: false }).alerts.map((a) => a.code)).toContain('PROMOTION_ABOVE_MAX');
  });
});

const facts = (o: Partial<EligibilityFacts> = {}): EligibilityFacts => ({ joiningDate: '2024-01-15', lastIncreaseDate: '2026-01-01', status: 'ACTIVE', employmentType: 'FULL_TIME', ratingScore: 4, ratingCode: 'VERY_GOOD', lastDisciplinaryDate: null, onProbation: false, departmentId: 'd1', gradeId: 'g1', siteId: 's1', designationId: 't1', hasSalary: true, ...o });
describe('eligibility rules', () => {
  const rules = { minServiceMonths: 12, minMonthsSinceLastIncrease: 11, employmentStatuses: ['ACTIVE', 'CONFIRMED'], minRatingScore: 3, excludeDisciplinaryWithinMonths: 12, excludeOnProbation: true };
  it('eligible employee', () => { expect(evaluateEligibility(rules, facts(), '2027-01-01')).toEqual({ eligible: true, reasons: [] }); });
  it('collects every failing reason', () => {
    const r = evaluateEligibility({ ...rules, departmentIds: ['d2'] }, facts({ joiningDate: '2026-06-01', lastIncreaseDate: '2026-06-01', ratingScore: 2, lastDisciplinaryDate: '2026-09-01', onProbation: true, status: 'RESIGNED' }), '2027-01-01');
    expect(r.eligible).toBe(false); expect(r.reasons.length).toBeGreaterThanOrEqual(6);
  });
  it('missing rating with a minimum score is ineligible unless requireRating=false', () => {
    expect(evaluateEligibility(rules, facts({ ratingScore: null }), '2027-01-01').reasons).toContain('No finalised performance rating');
    expect(evaluateEligibility({ ...rules, requireRating: false }, facts({ ratingScore: null }), '2027-01-01').eligible).toBe(true);
  });
  it('months between', () => { expect(monthsBetween('2026-01-31', '2026-02-28')).toBe(0); expect(monthsBetween('2025-01-01', '2026-01-01')).toBe(12); });
});

describe('budgets, scenarios, compression, duplicates, salary lines', () => {
  it('budget utilisation (example from the brief)', () => {
    expect(budgetUsage(5_000_000, 4_250_000, 3_000_000)).toMatchObject({ remaining: 750_000, utilizationPct: 85, approvedUtilizationPct: 60, exceeded: false });
    expect(checkBudget(100_000, 95_000, 6_000)).toEqual({ ok: false, exceededBy: 1000 });
    expect(checkBudget(100_000, 94_000, 6_000).ok).toBe(true);
  });
  const emps = [
    { employeeId: 'a', currentSalary: 5000, currentGross: 7000, band: G4, ratingCode: 'EXCELLENT', eligible: true },
    { employeeId: 'b', currentSalary: 7500, currentGross: 9500, band: G4, ratingCode: 'GOOD', eligible: true },
    { employeeId: 'c', currentSalary: 6000, currentGross: 8000, band: G4, ratingCode: 'POOR', eligible: false },
  ];
  it('flat 10% scenario counts above-max and caps', () => {
    const r = runScenario({ method: 'FLAT_PERCENT', flatPct: 10, ceilingAction: 'CAP_AT_MAX' }, emps);
    expect(r.summary).toMatchObject({ employees: 3, included: 2, monthlyIncrease: 1000, annualIncrease: 12000, aboveMax: 1, capped: 1, currentPayroll: 24500, proposedPayroll: 25500 });
    const ex = runScenario({ method: 'FLAT_PERCENT', flatPct: 10, ceilingAction: 'REQUEST_EXCEPTION' }, emps);
    expect(ex.summary.requiringException).toBe(1); expect(ex.summary.monthlyIncrease).toBe(1250);
  });
  it('merit scenario uses the matrix', () => {
    const r = runScenario({ method: 'MERIT_MATRIX', meritCells: CELLS, ceilingAction: 'CAP_AT_MAX' }, emps);
    expect(r.items.find((i) => i.employeeId === 'a')!.increasePct).toBe(10); // compa 76.9 → 10%
    expect(r.items.find((i) => i.employeeId === 'b')!.increasePct).toBe(3);
  });
  it('budget-limited scenario scales increases to fit', () => {
    const r = runScenario({ method: 'BUDGET_LIMITED', baseMethod: 'FLAT_PERCENT', flatPct: 10, budgetLimit: 6000, ceilingAction: 'CAP_AT_MAX' }, emps);
    expect(r.summary.annualIncrease).toBeLessThanOrEqual(6000); expect(r.summary.scaleFactor).toBeLessThan(1); expect(r.summary.budgetRemaining).toBeGreaterThanOrEqual(0);
  });
  it('promotion + increment scenario starts from the promoted salary', () => {
    const r = runScenario({ method: 'PROMOTION_PLUS_INCREMENT', baseMethod: 'FLAT_PERCENT', flatPct: 5, ceilingAction: 'CAP_AT_MAX' }, [{ ...emps[0]!, promotedSalary: 6000, promotedBand: { min: 6000, mid: 9000, max: 12000 } }]);
    expect(r.items[0]).toMatchObject({ promoted: true, finalSalary: 6300, increase: 1300 });
  });
  it('detects compression and inversion between levels', () => {
    const f = detectCompression([
      { ruleId: 'r1', ruleName: 'Engineering ladder', lowerKey: 'JE', lowerLabel: 'Junior Engineer', upperKey: 'E', upperLabel: 'Engineer', minDifferenceAmount: 500, minDifferencePct: 5, compare: 'AVERAGE' },
      { ruleId: 'r1', ruleName: 'Engineering ladder', lowerKey: 'E', lowerLabel: 'Engineer', upperKey: 'SE', upperLabel: 'Senior Engineer', minDifferenceAmount: 500, minDifferencePct: 5, compare: 'AVERAGE' },
      { ruleId: 'r2', ruleName: 'Wide', lowerKey: 'JE', lowerLabel: 'Junior Engineer', upperKey: 'M', upperLabel: 'Manager', minDifferenceAmount: 500, minDifferencePct: 5, compare: 'AVERAGE' },
    ], new Map([['JE', [7500]], ['E', [7700]], ['SE', [7900]], ['M', [7000]]]));
    expect(f).toHaveLength(3);
    expect(f[0]!.message).toMatch(/^Potential Salary Compression/); expect(f[0]!.reasons).toEqual(['AMOUNT', 'PERCENT']);
    expect(f[2]!.reasons).toContain('INVERSION');
  });
  it('duplicate annual increase protection ignores rejected/cancelled', () => {
    expect(findDuplicateAnnualIncrease([{ changeType: 'ANNUAL_INCREMENT', effectiveYear: 2027, status: 'REJECTED' }], 2027)).toBeNull();
    expect(findDuplicateAnnualIncrease([{ changeType: 'ANNUAL_INCREMENT', effectiveYear: 2027, status: 'COMPLETED' }], 2027)).not.toBeNull();
    expect(findDuplicateAnnualIncrease([{ changeType: 'MERIT_INCREASE', effectiveYear: 2027, status: 'COMPLETED' }], 2027)).toBeNull();
  });
  it('distributes a gross target exactly across fixed lines', () => {
    const out = distributeToTotal([{ componentCode: 'BASIC', amount: 4000, scalable: true }, { componentCode: 'HOUSING', amount: 1500, scalable: true }, { componentCode: 'TRANSPORT', amount: 333.33, scalable: true }, { componentCode: 'OT', amount: 10, scalable: false }], 6416.66);
    expect(Math.round(out.filter((l) => l.scalable).reduce((s, l) => s + l.amount, 0) * 100) / 100).toBe(6416.66);
    expect(out.find((l) => l.componentCode === 'OT')!.amount).toBe(10);
  });
  it('salary stats', () => { expect(salaryStats([1000, 3000, 2000, 4000])).toMatchObject({ average: 2500, median: 2500, min: 1000, max: 4000, total: 10000 }); });
});
