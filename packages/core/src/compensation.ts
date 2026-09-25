/**
 * Compensation engine — pure, configuration-driven salary maths (no I/O).
 *
 * Nothing here encodes company policy: bands, status thresholds, merit matrices, promotion rules, eligibility rules,
 * compression rules and budgets are all passed in. The API loads them from the database/settings and persists results.
 *
 * Conventions: money is rounded to 2 dp, percentages to 2 dp. Percent values are expressed as 0–100 (not 0–1).
 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const EPS = 0.005; // half a cent: money comparisons

export function formatMoney(amount: number, currency = 'AED'): string {
  const v = round2(amount);
  return `${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// ───────────────────────────── Salary band position ─────────────────────────────

export interface SalaryBand { min: number; mid: number; max: number; currency?: string }

export interface BandPosition {
  salary: number; min: number; mid: number; max: number;
  /** salary / midpoint × 100 */
  compaRatio: number | null;
  /** (salary − min) / (max − min) × 100 — may be < 0 (below min) or > 100 (above max) */
  rangePenetration: number | null;
  /** max − salary, never negative */
  remainingToMax: number;
  /** (max − salary) / salary × 100, never negative; null when salary is 0 */
  maxPossibleIncreasePct: number | null;
  aboveMaxBy: number;
  belowMinBy: number;
}

export function validateBand(b: SalaryBand): string[] {
  const errors: string[] = [];
  for (const k of ['min', 'mid', 'max'] as const) if (!Number.isFinite(b[k]) || b[k] < 0) errors.push(`${k} must be a non-negative number`);
  if (b.min > b.mid) errors.push('minimum must not exceed midpoint');
  if (b.mid > b.max) errors.push('midpoint must not exceed maximum');
  if (b.max <= 0) errors.push('maximum must be greater than zero');
  return errors;
}

export function bandPosition(salary: number, band: SalaryBand): BandPosition {
  const { min, mid, max } = band;
  const spread = max - min;
  const rangePenetration = spread > 0 ? round2(((salary - min) / spread) * 100) : salary >= max - EPS ? 100 : 0;
  return {
    salary: round2(salary), min, mid, max,
    compaRatio: mid > 0 ? round2((salary / mid) * 100) : null,
    rangePenetration,
    remainingToMax: round2(Math.max(0, max - salary)),
    maxPossibleIncreasePct: salary > 0 ? round2(Math.max(0, ((max - salary) / salary) * 100)) : null,
    aboveMaxBy: round2(Math.max(0, salary - max)),
    belowMinBy: round2(Math.max(0, min - salary)),
  };
}

// ───────────────────────────── Status classification (configurable thresholds) ─────────────────────────────

export type StatusColor = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'BLUE' | 'GREY';
export interface StatusRange { code: string; label: string; color: StatusColor; fromPct: number; toPct: number }
export interface StatusThresholds {
  /** Ranges of range-penetration inside the band [fromPct, toPct). Must cover 0 → 100 contiguously. */
  ranges: StatusRange[];
  belowMin: { code: string; label: string; color: StatusColor };
  atMax: { code: string; label: string; color: StatusColor };
  aboveMax: { code: string; label: string; color: StatusColor };
  noBand: { code: string; label: string; color: StatusColor };
}
export interface BandStatus { code: string; label: string; color: StatusColor }

/** Example thresholds only — the API reads the company's values from settings (`compensation.policy`). */
export const EXAMPLE_STATUS_THRESHOLDS: StatusThresholds = {
  ranges: [
    { code: 'NORMAL', label: 'Normal', color: 'GREEN', fromPct: 0, toPct: 80 },
    { code: 'WATCH', label: 'Watch', color: 'YELLOW', fromPct: 80, toPct: 90 },
    { code: 'NEAR_CEILING', label: 'Near ceiling', color: 'ORANGE', fromPct: 90, toPct: 100 },
  ],
  belowMin: { code: 'BELOW_MIN', label: 'Below minimum', color: 'BLUE' },
  atMax: { code: 'AT_MAX', label: 'At maximum', color: 'RED' },
  aboveMax: { code: 'ABOVE_MAX', label: 'Above maximum', color: 'RED' },
  noBand: { code: 'NO_BAND', label: 'No salary band', color: 'GREY' },
};

