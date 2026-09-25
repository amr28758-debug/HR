import { sql, type Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { bandPosition, classifyBandStatus, monthsBetween, resolveRatingLevel, type BandStatus, type RatingLevel, type SalaryBand } from '@burtplace/core';
import type { CompensationPolicy } from './policy.js';

/** Statuses counted as "on payroll" for compensation purposes. */
export const WORKING_STATUSES = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED'] as const;
export const CHANGE_TYPES = ['ANNUAL_INCREMENT', 'PROMOTION', 'MARKET_ADJUSTMENT', 'SALARY_CORRECTION', 'MERIT_INCREASE', 'SPECIAL_ADJUSTMENT', 'DEMOTION_ADJUSTMENT', 'GRADE_CHANGE'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export const LIVE_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'APPROVED'] as const;
export const PENDING_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED'] as const;
export const DEAD_STATUSES = ['REJECTED', 'CANCELLED', 'FAILED'] as const;

/** HR request type that carries each compensation change through the approval engine. */
export function requestTypeFor(t: ChangeType, hasGradeChange: boolean): 'INCREMENT' | 'PROMOTION' | 'GRADE_CHANGE' | 'SALARY_CHANGE' {
  if (t === 'ANNUAL_INCREMENT' || t === 'MERIT_INCREASE') return 'INCREMENT';
  if (t === 'PROMOTION') return 'PROMOTION';
  if (t === 'GRADE_CHANGE' || (t === 'DEMOTION_ADJUSTMENT' && hasGradeChange)) return 'GRADE_CHANGE';
  return 'SALARY_CHANGE';
}
/** Budget bucket for a change type (every type also counts against ANNUAL). */
export function budgetBucket(t: string): 'INCREMENT' | 'PROMOTION' | 'ADJUSTMENT' {
  if (t === 'ANNUAL_INCREMENT' || t === 'MERIT_INCREASE') return 'INCREMENT';
  if (t === 'PROMOTION' || t === 'GRADE_CHANGE') return 'PROMOTION';
  return 'ADJUSTMENT';
}

export async function nextCompNo(db: Kysely<DB>, prefix: 'SC' | 'PR'): Promise<string> {
  const r = await sql<{ n: number }>`SELECT nextval('compensation_no_seq')::int AS n`.execute(db);
  return `${prefix}-${new Date().getFullYear()}-${String(r.rows[0]!.n).padStart(6, '0')}`;
}

export interface BandRow { id: string; gradeId: string; min: number; mid: number; max: number; currency: string; effectiveFrom: string; effectiveTo: string | null }
/** The ACTIVE band of a grade on a date. */
export async function bandFor(db: Kysely<DB>, gradeId: string | null, date: string): Promise<BandRow | null> {
  if (!gradeId) return null;
  const b = await db.selectFrom('salary_bands').selectAll().where('grade_id', '=', gradeId).where('status', '=', 'ACTIVE').where('deleted_at', 'is', null)
    .where('effective_from', '<=', date).where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', date)])).orderBy('effective_from', 'desc').executeTakeFirst();
  return b ? { id: b.id, gradeId: b.grade_id, min: Number(b.min_salary), mid: Number(b.mid_salary), max: Number(b.max_salary), currency: b.currency, effectiveFrom: b.effective_from, effectiveTo: b.effective_to } : null;
}
export const asBand = (b: BandRow | null): SalaryBand | null => (b ? { min: b.min, mid: b.mid, max: b.max, currency: b.currency } : null);

export async function ratingLevels(db: Kysely<DB>): Promise<RatingLevel[]> {
  return (await db.selectFrom('performance_rating_levels').selectAll().where('is_active', '=', true).orderBy('sort_order').execute()).map((l) => ({ code: l.code, label: l.label, minScore: Number(l.min_score), maxScore: Number(l.max_score), sortOrder: l.sort_order }));
}

// ───────────────────────── Compensation profiles ─────────────────────────

export interface ProfileFilter {
  employeeIds?: string[]; departmentIds?: string[]; siteIds?: string[]; gradeIds?: string[]; designationIds?: string[];
  employmentTypes?: string[]; statuses?: string[]; genders?: string[]; search?: string; includeAllStatuses?: boolean;
  /** Take the rating from this performance cycle instead of the latest finalised one. */
  performanceCycleId?: string | null;
}
export interface Profile {
  employeeId: string; employeeNo: string; name: string; status: string; employmentType: string; gender: string; joiningDate: string | null; onProbation: boolean;
  departmentId: string | null; department: string | null; siteId: string | null; site: string | null; designationId: string | null; designation: string | null;
  titleGradeId: string | null; titleGradeCode: string | null;
  gradeId: string | null; gradeCode: string | null; gradeName: string | null;
  structureId: string | null; currency: string; basicSalary: number | null; grossSalary: number | null; salaryBasis: 'BASIC' | 'GROSS'; currentSalary: number | null; salaryEffectiveFrom: string | null;
  band: BandRow | null;
  compaRatio: number | null; rangePenetration: number | null; remainingToMax: number | null; maxPossibleIncreasePct: number | null; aboveMaxBy: number; belowMinBy: number;
  bandStatus: BandStatus;
  lastIncreaseDate: string | null; lastPromotionDate: string | null; lastReviewDate: string | null; lastDisciplinaryDate: string | null;
  ratingScore: number | null; ratingCycleYear: number | null; ratingCode: string | null; ratingLabel: string | null;
  dueForReview: boolean;
  annualIncrementYears: number[];
}

export async function loadProfiles(db: Kysely<DB>, policy: CompensationPolicy, f: ProfileFilter = {}, asOf = new Date().toISOString().slice(0, 10)): Promise<Profile[]> {
  const conds = [sql`e.deleted_at IS NULL`];
  if (!f.includeAllStatuses) conds.push(sql`e.status IN (${sql.join((f.statuses?.length ? f.statuses : [...WORKING_STATUSES]).map((s) => sql`${s}`))})`);
  else if (f.statuses?.length) conds.push(sql`e.status IN (${sql.join(f.statuses.map((s) => sql`${s}`))})`);
  const inList = (col: string, ids?: string[]) => { if (ids?.length) conds.push(sql`${sql.ref(col)} IN (${sql.join(ids.map((i) => sql`${i}`))})`); };
  inList('e.id', f.employeeIds); inList('e.department_id', f.departmentIds); inList('e.site_id', f.siteIds); inList('e.grade_id', f.gradeIds); inList('e.designation_id', f.designationIds);
  if (f.employmentTypes?.length) conds.push(sql`e.employment_type::text IN (${sql.join(f.employmentTypes.map((s) => sql`${s}`))})`);
  if (f.genders?.length) conds.push(sql`e.gender::text IN (${sql.join(f.genders.map((s) => sql`${s}`))})`);
  if (f.search) conds.push(sql`(e.full_name_en ILIKE ${'%' + f.search + '%'} OR e.employee_no ILIKE ${'%' + f.search + '%'})`);
  const ratingJoin = f.performanceCycleId
    ? sql`LEFT JOIN LATERAL (SELECT pr.final_rating, pc.cycle_year FROM performance_reviews pr JOIN performance_cycles pc ON pc.id = pr.cycle_id WHERE pr.employee_id = e.id AND pr.cycle_id = ${f.performanceCycleId} AND pr.final_rating IS NOT NULL LIMIT 1) rt ON true`
    : sql`LEFT JOIN LATERAL (SELECT pr.final_rating, pc.cycle_year FROM performance_reviews pr JOIN performance_cycles pc ON pc.id = pr.cycle_id WHERE pr.employee_id = e.id AND pr.final_rating IS NOT NULL ORDER BY pc.cycle_year DESC, pr.finalized_at DESC NULLS LAST LIMIT 1) rt ON true`;
  const rows = (await sql<any>`
    SELECT e.id, e.employee_no, e.full_name_en, e.status::text AS status, e.employment_type::text AS employment_type, e.gender::text AS gender, e.joining_date, e.probation_status::text AS probation_status,
      e.department_id, d.name AS department, e.site_id, s.name AS site, e.designation_id, dg.title AS designation, dg.default_grade_id AS title_grade_id, tg.code AS title_grade_code,
      e.grade_id, gr.code AS grade_code, gr.name AS grade_name,
      ss.id AS structure_id, ss.basic_salary, ss.gross_salary, ss.currency, ss.effective_from AS salary_from,
      b.id AS band_id, b.min_salary, b.mid_salary, b.max_salary, b.currency AS band_currency, b.effective_from AS band_from, b.effective_to AS band_to,
      greatest(inc.d, inc2.d) AS last_increase_date, greatest(prm.d, prm2.d) AS last_promotion_date, rev.d AS last_review_date, dc.d AS last_disc,
      rt.final_rating, rt.cycle_year, ai.years AS annual_years
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN sites s ON s.id = e.site_id
    LEFT JOIN designations dg ON dg.id = e.designation_id LEFT JOIN grades tg ON tg.id = dg.default_grade_id
    LEFT JOIN grades gr ON gr.id = e.grade_id
    LEFT JOIN LATERAL (SELECT x.id, x.basic_salary, x.gross_salary, x.currency, x.effective_from FROM employee_salary_structures x WHERE x.employee_id = e.id ORDER BY x.version DESC LIMIT 1) ss ON true
    LEFT JOIN LATERAL (SELECT x.* FROM salary_bands x WHERE x.grade_id = e.grade_id AND x.status = 'ACTIVE' AND x.deleted_at IS NULL AND x.effective_from <= ${asOf}::date AND (x.effective_to IS NULL OR x.effective_to >= ${asOf}::date) ORDER BY x.effective_from DESC LIMIT 1) b ON true
    LEFT JOIN LATERAL (SELECT max(c.effective_date) d FROM salary_changes c WHERE c.employee_id = e.id AND c.status = 'COMPLETED' AND c.increase_amount > 0) inc ON true
    LEFT JOIN LATERAL (SELECT max(x.effective_from) d FROM employee_salary_structures x WHERE x.employee_id = e.id AND x.version > 1 AND x.source IN ('INCREMENT', 'SALARY_CHANGE', 'PROMOTION', 'GRADE_CHANGE')) inc2 ON true
    LEFT JOIN LATERAL (SELECT max(h.effective_from) d FROM employment_history h WHERE h.employee_id = e.id AND h.change_type = 'PROMOTION') prm ON true
    LEFT JOIN LATERAL (SELECT max(c.effective_date) d FROM salary_changes c WHERE c.employee_id = e.id AND c.status = 'COMPLETED' AND c.change_type = 'PROMOTION') prm2 ON true
    LEFT JOIN LATERAL (SELECT max(r.effective_date) d FROM salary_review_items i JOIN salary_reviews r ON r.id = i.cycle_id WHERE i.employee_id = e.id AND r.status = 'COMPLETED') rev ON true
    LEFT JOIN LATERAL (SELECT max(x.incident_date) d FROM disciplinary_cases x WHERE x.employee_id = e.id) dc ON true
    LEFT JOIN LATERAL (SELECT array_agg(DISTINCT c.effective_year) years FROM salary_changes c WHERE c.employee_id = e.id AND c.change_type = 'ANNUAL_INCREMENT' AND c.status NOT IN ('REJECTED', 'CANCELLED', 'FAILED')) ai ON true
    ${ratingJoin}
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY e.employee_no`.execute(db)).rows;
  const levels = await ratingLevels(db);
  return rows.map((r) => toProfile(r, policy, levels, asOf));
}

const d10 = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
function toProfile(r: any, policy: CompensationPolicy, levels: RatingLevel[], asOf: string): Profile {
  const basic = r.basic_salary === null ? null : Number(r.basic_salary), gross = r.gross_salary === null ? null : Number(r.gross_salary);
  const salary = policy.bandBasis === 'GROSS' ? gross : basic;
  const band: BandRow | null = r.band_id ? { id: r.band_id, gradeId: r.grade_id, min: Number(r.min_salary), mid: Number(r.mid_salary), max: Number(r.max_salary), currency: r.band_currency, effectiveFrom: d10(r.band_from)!, effectiveTo: d10(r.band_to) } : null;
  const pos = band && salary !== null ? bandPosition(salary, band) : null;
  const rating = r.final_rating === null || r.final_rating === undefined ? null : Number(r.final_rating);
  const level = resolveRatingLevel(levels, rating);
  const lastInc = d10(r.last_increase_date);
  const anchor = lastInc ?? d10(r.joining_date);
  return {
    employeeId: r.id, employeeNo: r.employee_no, name: r.full_name_en, status: r.status, employmentType: r.employment_type, gender: r.gender, joiningDate: d10(r.joining_date), onProbation: r.probation_status === 'ON_PROBATION' || r.probation_status === 'EXTENDED',
    departmentId: r.department_id, department: r.department, siteId: r.site_id, site: r.site, designationId: r.designation_id, designation: r.designation,
    titleGradeId: r.title_grade_id, titleGradeCode: r.title_grade_code, gradeId: r.grade_id, gradeCode: r.grade_code, gradeName: r.grade_name,
    structureId: r.structure_id, currency: r.currency ?? band?.currency ?? 'AED', basicSalary: basic, grossSalary: gross, salaryBasis: policy.bandBasis, currentSalary: salary, salaryEffectiveFrom: d10(r.salary_from),
    band, compaRatio: pos?.compaRatio ?? null, rangePenetration: pos?.rangePenetration ?? null, remainingToMax: pos?.remainingToMax ?? null, maxPossibleIncreasePct: pos?.maxPossibleIncreasePct ?? null,
    aboveMaxBy: pos?.aboveMaxBy ?? 0, belowMinBy: pos?.belowMinBy ?? 0,
    bandStatus: classifyBandStatus(pos, policy.statusThresholds),
    lastIncreaseDate: lastInc, lastPromotionDate: d10(r.last_promotion_date), lastReviewDate: d10(r.last_review_date), lastDisciplinaryDate: d10(r.last_disc),
    ratingScore: rating, ratingCycleYear: r.cycle_year ?? null, ratingCode: level?.code ?? null, ratingLabel: level?.label ?? null,
    dueForReview: !!anchor && monthsBetween(anchor, asOf) >= policy.reviewDueMonths,
    annualIncrementYears: (r.annual_years ?? []).filter((y: unknown) => y !== null).map(Number),
  };
}

/** Salary lines of a structure (for GROSS-basis distribution). */
export async function structureLines(db: Kysely<DB>, structureId: string): Promise<{ componentCode: string; amount: number; scalable: boolean }[]> {
  return (await db.selectFrom('employee_salary_lines as l').innerJoin('salary_components as c', 'c.id', 'l.component_id').select(['c.code', 'l.amount', 'c.is_fixed_pay', 'c.kind']).where('l.salary_structure_id', '=', structureId).execute())
    .map((l) => ({ componentCode: l.code, amount: Number(l.amount), scalable: l.is_fixed_pay && l.kind === 'EARNING' }));
}