export function validateThresholds(t: StatusThresholds): string[] {
  const errors: string[] = [];
  const r = [...t.ranges].sort((a, b) => a.fromPct - b.fromPct);
  if (!r.length) errors.push('at least one range is required');
  if (r.length && r[0]!.fromPct !== 0) errors.push('ranges must start at 0%');
  if (r.length && r[r.length - 1]!.toPct !== 100) errors.push('ranges must end at 100%');
  for (let i = 0; i < r.length; i++) {
    if (r[i]!.toPct <= r[i]!.fromPct) errors.push(`range ${r[i]!.code}: toPct must be greater than fromPct`);
    if (i > 0 && r[i]!.fromPct !== r[i - 1]!.toPct) errors.push(`ranges must be contiguous (gap/overlap at ${r[i]!.fromPct}%)`);
  }
  const codes = new Set<string>();
  for (const c of [...r.map((x) => x.code), t.belowMin.code, t.atMax.code, t.aboveMax.code, t.noBand.code]) { if (codes.has(c)) errors.push(`duplicate status code ${c}`); codes.add(c); }
  return errors;
}

export function classifyBandStatus(pos: BandPosition | null, t: StatusThresholds): BandStatus {
  if (!pos) return t.noBand;
  if (pos.salary < pos.min - EPS) return t.belowMin;
  if (pos.salary > pos.max + EPS) return t.aboveMax;
  if (Math.abs(pos.salary - pos.max) <= EPS) return t.atMax;
  // classify on the unrounded penetration so 79.999% is not promoted into the 80% bucket by display rounding
  const p = pos.max > pos.min ? ((pos.salary - pos.min) / (pos.max - pos.min)) * 100 : pos.rangePenetration ?? 0;
  const ranges = [...t.ranges].sort((a, b) => a.fromPct - b.fromPct);
  return ranges.find((r) => p >= r.fromPct && p < r.toPct) ?? ranges[ranges.length - 1] ?? t.noBand;
}

// ───────────────────────────── Increase calculation & ceiling handling ─────────────────────────────

export type CeilingAction = 'CAP_AT_MAX' | 'REQUEST_EXCEPTION' | 'CANCEL' | 'CHANGE_GRADE';
export const CEILING_ACTIONS: CeilingAction[] = ['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE'];
export type IncreaseOutcome = 'OK' | 'CAPPED' | 'EXCEPTION_REQUIRED' | 'CANCELLED' | 'GRADE_CHANGE_REQUIRED' | 'ACTION_REQUIRED';
export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
export interface CompAlert { code: string; severity: AlertSeverity; message: string; amount?: number }

export interface IncreaseInput {
  currentSalary: number;
  band: SalaryBand | null;
  currency?: string;
  /** exactly one of increasePct / increaseAmount / newSalary */
  increasePct?: number;
  increaseAmount?: number;
  newSalary?: number;
  /** chosen resolution when the proposal exceeds the band maximum */
  ceilingAction?: CeilingAction | null;
  /** actions the company allows (policy). Defaults to all. */
  allowedCeilingActions?: CeilingAction[];
  /** cap on the increase % (e.g. a review's maximum). Exceeding it raises an alert that needs an authorised override. */
  maxIncreasePct?: number | null;
}
export interface IncreaseResult {
  currentSalary: number;
  proposedSalary: number; proposedIncreaseAmount: number; proposedIncreasePct: number;
  finalSalary: number; finalIncreaseAmount: number; finalIncreasePct: number;
  exceedsMaxBy: number; belowMinBy: number;
  outcome: IncreaseOutcome;
  ceilingAction: CeilingAction | null;
  /** true when the result may be applied as-is (subject to approval). False while a decision is outstanding. */
  applicable: boolean;
  requiresException: boolean;
  exceedsMaxIncreasePct: boolean;
  before: BandPosition | null; after: BandPosition | null;
  alerts: CompAlert[];
}

const pctOf = (from: number, to: number) => (from > 0 ? round2(((to - from) / from) * 100) : 0);

export function calculateIncrease(input: IncreaseInput): IncreaseResult {
  const cur = round2(input.currentSalary);
  const cc = input.currency ?? input.band?.currency ?? 'AED';
  const given = [input.increasePct, input.increaseAmount, input.newSalary].filter((v) => v !== undefined && v !== null).length;
  if (given !== 1) throw new Error('Provide exactly one of increasePct, increaseAmount or newSalary');
  if (cur < 0) throw new Error('currentSalary must be >= 0');
  let proposed: number;
  if (input.increasePct !== undefined && input.increasePct !== null) proposed = round2(cur * (1 + input.increasePct / 100));
  else if (input.increaseAmount !== undefined && input.increaseAmount !== null) proposed = round2(cur + input.increaseAmount);
  else proposed = round2(input.newSalary!);
  if (proposed < 0) throw new Error('Resulting salary cannot be negative');

  const alerts: CompAlert[] = [];
  const band = input.band;
  const exceedsMaxBy = band ? round2(Math.max(0, proposed - band.max)) : 0;
  let final = proposed;
  let outcome: IncreaseOutcome = 'OK';
  let action: CeilingAction | null = null;
  let requiresException = false;

  if (!band) alerts.push({ code: 'SALARY_BAND_MISSING', severity: 'WARNING', message: 'No active salary band for this grade — band compliance cannot be verified.' });

  if (band && exceedsMaxBy > 0 && proposed > cur) {
    const allowed = input.allowedCeilingActions ?? CEILING_ACTIONS;
    alerts.push({ code: 'EXCEEDS_BAND_MAX', severity: 'CRITICAL', message: `Proposed salary exceeds the maximum salary band by ${formatMoney(exceedsMaxBy, cc)}.`, amount: exceedsMaxBy });
    action = input.ceilingAction ?? null;
    if (action && !allowed.includes(action)) throw new Error(`Ceiling action ${action} is not allowed by policy`);
    switch (action) {
      case 'CAP_AT_MAX':
        final = round2(Math.max(cur, band.max)); outcome = 'CAPPED';
        if (cur >= band.max - EPS) alerts.push({ code: 'NO_ROOM_IN_BAND', severity: 'WARNING', message: `Current salary is already at or above the band maximum (${formatMoney(band.max, cc)}); capping leaves no increase.` });
        break;
      case 'REQUEST_EXCEPTION': outcome = 'EXCEPTION_REQUIRED'; requiresException = true; break;
      case 'CANCEL': final = cur; outcome = 'CANCELLED'; break;
      case 'CHANGE_GRADE': final = cur; outcome = 'GRADE_CHANGE_REQUIRED'; alerts.push({ code: 'GRADE_CHANGE_SUGGESTED', severity: 'INFO', message: 'Raise a promotion / grade change instead of an increase within this band.' }); break;
      default: outcome = 'ACTION_REQUIRED';
    }
  }
  const belowMinBy = band ? round2(Math.max(0, band.min - final)) : 0;
  if (band && belowMinBy > 0) alerts.push({ code: 'BELOW_BAND_MIN', severity: 'WARNING', message: `Salary remains below the band minimum by ${formatMoney(belowMinBy, cc)}.`, amount: belowMinBy });
  const finalPct = pctOf(cur, final);
  const exceedsMaxIncreasePct = input.maxIncreasePct !== undefined && input.maxIncreasePct !== null && finalPct > input.maxIncreasePct + 1e-9;
  if (exceedsMaxIncreasePct) alerts.push({ code: 'EXCEEDS_MAX_INCREASE_PCT', severity: 'CRITICAL', message: `Increase of ${finalPct}% exceeds the maximum allowed ${input.maxIncreasePct}%.` });
  if (final < cur - EPS) alerts.push({ code: 'SALARY_DECREASE', severity: 'WARNING', message: `New salary is lower than the current salary by ${formatMoney(cur - final, cc)}.`, amount: round2(cur - final) });

  return {
    currentSalary: cur,
    proposedSalary: proposed, proposedIncreaseAmount: round2(proposed - cur), proposedIncreasePct: pctOf(cur, proposed),
    finalSalary: final, finalIncreaseAmount: round2(final - cur), finalIncreasePct: finalPct,
    exceedsMaxBy, belowMinBy, outcome, ceilingAction: action,
    applicable: outcome === 'OK' || outcome === 'CAPPED' || outcome === 'EXCEPTION_REQUIRED',
    requiresException, exceedsMaxIncreasePct,
    before: band ? bandPosition(cur, band) : null, after: band ? bandPosition(final, band) : null,
    alerts,
  };
}

// ───────────────────────────── Performance rating levels & merit matrix ─────────────────────────────

export interface RatingLevel { code: string; label: string; minScore: number; maxScore: number; sortOrder?: number }
/** Map a numeric review score (e.g. 1–5) to a configured rating level; bounds inclusive, first match by sortOrder. */
export function resolveRatingLevel(levels: RatingLevel[], score: number | null | undefined): RatingLevel | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return [...levels].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).find((l) => score >= l.minScore && score <= l.maxScore) ?? null;
}

export interface MeritCell { ratingCode: string; minCompa: number | null; maxCompa: number | null; recommendedPct: number; maxPct: number }
export function validateMeritCells(cells: MeritCell[]): string[] {
  const errors: string[] = [];
  for (const c of cells) {
    if (c.minCompa !== null && c.maxCompa !== null && c.maxCompa <= c.minCompa) errors.push(`${c.ratingCode}: maxCompa must be greater than minCompa`);
    if (c.recommendedPct < 0 || c.maxPct < 0) errors.push(`${c.ratingCode}: percentages must be >= 0`);
    if (c.recommendedPct > c.maxPct) errors.push(`${c.ratingCode}: recommended % must not exceed maximum %`);
  }
  const byRating = new Map<string, MeritCell[]>();
  for (const c of cells) byRating.set(c.ratingCode, [...(byRating.get(c.ratingCode) ?? []), c]);
  for (const [code, list] of byRating) {
    const s = [...list].sort((a, b) => (a.minCompa ?? -Infinity) - (b.minCompa ?? -Infinity));
    for (let i = 1; i < s.length; i++) if ((s[i - 1]!.maxCompa ?? Infinity) > (s[i]!.minCompa ?? -Infinity)) errors.push(`${code}: compa-ratio ranges overlap`);
  }
  return errors;
}
/** Compa-ratio range is [minCompa, maxCompa); null bounds are open. */
export function recommendMeritIncrease(cells: MeritCell[], ratingCode: string | null, compaRatio: number | null): MeritCell | null {
  if (!ratingCode) return null;
  return cells.find((c) => c.ratingCode === ratingCode && (compaRatio === null ? c.minCompa === null : (c.minCompa === null || compaRatio >= c.minCompa) && (c.maxCompa === null || compaRatio < c.maxCompa))) ?? null;
}

// ───────────────────────────── Promotion salary rules ─────────────────────────────

export type PromotionMethod = 'PERCENT_INCREASE' | 'TO_MINIMUM' | 'TO_MIDPOINT' | 'PERCENT_OF_MIDPOINT' | 'FIXED_AMOUNT' | 'GREATER_OF_PERCENT_OR_MINIMUM';
export interface PromotionRule {
  id?: string; fromGradeId?: string | null; toGradeId?: string | null; priority?: number;
  method: PromotionMethod; value: number; minIncreasePct?: number | null; maxIncreasePct?: number | null; capAtMax: boolean;
}
/** Most specific rule wins: from+to > to only > from only > default; ties by priority (lower first). */
export function selectPromotionRule(rules: PromotionRule[], fromGradeId: string | null, toGradeId: string | null): PromotionRule | null {
  const score = (r: PromotionRule) => (r.fromGradeId ? (r.fromGradeId === fromGradeId ? 1 : -99) : 0) + (r.toGradeId ? (r.toGradeId === toGradeId ? 2 : -99) : 0);
  return rules.map((r) => ({ r, s: score(r) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || (a.r.priority ?? 100) - (b.r.priority ?? 100))[0]?.r ?? null;
}
export interface PromotionSalaryResult { recommendedSalary: number; increaseAmount: number; increasePct: number; explanation: string; alerts: CompAlert[]; position: BandPosition | null }
export function calculatePromotionSalary(currentSalary: number, targetBand: SalaryBand | null, rule: PromotionRule | null, currency = 'AED'): PromotionSalaryResult {
  const cur = round2(currentSalary);
  const alerts: CompAlert[] = [];
  let rec = cur; let explanation = 'No promotion rule configured — salary unchanged; enter the new salary manually.';
  if (rule) {
    const need = (what: string) => { if (!targetBand) throw new Error(`Promotion rule ${rule.method} needs the target grade's ${what}`); return targetBand; };
    switch (rule.method) {
      case 'PERCENT_INCREASE': rec = cur * (1 + rule.value / 100); explanation = `${rule.value}% on current salary`; break;
      case 'TO_MINIMUM': rec = Math.max(cur, need('minimum').min); explanation = 'Raised to the target grade minimum (never below current)'; break;
      case 'TO_MIDPOINT': rec = Math.max(cur, need('midpoint').mid); explanation = 'Raised to the target grade midpoint (never below current)'; break;
      case 'PERCENT_OF_MIDPOINT': rec = need('midpoint').mid * (rule.value / 100); explanation = `${rule.value}% of the target grade midpoint`; break;
      case 'FIXED_AMOUNT': rec = cur + rule.value; explanation = `Fixed increase of ${formatMoney(rule.value, currency)}`; break;
      case 'GREATER_OF_PERCENT_OR_MINIMUM': rec = Math.max(cur * (1 + rule.value / 100), need('minimum').min); explanation = `Greater of ${rule.value}% increase or the target grade minimum`; break;
    }
    if (rule.minIncreasePct !== null && rule.minIncreasePct !== undefined && cur > 0 && rec < cur * (1 + rule.minIncreasePct / 100)) { rec = cur * (1 + rule.minIncreasePct / 100); explanation += `; floored at +${rule.minIncreasePct}%`; }
    if (rule.maxIncreasePct !== null && rule.maxIncreasePct !== undefined && cur > 0 && rec > cur * (1 + rule.maxIncreasePct / 100)) { rec = cur * (1 + rule.maxIncreasePct / 100); explanation += `; capped at +${rule.maxIncreasePct}%`; }
    if (rule.capAtMax && targetBand && rec > targetBand.max) { rec = Math.max(cur, targetBand.max); explanation += '; capped at the target grade maximum'; }
  }
  rec = round2(rec);
  if (targetBand) {
    if (rec < targetBand.min - EPS) alerts.push({ code: 'PROMOTION_BELOW_MIN', severity: 'WARNING', message: `Promotion salary is below the new grade minimum by ${formatMoney(targetBand.min - rec, currency)}.`, amount: round2(targetBand.min - rec) });
    if (rec > targetBand.max + EPS) alerts.push({ code: 'PROMOTION_ABOVE_MAX', severity: 'CRITICAL', message: `Promotion salary exceeds the new grade maximum by ${formatMoney(rec - targetBand.max, currency)}.`, amount: round2(rec - targetBand.max) });
  } else alerts.push({ code: 'SALARY_BAND_MISSING', severity: 'WARNING', message: 'The target grade has no active salary band.' });
  if (rec < cur - EPS) alerts.push({ code: 'PROMOTION_SALARY_DECREASE', severity: 'CRITICAL', message: `Promotion salary is lower than the current salary by ${formatMoney(cur - rec, currency)}.`, amount: round2(cur - rec) });
  return { recommendedSalary: rec, increaseAmount: round2(rec - cur), increasePct: pctOf(cur, rec), explanation, alerts, position: targetBand ? bandPosition(rec, targetBand) : null };
}

/** Validate a manually chosen promotion salary against the target band. */
export function promotionSalaryAlerts(currentSalary: number, newSalary: number, targetBand: SalaryBand | null, currency = 'AED'): CompAlert[] {
  return calculatePromotionSalary(currentSalary, targetBand, { method: 'FIXED_AMOUNT', value: round2(newSalary - currentSalary), capAtMax: false }, currency).alerts;
}

// ───────────────────────────── Eligibility ─────────────────────────────

export interface EligibilityRules {
  minServiceMonths?: number | null;
  minMonthsSinceLastIncrease?: number | null;
  lastIncreaseBefore?: string | null;
  employmentStatuses?: string[] | null;
  employmentTypes?: string[] | null;
  minRatingScore?: number | null;
  ratingCodes?: string[] | null;
  requireRating?: boolean | null;
  excludeDisciplinaryWithinMonths?: number | null;
  excludeOnProbation?: boolean | null;
  departmentIds?: string[] | null; gradeIds?: string[] | null; siteIds?: string[] | null; designationIds?: string[] | null;
}
export interface EligibilityFacts {
  joiningDate: string | null; lastIncreaseDate: string | null; status: string; employmentType: string;
  ratingScore: number | null; ratingCode: string | null; lastDisciplinaryDate: string | null; onProbation: boolean;
  departmentId: string | null; gradeId: string | null; siteId: string | null; designationId: string | null;
  hasSalary: boolean;
}

/** Whole months between two ISO dates (a → b). */
export function monthsBetween(a: string, b: string): number {
  const [ay, am, ad] = a.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.slice(0, 10).split('-').map(Number) as [number, number, number];
  let m = (by - ay) * 12 + (bm - am);
  if (bd < ad) m -= 1;
  return m;
}

export function evaluateEligibility(rules: EligibilityRules, f: EligibilityFacts, asOf: string): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const inList = (list: string[] | null | undefined, v: string | null, label: string) => { if (list?.length && (!v || !list.includes(v))) reasons.push(`${label} not in scope`); };
  if (!f.hasSalary) reasons.push('No salary structure');
  if (rules.employmentStatuses?.length && !rules.employmentStatuses.includes(f.status)) reasons.push(`Employment status ${f.status} not eligible`);
  if (rules.employmentTypes?.length && !rules.employmentTypes.includes(f.employmentType)) reasons.push(`Employment type ${f.employmentType} not eligible`);
  if (rules.minServiceMonths) {
    if (!f.joiningDate) reasons.push('Joining date missing');
    else if (monthsBetween(f.joiningDate, asOf) < rules.minServiceMonths) reasons.push(`Service below ${rules.minServiceMonths} months`);
  }
  if (rules.minMonthsSinceLastIncrease && f.lastIncreaseDate && monthsBetween(f.lastIncreaseDate, asOf) < rules.minMonthsSinceLastIncrease) reasons.push(`Last increase less than ${rules.minMonthsSinceLastIncrease} months ago (${f.lastIncreaseDate})`);
  if (rules.lastIncreaseBefore && f.lastIncreaseDate && f.lastIncreaseDate >= rules.lastIncreaseBefore) reasons.push(`Last increase on/after ${rules.lastIncreaseBefore}`);
  const hasMin = rules.minRatingScore !== null && rules.minRatingScore !== undefined;
  // A minimum score implies a rating is required unless requireRating is explicitly false.
  if (f.ratingScore === null && (rules.requireRating || (hasMin && rules.requireRating !== false))) reasons.push('No finalised performance rating');
  if (hasMin && f.ratingScore !== null && f.ratingScore < rules.minRatingScore!) reasons.push(`Performance rating ${f.ratingScore} below ${rules.minRatingScore}`);
  if (rules.ratingCodes?.length && (!f.ratingCode || !rules.ratingCodes.includes(f.ratingCode))) reasons.push(`Rating ${f.ratingCode ?? 'none'} not eligible`);
  if (rules.excludeDisciplinaryWithinMonths && f.lastDisciplinaryDate && monthsBetween(f.lastDisciplinaryDate, asOf) < rules.excludeDisciplinaryWithinMonths) reasons.push(`Disciplinary case within ${rules.excludeDisciplinaryWithinMonths} months`);
  if (rules.excludeOnProbation && f.onProbation) reasons.push('On probation');
  inList(rules.departmentIds, f.departmentId, 'Department'); inList(rules.gradeIds, f.gradeId, 'Grade'); inList(rules.siteIds, f.siteId, 'Site'); inList(rules.designationIds, f.designationId, 'Job title');
  return { eligible: reasons.length === 0, reasons };
}

// ───────────────────────────── Salary lines (band basis GROSS) ─────────────────────────────

export interface CompSalaryLine { componentCode: string; amount: number; scalable: boolean }
/**
 * Scale the scalable (fixed earning) lines so their sum equals `targetTotal`; the rounding remainder is absorbed by the
 * anchor line (BASIC) so the total is exact to the cent — the band maximum is never exceeded through rounding.
 */
export function distributeToTotal(lines: CompSalaryLine[], targetTotal: number, anchor = 'BASIC'): CompSalaryLine[] {
  const scal = lines.filter((l) => l.scalable);
  const cur = scal.reduce((s, l) => s + l.amount, 0);
  if (cur <= 0) throw new Error('No scalable salary lines to distribute over');
  const f = targetTotal / cur;
  const out = lines.map((l) => ({ ...l, amount: l.scalable ? round2(l.amount * f) : l.amount }));
  const diff = round2(targetTotal - out.filter((l) => l.scalable).reduce((s, l) => s + l.amount, 0));
  const a = out.find((l) => l.componentCode === anchor && l.scalable) ?? out.find((l) => l.scalable)!;
  a.amount = round2(a.amount + diff);
  return out;
}

// ───────────────────────────── Budgets ─────────────────────────────

export interface BudgetUsage { allocated: number; proposedCost: number; approvedCost: number; remaining: number; remainingAfterApproved: number; utilizationPct: number | null; approvedUtilizationPct: number | null; exceeded: boolean }
/**
 * proposedCost = every non-rejected / non-cancelled item (pending + approved + completed);
 * approvedCost = approved + completed only. Remaining is against the proposed pipeline.
 */
export function budgetUsage(allocated: number, proposedCost: number, approvedCost: number): BudgetUsage {
  return {
    allocated: round2(allocated), proposedCost: round2(proposedCost), approvedCost: round2(approvedCost),
    remaining: round2(allocated - proposedCost), remainingAfterApproved: round2(allocated - approvedCost),
    utilizationPct: allocated > 0 ? round2((proposedCost / allocated) * 100) : null,
    approvedUtilizationPct: allocated > 0 ? round2((approvedCost / allocated) * 100) : null,
    exceeded: proposedCost > allocated + EPS,
  };
}
/** Annual cost of a monthly salary increase (months configurable: 12, or 13/14 when bonuses are salary-linked). */
export const annualCost = (monthlyIncrease: number, months = 12) => round2(monthlyIncrease * months);
/** Would adding `additional` annual cost to the already-approved cost exceed the allocation? */
export function checkBudget(allocated: number, approvedCost: number, additional: number): { ok: boolean; exceededBy: number } {
  const over = round2(approvedCost + additional - allocated);
  return { ok: over <= EPS, exceededBy: Math.max(0, over) };
}

// ───────────────────────────── Scenario planning ─────────────────────────────

export type ScenarioMethod = 'FLAT_PERCENT' | 'MERIT_MATRIX' | 'PROMOTION_PLUS_INCREMENT' | 'BUDGET_LIMITED';
export interface ScenarioEmployee {
  employeeId: string; currentSalary: number; currentGross: number; band: SalaryBand | null;
  ratingCode: string | null; eligible: boolean; promotedSalary?: number | null; promotedBand?: SalaryBand | null;
}
export interface ScenarioConfig {
  method: ScenarioMethod;
  flatPct?: number | null;
  meritCells?: MeritCell[];
  /** base method used under BUDGET_LIMITED / PROMOTION_PLUS_INCREMENT */
  baseMethod?: 'FLAT_PERCENT' | 'MERIT_MATRIX';
  budgetLimit?: number | null;
  ceilingAction: 'CAP_AT_MAX' | 'REQUEST_EXCEPTION';
  annualizationMonths?: number;
  maxIncreasePct?: number | null;
}
export interface ScenarioItem { employeeId: string; currentSalary: number; currentGross: number; increasePct: number; proposedSalary: number; finalSalary: number; increase: number; exceedsMaxBy: number; requiresException: boolean; capped: boolean; promoted: boolean; included: boolean }
export interface ScenarioSummary {
  employees: number; included: number; currentPayroll: number; proposedPayroll: number; monthlyIncrease: number; annualIncrease: number;
  budget: number | null; budgetImpactPct: number | null; budgetRemaining: number | null; aboveMax: number; requiringException: number; capped: number; scaleFactor: number;
  averageIncreasePct: number;
}

export function runScenario(cfg: ScenarioConfig, emps: ScenarioEmployee[]): { items: ScenarioItem[]; summary: ScenarioSummary } {
  const months = cfg.annualizationMonths ?? 12;
  const base = cfg.method === 'FLAT_PERCENT' || cfg.method === 'MERIT_MATRIX' ? cfg.method : cfg.baseMethod ?? 'FLAT_PERCENT';
  const pctFor = (e: ScenarioEmployee): number => {
    if (base === 'FLAT_PERCENT') return cfg.flatPct ?? 0;
    const compa = e.band && e.band.mid > 0 ? (e.currentSalary / e.band.mid) * 100 : null;
    return recommendMeritIncrease(cfg.meritCells ?? [], e.ratingCode, compa)?.recommendedPct ?? 0;
  };
  const build = (factor: number): ScenarioItem[] => emps.map((e) => {
    if (!e.eligible) return { employeeId: e.employeeId, currentSalary: e.currentSalary, currentGross: e.currentGross, increasePct: 0, proposedSalary: e.currentSalary, finalSalary: e.currentSalary, increase: 0, exceedsMaxBy: 0, requiresException: false, capped: false, promoted: false, included: false };
    const promoted = cfg.method === 'PROMOTION_PLUS_INCREMENT' && e.promotedSalary !== null && e.promotedSalary !== undefined;
    const band = promoted ? e.promotedBand ?? e.band : e.band;
    const pct = round2(Math.min(pctFor(e) * factor, cfg.maxIncreasePct ?? Infinity));
    const startSalary = promoted ? e.promotedSalary! : e.currentSalary;
    const r = calculateIncrease({ currentSalary: startSalary, band, increasePct: pct, ceilingAction: cfg.ceilingAction });
    const increase = round2(r.finalSalary - e.currentSalary);
    return { employeeId: e.employeeId, currentSalary: e.currentSalary, currentGross: e.currentGross, increasePct: pctOf(e.currentSalary, r.finalSalary), proposedSalary: r.proposedSalary, finalSalary: r.finalSalary, increase, exceedsMaxBy: r.exceedsMaxBy, requiresException: r.requiresException, capped: r.outcome === 'CAPPED' && r.proposedSalary !== r.finalSalary, promoted, included: true };
  });
  let factor = 1;
  let items = build(1);
  const annual = (xs: ScenarioItem[]) => annualCost(xs.reduce((s, i) => s + i.increase, 0), months);
  if (cfg.method === 'BUDGET_LIMITED' && cfg.budgetLimit !== null && cfg.budgetLimit !== undefined) {
    // Scale the non-promotion increases proportionally until the annual cost fits the limit (binary search handles caps).
    if (annual(items) > cfg.budgetLimit) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (annual(build(mid)) <= cfg.budgetLimit) lo = mid; else hi = mid; }
      factor = Math.floor(lo * 10000) / 10000; items = build(factor);
    }
  }
  const inc = items.filter((i) => i.included);
  const currentPayroll = round2(emps.reduce((s, e) => s + e.currentGross, 0));
  const monthlyIncrease = round2(items.reduce((s, i) => s + i.increase, 0));
  const annualIncrease = annualCost(monthlyIncrease, months);
  const budget = cfg.budgetLimit ?? null;
  return {
    items,
    summary: {
      employees: emps.length, included: inc.length, currentPayroll, proposedPayroll: round2(currentPayroll + monthlyIncrease), monthlyIncrease, annualIncrease,
      budget, budgetImpactPct: budget ? round2((annualIncrease / budget) * 100) : null, budgetRemaining: budget !== null ? round2(budget - annualIncrease) : null,
      aboveMax: inc.filter((i) => i.exceedsMaxBy > 0).length, requiringException: inc.filter((i) => i.requiresException).length, capped: inc.filter((i) => i.capped).length,
      scaleFactor: factor,
      averageIncreasePct: inc.length ? round2(inc.reduce((s, i) => s + i.increasePct, 0) / inc.length) : 0,
    },
  };
}

// ───────────────────────────── Salary compression ─────────────────────────────

export type CompressionCompare = 'AVERAGE' | 'MEDIAN' | 'MAX_LOWER_VS_MIN_UPPER';
export interface CompressionPair { ruleId: string; ruleName: string; lowerKey: string; lowerLabel: string; upperKey: string; upperLabel: string; minDifferenceAmount: number | null; minDifferencePct: number | null; compare: CompressionCompare }
export interface CompressionFinding { ruleId: string; ruleName: string; lower: { key: string; label: string; value: number; count: number }; upper: { key: string; label: string; value: number; count: number }; difference: number; differencePct: number | null; reasons: ('AMOUNT' | 'PERCENT' | 'INVERSION')[]; message: string }

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : round2((s[m - 1]! + s[m]!) / 2);
}
export function salaryStats(values: number[]): { count: number; total: number; average: number; median: number; min: number; max: number } {
  if (!values.length) return { count: 0, total: 0, average: 0, median: 0, min: 0, max: 0 };
  const total = round2(values.reduce((s, v) => s + v, 0));
  return { count: values.length, total, average: round2(total / values.length), median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

/** Flag hierarchical levels whose salaries are too close (or inverted). Never changes salaries. */
export function detectCompression(pairs: CompressionPair[], salariesByKey: Map<string, number[]>): CompressionFinding[] {
  const out: CompressionFinding[] = [];
  for (const p of pairs) {
    const lo = salariesByKey.get(p.lowerKey) ?? [], up = salariesByKey.get(p.upperKey) ?? [];
    if (!lo.length || !up.length) continue;
    const pick = (xs: number[], side: 'lower' | 'upper') => p.compare === 'MEDIAN' ? median(xs) : p.compare === 'MAX_LOWER_VS_MIN_UPPER' ? (side === 'lower' ? Math.max(...xs) : Math.min(...xs)) : round2(xs.reduce((s, v) => s + v, 0) / xs.length);
    const lv = pick(lo, 'lower'), uv = pick(up, 'upper');
    const difference = round2(uv - lv);
    const differencePct = lv > 0 ? round2((difference / lv) * 100) : null;
    const reasons: CompressionFinding['reasons'] = [];
    if (difference < 0) reasons.push('INVERSION');
    if (p.minDifferenceAmount !== null && difference < p.minDifferenceAmount) reasons.push('AMOUNT');
    if (p.minDifferencePct !== null && differencePct !== null && differencePct < p.minDifferencePct) reasons.push('PERCENT');
    if (reasons.length) out.push({ ruleId: p.ruleId, ruleName: p.ruleName, lower: { key: p.lowerKey, label: p.lowerLabel, value: lv, count: lo.length }, upper: { key: p.upperKey, label: p.upperLabel, value: uv, count: up.length }, difference, differencePct, reasons,
      message: reasons.includes('INVERSION') ? `Salary inversion: ${p.upperLabel} (${formatMoney(uv)}) is paid less than ${p.lowerLabel} (${formatMoney(lv)})` : `Potential Salary Compression: ${p.lowerLabel} ${formatMoney(lv)} vs ${p.upperLabel} ${formatMoney(uv)} (difference ${formatMoney(difference)}${differencePct !== null ? `, ${differencePct}%` : ''})` });
  }
  return out;
}

// ───────────────────────────── Duplicate protection ─────────────────────────────

export interface ExistingChange { changeType: string; effectiveYear: number; status: string }
const DEAD = new Set(['REJECTED', 'CANCELLED', 'FAILED']);
/** An employee may receive one ANNUAL_INCREMENT per effective year (rejected/cancelled/failed ones don't count). */
export function findDuplicateAnnualIncrease(existing: ExistingChange[], effectiveYear: number): ExistingChange | null {
  return existing.find((c) => c.changeType === 'ANNUAL_INCREMENT' && c.effectiveYear === effectiveYear && !DEAD.has(c.status)) ?? null;
}
