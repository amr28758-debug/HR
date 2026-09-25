import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import {
  annualCost, bandPosition, budgetUsage, calculateIncrease, calculatePromotionSalary, distributeToTotal, promotionSalaryAlerts, recommendMeritIncrease, round2, selectPromotionRule,
  type BudgetUsage, type CeilingAction, type CompAlert, type IncreaseResult, type MeritCell, type PromotionRule,
} from '@burtplace/core';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../plugins/errors.js';
import type { Principal } from '../../plugins/auth.js';
import { applyHrRequest, createHrRequest } from '../hr-requests/service.js';
import { asBand, bandFor, budgetBucket, LIVE_STATUSES, loadProfiles, nextCompNo, requestTypeFor, structureLines, WORKING_STATUSES, type BandRow, type ChangeType, type Profile } from './data.js';
import { duplicateMessage } from './ledger.js';
import { loadPolicy, type CompensationPolicy } from './policy.js';

/**
 * Compensation service — salary changes & promotions from calculation to completion.
 *
 *   evaluate (engine + band + merit matrix + duplicate + budget) → DRAFT salary_changes row
 *   → submit: HR request (type INCREMENT / SALARY_CHANGE / PROMOTION / GRADE_CHANGE) on workflow COMP_<TYPE>, never auto-approved
 *   → each decision mirrored in compensation_approval_actions (workflow-hooks.ts)
 *   → final approval: applyCompensationRequest — ONE transaction: re-validate employee, band, duplicate, stale salary and budget,
 *     apply the HR request (salary version + history + timeline), complete the ledger row, approval trail and audit.
 */

// ───────────────────────── Approval trail ─────────────────────────
export async function logApproval(db: Kysely<DB>, a: { entityType: 'salary_change' | 'promotion_request' | 'salary_review'; entityId: string; userId: string | null; userName?: string | null; roleCode?: string | null; action: string; stepKey?: string | null; comment?: string | null; previousStatus: string | null; newStatus: string; taskId?: string | null }): Promise<void> {
  const name = a.userName ?? (a.userId ? (await db.selectFrom('users').select('display_name').where('id', '=', a.userId).executeTakeFirst())?.display_name ?? null : null);
  await db.insertInto('compensation_approval_actions').values({ entity_type: a.entityType, entity_id: a.entityId, user_id: a.userId, user_name: name, role_code: a.roleCode ?? null, action: a.action, step_key: a.stepKey ?? null, comment: a.comment ?? null, previous_status: a.previousStatus, new_status: a.newStatus, workflow_task_id: a.taskId ?? null }).execute();
}
const primaryRole = (p: Principal) => p.roles.find((r) => r !== 'EMPLOYEE') ?? p.roles[0] ?? null;

/** Update a change and its promotion request (they share the status), recording the transition. */
export async function setChangeStatus(db: Kysely<DB>, changeId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db.updateTable('salary_changes').set({ status, ...extra } as any).where('id', '=', changeId).execute();
  await db.updateTable('promotion_requests').set({ status, ...(status === 'COMPLETED' ? { completed_at: new Date() } : {}), ...(extra.approved_by ? { approved_by: extra.approved_by as string, approved_at: new Date() } : {}) }).where('salary_change_id', '=', changeId).execute();
}

// ───────────────────────── Budgets ─────────────────────────
export interface CostLine { employeeId: string; departmentId: string | null; siteId: string | null; gradeId: string | null; changeType: string; annualCost: number; approved: boolean; sourceId: string }
/** Every compensation cost of a fiscal year: live/approved/completed changes + submitted reviews' not-yet-applied items. */
export async function loadCostLines(db: Kysely<DB>, year: number, months: number, excludeChangeId?: string): Promise<CostLine[]> {
  let q = db.selectFrom('salary_changes as c').innerJoin('employees as e', 'e.id', 'c.employee_id')
    .select(['c.id', 'c.employee_id', 'e.department_id', 'e.site_id', 'c.new_grade_id', 'e.grade_id', 'c.change_type', 'c.annual_cost', 'c.status', 'c.approved_at'])
    .where('c.effective_year', '=', year).where('c.change_type', '<>', 'JOINING').where('c.status', 'in', [...LIVE_STATUSES, 'COMPLETED']);
  if (excludeChangeId) q = q.where('c.id', '<>', excludeChangeId);
  const changes = (await q.execute()).map((c) => ({ employeeId: c.employee_id, departmentId: c.department_id, siteId: c.site_id, gradeId: c.new_grade_id ?? c.grade_id, changeType: c.change_type, annualCost: Number(c.annual_cost), approved: c.status === 'COMPLETED' || !!c.approved_at, sourceId: c.id }));
  const items = (await db.selectFrom('salary_review_items as i').innerJoin('salary_reviews as r', 'r.id', 'i.cycle_id').innerJoin('employees as e', 'e.id', 'i.employee_id')
    .select(['i.id', 'i.employee_id', 'e.department_id', 'e.site_id', 'e.grade_id', 'i.proposed_amount', 'r.status', 'r.approved_at'])
    .where('i.salary_change_id', 'is', null).where('i.status', 'in', ['PROPOSED', 'APPROVED']).where('i.eligible', '=', true)
    .where('r.status', 'in', [...LIVE_STATUSES]).where('r.deleted_at', 'is', null).where((eb) => eb.fn('date_part', [eb.val('year'), eb.ref('r.effective_date')]), '=', year).execute())
    .map((i) => ({ employeeId: i.employee_id, departmentId: i.department_id, siteId: i.site_id, gradeId: i.grade_id, changeType: 'ANNUAL_INCREMENT', annualCost: annualCost(Number(i.proposed_amount), months), approved: !!i.approved_at, sourceId: i.id }));
  return [...changes, ...items];
}
type BudgetRow = { id: string; name: string; fiscal_year: number; budget_type: string; scope_type: string; scope_id: string | null; amount: number; currency: string; status: string };
export function budgetApplies(b: Pick<BudgetRow, 'budget_type' | 'scope_type' | 'scope_id'>, l: Pick<CostLine, 'changeType' | 'departmentId' | 'siteId' | 'gradeId'>): boolean {
  if (b.budget_type !== 'ANNUAL' && b.budget_type !== budgetBucket(l.changeType)) return false;
  switch (b.scope_type) { case 'DEPARTMENT': return l.departmentId === b.scope_id; case 'SITE': return l.siteId === b.scope_id; case 'GRADE': return l.gradeId === b.scope_id; default: return true; }
}
export function usageOf(b: BudgetRow, lines: CostLine[]): BudgetUsage {
  const mine = lines.filter((l) => budgetApplies(b, l));
  return budgetUsage(Number(b.amount), mine.reduce((s, l) => s + l.annualCost, 0), mine.filter((l) => l.approved).reduce((s, l) => s + l.annualCost, 0));
}
export interface BudgetViolation { budgetId: string; name: string; allocated: number; approvedCost: number; additional: number; exceededBy: number }
/** Budgets that `additional` would push over (against approved cost). */
export async function checkBudgets(db: Kysely<DB>, policy: CompensationPolicy, line: Omit<CostLine, 'approved' | 'sourceId'>, year: number, excludeChangeId?: string): Promise<BudgetViolation[]> {
  if (policy.budgetEnforcement === 'OFF' || line.annualCost <= 0) return [];
  const budgets = (await db.selectFrom('compensation_budgets').selectAll().where('fiscal_year', '=', year).where('status', '=', 'ACTIVE').where('deleted_at', 'is', null).execute()) as unknown as BudgetRow[];
  const relevant = budgets.filter((b) => budgetApplies(b, line));
  if (!relevant.length) return [];
  const lines = await loadCostLines(db, year, policy.annualizationMonths, excludeChangeId);
  return relevant.map((b) => { const u = usageOf(b, lines); const over = round2(u.approvedCost + line.annualCost - u.allocated); return { budgetId: b.id, name: b.name, allocated: u.allocated, approvedCost: u.approvedCost, additional: line.annualCost, exceededBy: over }; }).filter((v) => v.exceededBy > 0.004);
}

// ───────────────────────── Evaluation ─────────────────────────
export interface ChangeInput {
  employeeId: string; changeType: ChangeType; increasePct?: number; increaseAmount?: number; newSalary?: number; effectiveDate: string;
  ceilingAction?: CeilingAction | null; newGradeId?: string | null; newDesignationId?: string | null;
  overrideDuplicate?: boolean; overrideBudget?: boolean; justification?: string | null;
}
export interface Evaluation {
  profile: Profile; band: BandRow | null; calc: IncreaseResult; recommendation: { ratingCode: string | null; recommendedPct: number; maxPct: number } | null;
  duplicate: { message: string; reference: string } | null; budgetViolations: BudgetViolation[]; overrideReasons: string[]; alerts: CompAlert[]; annualCost: number; blockers: string[];
}

export async function defaultMeritCells(db: Kysely<DB>, matrixId?: string | null): Promise<MeritCell[]> {
  const m = matrixId ? { id: matrixId } : await db.selectFrom('merit_matrices').select('id').where('is_default', '=', true).where('deleted_at', 'is', null).executeTakeFirst();
  if (!m) return [];
  return (await db.selectFrom('merit_matrix_cells').selectAll().where('matrix_id', '=', m.id).execute()).map((c) => ({ ratingCode: c.rating_code, minCompa: c.min_compa === null ? null : Number(c.min_compa), maxCompa: c.max_compa === null ? null : Number(c.max_compa), recommendedPct: Number(c.recommended_pct), maxPct: Number(c.max_pct) }));
}

export async function loadProfile(db: Kysely<DB>, policy: CompensationPolicy, employeeId: string): Promise<Profile> {
  const [p] = await loadProfiles(db, policy, { employeeIds: [employeeId], includeAllStatuses: true });
  if (!p) throw notFound('Employee', employeeId);
  return p;
}

/** Where is an annual increase for this employee/year already in flight or done? */
export async function findAnnualDuplicate(db: Kysely<DB>, employeeId: string, year: number, excludeChangeId?: string, excludeReviewId?: string): Promise<{ message: string; reference: string } | null> {
  let q = db.selectFrom('salary_changes').select(['change_no', 'status']).where('employee_id', '=', employeeId).where('change_type', '=', 'ANNUAL_INCREMENT').where('effective_year', '=', year).where('status', 'not in', ['REJECTED', 'CANCELLED', 'FAILED']).where('duplicate_override', '=', false);
  if (excludeChangeId) q = q.where('id', '<>', excludeChangeId);
  const c = await q.executeTakeFirst();
  if (c) return { message: duplicateMessage(year), reference: `${c.change_no} (${c.status})` };
  let r = db.selectFrom('salary_review_items as i').innerJoin('salary_reviews as r', 'r.id', 'i.cycle_id').select(['r.name', 'r.status']).where('i.employee_id', '=', employeeId).where('i.status', 'in', ['PROPOSED', 'APPROVED']).where('i.eligible', '=', true)
    .where('r.status', 'not in', ['REJECTED', 'CANCELLED', 'COMPLETED']).where('r.deleted_at', 'is', null).where((eb) => eb.fn('date_part', [eb.val('year'), eb.ref('r.effective_date')]), '=', year);
  if (excludeReviewId) r = r.where('r.id', '<>', excludeReviewId);
  const ri = await r.executeTakeFirst();
  return ri ? { message: `Employee is already included in the ${year} salary review "${ri.name}" (${ri.status}).`, reference: ri.name } : null;
}

export async function evaluateChange(db: Kysely<DB>, input: ChangeInput, opts: { excludeChangeId?: string; policy?: CompensationPolicy } = {}): Promise<Evaluation> {
  const policy = opts.policy ?? await loadPolicy(db);
  const profile = await loadProfile(db, policy, input.employeeId);
  if (!(WORKING_STATUSES as readonly string[]).includes(profile.status)) throw unprocessable(`Employee is ${profile.status} — compensation changes are only possible for active employees`);
  if (profile.currentSalary === null || !profile.structureId) throw unprocessable('Employee has no salary structure — set the joining salary first');
  if (input.changeType === 'PROMOTION') throw badRequest('Promotions are raised with POST /compensation/promotions');
  const gradeChange = !!input.newGradeId && input.newGradeId !== profile.gradeId;
  if (input.changeType === 'GRADE_CHANGE' && !gradeChange) throw badRequest('GRADE_CHANGE needs a new grade different from the current one');
  const band = await bandFor(db, gradeChange ? input.newGradeId! : profile.gradeId, input.effectiveDate);
  let calc: IncreaseResult;
  try {
    calc = calculateIncrease({ currentSalary: profile.currentSalary, band: asBand(band), currency: profile.currency, increasePct: input.increasePct, increaseAmount: input.increaseAmount, newSalary: input.newSalary, ceilingAction: input.ceilingAction ?? null, allowedCeilingActions: policy.ceilingActions, maxIncreasePct: policy.maxIncreasePctWithoutOverride });
  } catch (e) { throw badRequest((e as Error).message); }
  const blockers: string[] = [];
  const inc = calc.proposedIncreaseAmount;
  if (['ANNUAL_INCREMENT', 'MERIT_INCREASE', 'MARKET_ADJUSTMENT'].includes(input.changeType) && !(inc > 0)) blockers.push(`${input.changeType} must increase the salary`);
  if (input.changeType === 'DEMOTION_ADJUSTMENT' && calc.finalSalary > profile.currentSalary) blockers.push('A demotion adjustment cannot increase the salary');
  if (['SALARY_CORRECTION', 'SPECIAL_ADJUSTMENT'].includes(input.changeType) && inc === 0) blockers.push('The new salary equals the current salary');
  if (calc.outcome === 'ACTION_REQUIRED') blockers.push(`${calc.alerts.find((a) => a.code === 'EXCEEDS_BAND_MAX')!.message} Choose an action: cap at maximum, request exception, cancel, or change grade / promotion.`);
  if (calc.outcome === 'CANCELLED') blockers.push('The increase was cancelled by the ceiling action — nothing to submit');
  if (calc.outcome === 'GRADE_CHANGE_REQUIRED') blockers.push('Raise a promotion or grade change instead of an increase within the current band');

  const overrideReasons: string[] = [];
  let recommendation: Evaluation['recommendation'] = null;
  if (input.changeType === 'ANNUAL_INCREMENT' || input.changeType === 'MERIT_INCREASE') {
    const cell = recommendMeritIncrease(await defaultMeritCells(db), profile.ratingCode, profile.compaRatio);
    if (cell) {
      recommendation = { ratingCode: profile.ratingCode, recommendedPct: cell.recommendedPct, maxPct: cell.maxPct };
      if (calc.finalIncreasePct > cell.maxPct) overrideReasons.push(`Increase ${calc.finalIncreasePct}% exceeds the merit-matrix maximum of ${cell.maxPct}% for ${profile.ratingLabel ?? profile.ratingCode}`);
    }
  }
  if (calc.exceedsMaxIncreasePct) overrideReasons.push(`Increase ${calc.finalIncreasePct}% exceeds the policy maximum of ${policy.maxIncreasePctWithoutOverride}% without override`);

  const year = Number(input.effectiveDate.slice(0, 4));
  const duplicate = input.changeType === 'ANNUAL_INCREMENT' ? await findAnnualDuplicate(db, input.employeeId, year, opts.excludeChangeId) : null;
  const cost = annualCost(calc.finalIncreaseAmount, policy.annualizationMonths);
  const budgetViolations = await checkBudgets(db, policy, { employeeId: profile.employeeId, departmentId: profile.departmentId, siteId: profile.siteId, gradeId: gradeChange ? input.newGradeId! : profile.gradeId, changeType: input.changeType, annualCost: cost }, year, opts.excludeChangeId);
  const alerts: CompAlert[] = [...calc.alerts];
  if (duplicate) alerts.push({ code: 'DUPLICATE_ANNUAL_INCREASE', severity: 'CRITICAL', message: duplicate.message });
  for (const v of budgetViolations) alerts.push({ code: 'BUDGET_EXCEEDED', severity: policy.budgetEnforcement === 'BLOCK' ? 'CRITICAL' : 'WARNING', message: `Budget "${v.name}" would be exceeded by ${v.exceededBy.toLocaleString('en-US')} ${profile.currency}`, amount: v.exceededBy });
  for (const r of overrideReasons) alerts.push({ code: 'OVERRIDE_REQUIRED', severity: 'WARNING', message: r });
  return { profile, band, calc, recommendation, duplicate, budgetViolations, overrideReasons, alerts, annualCost: cost, blockers };
}

/** Throw unless every blocker is resolved and every override is authorised + justified. */
function enforce(ev: Evaluation, input: ChangeInput, p: Principal, policy: CompensationPolicy, stage: 'create' | 'submit'): { isOverride: boolean; duplicateOverride: boolean; budgetOverride: boolean } {
  if (ev.blockers.length) throw new AppError(422, 'COMPENSATION_BLOCKED', ev.blockers[0]!, { blockers: ev.blockers, alerts: ev.alerts, calculation: ev.calc });
  const justified = !!input.justification?.trim();
  const canOverride = p.permissions.has('compensation:override');
  if (ev.calc.requiresException && !justified) throw unprocessable('A justification is required to request a salary-band exception');
  if (ev.overrideReasons.length) {
    if (!canOverride) throw forbidden(`${ev.overrideReasons[0]} — compensation:override is required`);
    if (!justified) throw unprocessable(`${ev.overrideReasons[0]} — a justification is required`);
  }
  if (ev.duplicate) {
    if (!input.overrideDuplicate) throw conflict(ev.duplicate.message, { reference: ev.duplicate.reference });
    if (!canOverride) throw forbidden('Only authorised users (compensation:override) may override duplicate annual increase protection');
    if (!justified) throw unprocessable('A justification is required to override duplicate protection');
  }
  const blockBudget = stage === 'submit' && ev.budgetViolations.length > 0 && policy.budgetEnforcement === 'BLOCK';
  if (blockBudget) {
    const v = ev.budgetViolations[0]!;
    if (!input.overrideBudget) throw new AppError(422, 'BUDGET_EXCEEDED', `Budget "${v.name}" would be exceeded by ${v.exceededBy} (allocated ${v.allocated}, approved ${v.approvedCost}, this change ${v.additional})`, { violations: ev.budgetViolations });
    if (!canOverride || !justified) throw forbidden('Exceeding the budget needs compensation:override and a justification');
  }
  return { isOverride: ev.overrideReasons.length > 0, duplicateOverride: !!ev.duplicate, budgetOverride: blockBudget };
}

// ───────────────────────── Create / submit / cancel ─────────────────────────
export async function createSalaryChange(app: FastifyInstance, req: FastifyRequest, p: Principal, input: ChangeInput & { reason: string; comments?: string | null; submit?: boolean }): Promise<string> {
  const policy = await loadPolicy(app.db);
  const ev = await evaluateChange(app.db, input, { policy });
  const flags = enforce(ev, input, p, policy, 'create');
  const pr = ev.profile;
  const id = await app.db.transaction().execute(async (trx) => {
    const row = await trx.insertInto('salary_changes').values({
      change_no: await nextCompNo(trx, 'SC'), employee_id: pr.employeeId, change_type: input.changeType, status: 'DRAFT', source: 'COMPENSATION', salary_basis: pr.salaryBasis, currency: pr.currency,
      old_salary: ev.calc.currentSalary, increase_amount: ev.calc.finalIncreaseAmount, increase_pct: ev.calc.finalIncreasePct, new_salary: ev.calc.finalSalary,
      old_basic: pr.basicSalary, old_gross: pr.grossSalary, annual_cost: ev.annualCost, effective_date: input.effectiveDate, reason: input.reason, comments: input.comments ?? null, justification: input.justification?.trim() || null,
      old_grade_id: pr.gradeId, new_grade_id: input.newGradeId ?? pr.gradeId, old_designation_id: pr.designationId, new_designation_id: input.newDesignationId ?? pr.designationId,
      band_id: ev.band?.id ?? null, band_min: ev.band?.min ?? null, band_mid: ev.band?.mid ?? null, band_max: ev.band?.max ?? null,
      compa_before: ev.calc.before?.compaRatio ?? pr.compaRatio, compa_after: ev.calc.after?.compaRatio ?? null, exceeds_max_by: ev.calc.exceedsMaxBy, ceiling_action: ev.calc.ceilingAction, requires_exception: ev.calc.requiresException,
      recommended_pct: ev.recommendation?.recommendedPct ?? null, is_override: flags.isOverride, duplicate_override: flags.duplicateOverride, alerts: JSON.stringify(ev.alerts), requested_by: p.userId,
    }).returning(['id', 'change_no']).executeTakeFirstOrThrow();
    await logApproval(trx, { entityType: 'salary_change', entityId: row.id, userId: p.userId, userName: p.displayName, roleCode: primaryRole(p), action: 'CREATE', previousStatus: null, newStatus: 'DRAFT', comment: input.reason });
    await app.audit(req, { action: 'compensation.change.create', entityType: 'salary_change', entityId: row.id, newValue: { changeNo: row.change_no, employeeId: pr.employeeId, type: input.changeType, oldSalary: ev.calc.currentSalary, newSalary: ev.calc.finalSalary, pct: ev.calc.finalIncreasePct, ceilingAction: ev.calc.ceilingAction, overrides: flags }, reason: input.justification ?? input.reason }, 'api', trx);
    return row.id;
  });
  if (input.submit) await submitSalaryChange(app, req, p, id);
  return id;
}

export async function submitSalaryChange(app: FastifyInstance, req: FastifyRequest | null, p: Principal, id: string, opts: { overrideBudget?: boolean } = {}): Promise<void> {
  const db = app.db;
  const policy = await loadPolicy(db);
  const c = await db.selectFrom('salary_changes').selectAll().where('id', '=', id).executeTakeFirst();
  if (!c) throw notFound('Salary change', id);
  if (c.status !== 'DRAFT') throw unprocessable(`Salary change is ${c.status}; only DRAFT changes can be submitted`);
  if (c.requested_by !== p.userId && !p.permissions.has('compensation:propose')) throw forbidden();
  const promo = c.promotion_request_id ? await db.selectFrom('promotion_requests').selectAll().where('id', '=', c.promotion_request_id).executeTakeFirstOrThrow() : null;
  // Re-validate against the current state (salary may have changed since the draft).
  const profile = await loadProfile(db, policy, c.employee_id);
  if (profile.currentSalary !== Number(c.old_salary)) throw unprocessable(`The employee's salary changed since this draft was prepared (${c.old_salary} → ${profile.currentSalary}). Cancel it and create a new one.`);
  const year = Number(c.effective_date.slice(0, 4));
  if (c.change_type === 'ANNUAL_INCREMENT' && !c.duplicate_override) { const dup = await findAnnualDuplicate(db, c.employee_id, year, c.id); if (dup) throw conflict(dup.message, { reference: dup.reference }); }
  const violations = await checkBudgets(db, policy, { employeeId: c.employee_id, departmentId: profile.departmentId, siteId: profile.siteId, gradeId: c.new_grade_id, changeType: c.change_type, annualCost: Number(c.annual_cost) }, year, c.id);
  let budgetOverride = c.budget_override;
  if (violations.length && policy.budgetEnforcement === 'BLOCK' && !budgetOverride) {
    if (!opts.overrideBudget) throw new AppError(422, 'BUDGET_EXCEEDED', `Budget "${violations[0]!.name}" would be exceeded by ${violations[0]!.exceededBy}`, { violations });
    if (!p.permissions.has('compensation:override') || !c.justification) throw forbidden('Exceeding the budget needs compensation:override and a justification on the change');
    budgetOverride = true;
  }
  const type = c.change_type as ChangeType;
  const gradeChanged = !!c.new_grade_id && c.new_grade_id !== c.old_grade_id;
  const reqType = requestTypeFor(type, gradeChanged);
  const payload: Record<string, any> = {
    compensationChangeId: c.id, changeType: type, newSalary: Number(c.new_salary), salaryBasis: c.salary_basis, ...salaryPayload(c.salary_basis as 'BASIC' | 'GROSS', Number(c.new_salary), await structureLines(db, profile.structureId!)),
    ...(gradeChanged || reqType === 'PROMOTION' ? { gradeId: c.new_grade_id } : {}), ...(c.new_designation_id && c.new_designation_id !== c.old_designation_id ? { designationId: c.new_designation_id } : {}),
    ...(promo?.new_department_id ? { departmentId: promo.new_department_id } : {}), ...(promo ? { promotionRequestId: promo.id, issueLetter: true } : {}),
    contextExtras: { changeType: type, requiresException: c.requires_exception, exceedsMaxBy: Number(c.exceeds_max_by), annualCost: Number(c.annual_cost), increasePct: Number(c.increase_pct), increaseAmount: Number(c.increase_amount), isOverride: c.is_override || c.duplicate_override || budgetOverride },
  };
  const hr = await createHrRequest(app, { type: reqType, employeeId: c.employee_id, title: `${type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase())} — ${profile.name}`, payload, effectiveDate: c.effective_date, reason: c.reason, requestedBy: p.userId, workflowCode: `COMP_${type}`, requireWorkflow: true });
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('salary_changes').set({ status: 'SUBMITTED', hr_request_id: hr.id, submitted_at: new Date(), budget_override: budgetOverride }).where('id', '=', c.id).execute();
    if (promo) await trx.updateTable('promotion_requests').set({ status: 'SUBMITTED', hr_request_id: hr.id, submitted_at: new Date() }).where('id', '=', promo.id).execute();
    await logApproval(trx, { entityType: promo ? 'promotion_request' : 'salary_change', entityId: promo?.id ?? c.id, userId: p.userId, userName: p.displayName, roleCode: primaryRole(p), action: 'SUBMIT', previousStatus: 'DRAFT', newStatus: 'SUBMITTED', comment: hr.requestNo });
    await app.audit(req, { action: promo ? 'compensation.promotion.submit' : 'compensation.change.submit', entityType: promo ? 'promotion_request' : 'salary_change', entityId: promo?.id ?? c.id, newValue: { hrRequestId: hr.id, requestNo: hr.requestNo, workflow: `COMP_${type}`, budgetOverride } }, 'api', trx);
  });
}

/** BASIC basis → newBasic; GROSS basis → fixed earnings scaled so their sum equals the new gross exactly. */
function salaryPayload(basis: 'BASIC' | 'GROSS', newSalary: number, lines: { componentCode: string; amount: number; scalable: boolean }[]): { newBasic?: number; lines?: { componentCode: string; amount: number }[] } {
  if (basis === 'BASIC') return { newBasic: newSalary };
  return { lines: distributeToTotal(lines, newSalary).map((l) => ({ componentCode: l.componentCode, amount: l.amount })) };
}

export async function cancelSalaryChange(app: FastifyInstance, req: FastifyRequest, p: Principal, id: string, reason: string): Promise<void> {
  const c = await app.db.selectFrom('salary_changes').selectAll().where('id', '=', id).executeTakeFirst();
  if (!c) throw notFound('Salary change', id);
  if (!['DRAFT', 'FAILED', ...LIVE_STATUSES].includes(c.status) || (c.status === 'APPROVED')) throw unprocessable(`Salary change is ${c.status} and cannot be cancelled`);
  if (c.requested_by !== p.userId && !p.permissions.has('compensation:propose')) throw forbidden();
  await app.db.transaction().execute(async (trx) => {
    if (c.hr_request_id) {
      const r = await trx.selectFrom('hr_requests').select(['status', 'workflow_instance_id']).where('id', '=', c.hr_request_id).executeTakeFirst();
      if (r && (r.status === 'PENDING' || r.status === 'FAILED')) {
        await trx.updateTable('hr_requests').set({ status: 'CANCELLED', decided_by: p.userId, decided_at: new Date() }).where('id', '=', c.hr_request_id).execute();
        if (r.workflow_instance_id) { await trx.updateTable('workflow_instances').set({ status: 'CANCELLED', completed_at: new Date() }).where('id', '=', r.workflow_instance_id).where('status', 'in', ['PENDING', 'IN_PROGRESS']).execute(); await trx.updateTable('workflow_tasks').set({ status: 'CANCELLED' }).where('instance_id', '=', r.workflow_instance_id).where('status', '=', 'PENDING').execute(); }
      }
    }
    await setChangeStatus(trx, c.id, 'CANCELLED');
    await logApproval(trx, { entityType: c.promotion_request_id ? 'promotion_request' : 'salary_change', entityId: c.promotion_request_id ?? c.id, userId: p.userId, userName: p.displayName, roleCode: primaryRole(p), action: 'CANCEL', previousStatus: c.status, newStatus: 'CANCELLED', comment: reason });
    await app.audit(req, { action: 'compensation.change.cancel', entityType: 'salary_change', entityId: c.id, oldValue: { status: c.status }, newValue: { status: 'CANCELLED' }, reason }, 'api', trx);
  });
}

// ───────────────────────── Promotions ─────────────────────────
export interface PromotionInput { employeeId: string; newGradeId: string; newDesignationId?: string | null; newDepartmentId?: string | null; newSalary?: number | null; effectiveDate: string; justification?: string | null }
export async function evaluatePromotion(db: Kysely<DB>, input: PromotionInput, policy?: CompensationPolicy) {
  policy ??= await loadPolicy(db);
  const profile = await loadProfile(db, policy, input.employeeId);
  if (!(WORKING_STATUSES as readonly string[]).includes(profile.status)) throw unprocessable(`Employee is ${profile.status} — cannot be promoted`);
  if (profile.currentSalary === null) throw unprocessable('Employee has no salary structure');
  const [from, to] = await Promise.all([profile.gradeId ? db.selectFrom('grades').select(['id', 'code', 'sort_order']).where('id', '=', profile.gradeId).executeTakeFirst() : null, db.selectFrom('grades').select(['id', 'code', 'sort_order', 'status']).where('id', '=', input.newGradeId).where('deleted_at', 'is', null).executeTakeFirst()]);
  if (!to) throw notFound('Grade', input.newGradeId);
  const blockers: string[] = [];
  if (to.id === profile.gradeId && (!input.newDesignationId || input.newDesignationId === profile.designationId)) blockers.push('A promotion needs a new grade or job title');
  if (from && to.sort_order < from.sort_order) blockers.push(`Target grade ${to.code} is below the current grade ${from.code} — use a demotion adjustment / grade change`);
  const band = await bandFor(db, to.id, input.effectiveDate);
  const rules: PromotionRule[] = (await db.selectFrom('promotion_salary_rules').selectAll().where('is_active', '=', true).execute()).map((r) => ({ id: r.id, fromGradeId: r.from_grade_id, toGradeId: r.to_grade_id, priority: r.priority, method: r.method as PromotionRule['method'], value: Number(r.value), minIncreasePct: r.min_increase_pct === null ? null : Number(r.min_increase_pct), maxIncreasePct: r.max_increase_pct === null ? null : Number(r.max_increase_pct), capAtMax: r.cap_at_max }));
  const rule = selectPromotionRule(rules, profile.gradeId, to.id);
  let rec;
  try { rec = calculatePromotionSalary(profile.currentSalary, asBand(band), rule, profile.currency); } catch (e) { throw unprocessable((e as Error).message); }
  const newSalary = round2(input.newSalary ?? rec.recommendedSalary);
  const alerts = input.newSalary !== undefined && input.newSalary !== null ? promotionSalaryAlerts(profile.currentSalary, newSalary, asBand(band), profile.currency) : rec.alerts;
  const requiresException = !!band && newSalary > band.max;
  const overrideReasons: string[] = [];
  if (newSalary < profile.currentSalary) overrideReasons.push('Promotion salary is lower than the current salary');
  const pct = profile.currentSalary > 0 ? round2(((newSalary - profile.currentSalary) / profile.currentSalary) * 100) : 0;
  if (pct > policy.maxIncreasePctWithoutOverride) overrideReasons.push(`Promotion increase ${pct}% exceeds the policy maximum of ${policy.maxIncreasePctWithoutOverride}% without override`);
  const cost = annualCost(round2(newSalary - profile.currentSalary), policy.annualizationMonths);
  const budgetViolations = await checkBudgets(db, policy, { employeeId: profile.employeeId, departmentId: input.newDepartmentId ?? profile.departmentId, siteId: profile.siteId, gradeId: to.id, changeType: 'PROMOTION', annualCost: cost }, Number(input.effectiveDate.slice(0, 4)));
  for (const v of budgetViolations) alerts.push({ code: 'BUDGET_EXCEEDED', severity: policy.budgetEnforcement === 'BLOCK' ? 'CRITICAL' : 'WARNING', message: `Budget "${v.name}" would be exceeded by ${v.exceededBy}`, amount: v.exceededBy });
  return { profile, band, targetGrade: to, rule, recommended: rec, newSalary, increaseAmount: round2(newSalary - profile.currentSalary), increasePct: pct, position: band ? bandPosition(newSalary, band) : null, alerts, requiresException, overrideReasons, budgetViolations, annualCost: cost, blockers };
}

export async function createPromotion(app: FastifyInstance, req: FastifyRequest, p: Principal, input: PromotionInput & { promotionReason: string; managerRecommendation?: string | null; hrComments?: string | null; submit?: boolean; overrideBudget?: boolean }): Promise<string> {
  const policy = await loadPolicy(app.db);
  const ev = await evaluatePromotion(app.db, input, policy);
  if (ev.blockers.length) throw new AppError(422, 'COMPENSATION_BLOCKED', ev.blockers[0]!, { blockers: ev.blockers });
  const justified = !!input.justification?.trim();
  if (ev.requiresException && !justified) throw unprocessable(`Promotion salary exceeds the new grade maximum by ${round2(ev.newSalary - ev.band!.max)} — a justification is required for the exception`);
  if (ev.overrideReasons.length) { if (!p.permissions.has('compensation:override')) throw forbidden(`${ev.overrideReasons[0]} — compensation:override is required`); if (!justified) throw unprocessable(`${ev.overrideReasons[0]} — a justification is required`); }
  const pr = ev.profile;
  const promoId = await app.db.transaction().execute(async (trx) => {
    const promo = await trx.insertInto('promotion_requests').values({
      promotion_no: await nextCompNo(trx, 'PR'), employee_id: pr.employeeId, current_designation_id: pr.designationId, current_grade_id: pr.gradeId, current_salary: pr.currentSalary!, new_designation_id: input.newDesignationId ?? pr.designationId, new_grade_id: ev.targetGrade.id,
      new_department_id: input.newDepartmentId ?? null, recommended_salary: ev.recommended.recommendedSalary, new_salary: ev.newSalary, salary_basis: pr.salaryBasis, currency: pr.currency, rule_id: ev.rule?.id ?? null, rule_explanation: ev.recommended.explanation,
      effective_date: input.effectiveDate, promotion_reason: input.promotionReason, performance_rating_code: pr.ratingCode, performance_score: pr.ratingScore, manager_recommendation: input.managerRecommendation ?? null, hr_comments: input.hrComments ?? null,
      justification: input.justification?.trim() || null, alerts: JSON.stringify(ev.alerts), requested_by: p.userId,
    }).returning(['id', 'promotion_no']).executeTakeFirstOrThrow();
    const ch = await trx.insertInto('salary_changes').values({
      change_no: await nextCompNo(trx, 'SC'), employee_id: pr.employeeId, change_type: 'PROMOTION', status: 'DRAFT', source: 'PROMOTION', salary_basis: pr.salaryBasis, currency: pr.currency,
      old_salary: pr.currentSalary!, increase_amount: ev.increaseAmount, increase_pct: ev.increasePct, new_salary: ev.newSalary, old_basic: pr.basicSalary, old_gross: pr.grossSalary, annual_cost: ev.annualCost,
      effective_date: input.effectiveDate, reason: input.promotionReason, comments: input.hrComments ?? null, justification: input.justification?.trim() || null,
      old_grade_id: pr.gradeId, new_grade_id: ev.targetGrade.id, old_designation_id: pr.designationId, new_designation_id: input.newDesignationId ?? pr.designationId,
      band_id: ev.band?.id ?? null, band_min: ev.band?.min ?? null, band_mid: ev.band?.mid ?? null, band_max: ev.band?.max ?? null, compa_before: pr.compaRatio, compa_after: ev.position?.compaRatio ?? null,
      exceeds_max_by: ev.band ? Math.max(0, round2(ev.newSalary - ev.band.max)) : 0, ceiling_action: ev.requiresException ? 'REQUEST_EXCEPTION' : null, requires_exception: ev.requiresException,
      is_override: ev.overrideReasons.length > 0, alerts: JSON.stringify(ev.alerts), promotion_request_id: promo.id, requested_by: p.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.updateTable('promotion_requests').set({ salary_change_id: ch.id }).where('id', '=', promo.id).execute();
    await logApproval(trx, { entityType: 'promotion_request', entityId: promo.id, userId: p.userId, userName: p.displayName, roleCode: primaryRole(p), action: 'CREATE', previousStatus: null, newStatus: 'DRAFT', comment: input.promotionReason });
    await app.audit(req, { action: 'compensation.promotion.create', entityType: 'promotion_request', entityId: promo.id, newValue: { promotionNo: promo.promotion_no, employeeId: pr.employeeId, fromGrade: pr.gradeCode, toGrade: ev.targetGrade.code, oldSalary: pr.currentSalary, newSalary: ev.newSalary, recommended: ev.recommended.recommendedSalary } }, 'api', trx);
    return { promoId: promo.id, changeId: ch.id };
  });
  if (input.submit) await submitSalaryChange(app, req, p, promoId.changeId, { overrideBudget: input.overrideBudget });
  return promoId.promoId;
}

// ───────────────────────── Apply on final approval ─────────────────────────
/**
 * Apply an approved compensation-linked HR request atomically. Called by applyHrRequest (approval hook or manual re-apply).
 * Steps: validate employee → band → duplicate → stale salary → budget → refresh salary lines → apply HR request
 * (salary version + history + timeline) → complete ledger row → approval trail → audit. Any failure rolls everything back.
 */
export async function applyCompensationRequest(app: FastifyInstance, requestId: string, actorUserId: string): Promise<{ status: string; result: Record<string, unknown> | null; error?: string }> {
  const db = app.db;
  const r = await db.selectFrom('hr_requests').selectAll().where('id', '=', requestId).executeTakeFirstOrThrow();
  const changeId = (r.payload as any).compensationChangeId as string;
  const pre = await db.selectFrom('salary_changes').select(['status', 'promotion_request_id']).where('id', '=', changeId).executeTakeFirstOrThrow();
  if (pre.status === 'COMPLETED') return { status: 'APPLIED', result: r.result as Record<string, unknown> | null };
  let result: Record<string, unknown> | null = null;
  try {
    result = await db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('salary_changes').selectAll().where('id', '=', changeId).forUpdate().executeTakeFirstOrThrow();
      const emp = await trx.selectFrom('employees').select(['id', 'status', 'grade_id', 'deleted_at']).where('id', '=', c.employee_id).forUpdate().executeTakeFirstOrThrow();
      const policy = await loadPolicy(trx);
      // 1. employee
      if (emp.deleted_at || !(WORKING_STATUSES as readonly string[]).includes(emp.status)) throw unprocessable(`Employee is ${emp.status}`);
      // 2. band — never silently exceed the maximum
      const band = await bandFor(trx, c.new_grade_id ?? emp.grade_id, c.effective_date);
      if (band && Number(c.new_salary) > band.max + 0.004 && !c.requires_exception) throw unprocessable(`New salary exceeds the band maximum (${band.max}) and no exception was requested`);
      // 3. duplicate
      if (c.change_type === 'ANNUAL_INCREMENT' && !c.duplicate_override) { const dup = await findAnnualDuplicate(trx, c.employee_id, c.effective_year, c.id); if (dup) throw conflict(dup.message); }
      // 4. stale salary
      const cur = await trx.selectFrom('employee_salary_structures').select(['id', 'basic_salary', 'gross_salary']).where('employee_id', '=', c.employee_id).orderBy('version', 'desc').executeTakeFirstOrThrow();
      const curSalary = Number(c.salary_basis === 'GROSS' ? cur.gross_salary : cur.basic_salary);
      if (Math.abs(curSalary - Number(c.old_salary)) > 0.004) throw unprocessable(`Salary changed since the request was raised (${c.old_salary} → ${curSalary}); cancel and raise a new request`);
      // 5. budget (approved cost + this)
      const e2 = await trx.selectFrom('employees').select(['department_id', 'site_id']).where('id', '=', c.employee_id).executeTakeFirstOrThrow();
      const violations = await checkBudgets(trx, policy, { employeeId: c.employee_id, departmentId: e2.department_id, siteId: e2.site_id, gradeId: c.new_grade_id, changeType: c.change_type, annualCost: Number(c.annual_cost) }, c.effective_year, c.id);
      if (violations.length && policy.budgetEnforcement === 'BLOCK' && !c.budget_override) throw unprocessable(`Budget "${violations[0]!.name}" would be exceeded by ${violations[0]!.exceededBy}`);
      // 6. salary lines against the structure in force now
      const payload = { ...(r.payload as Record<string, any>), ...salaryPayload(c.salary_basis as 'BASIC' | 'GROSS', Number(c.new_salary), await structureLines(trx, cur.id)) };
      if (c.salary_basis === 'BASIC') delete payload.lines; else delete payload.newBasic;
      await trx.updateTable('hr_requests').set({ payload: JSON.stringify(payload), status: 'APPROVED' }).where('id', '=', requestId).execute();
      // 7. HR request side effects (salary version, employment history, timeline, request audit)
      const applied = await applyHrRequest(app, requestId, actorUserId, { trx });
      const structureId = (applied.result as any)?.salaryStructureId as string | undefined;
      if (!structureId) throw unprocessable('No salary version was created');
      const s = await trx.selectFrom('employee_salary_structures').select(['basic_salary', 'gross_salary']).where('id', '=', structureId).executeTakeFirstOrThrow();
      // 8. ledger + promotion
      const approvedBy = c.approved_by ?? r.decided_by ?? actorUserId;
      await setChangeStatus(trx, c.id, 'COMPLETED', { salary_structure_id: structureId, new_basic: Number(s.basic_salary), new_gross: Number(s.gross_salary), old_basic: Number(cur.basic_salary), old_gross: Number(cur.gross_salary), approved_by: approvedBy, approved_at: c.approved_at ?? new Date(), completed_at: new Date(), apply_error: null, budget_override: c.budget_override });
      // 9. trail + audit
      await logApproval(trx, { entityType: c.promotion_request_id ? 'promotion_request' : 'salary_change', entityId: c.promotion_request_id ?? c.id, userId: actorUserId, action: 'COMPLETE', previousStatus: c.status, newStatus: 'COMPLETED', comment: r.request_no });
      await app.audit(null, { action: 'compensation.change.completed', entityType: 'salary_change', entityId: c.id, oldValue: { salary: Number(c.old_salary), basic: Number(cur.basic_salary), gross: Number(cur.gross_salary), gradeId: c.old_grade_id }, newValue: { salary: Number(c.new_salary), basic: Number(s.basic_salary), gross: Number(s.gross_salary), gradeId: c.new_grade_id, structureId }, reason: c.reason, approvalRef: r.workflow_instance_id, metadata: { changeNo: c.change_no, type: c.change_type, employeeId: c.employee_id, requestNo: r.request_no } }, 'api', trx);
      return applied.result;
    });
  } catch (e) {
    const msg = (e as Error).message;
    await db.updateTable('hr_requests').set({ status: 'FAILED', apply_error: msg }).where('id', '=', requestId).execute();
    const c = await db.selectFrom('salary_changes').select(['status', 'promotion_request_id']).where('id', '=', changeId).executeTakeFirstOrThrow();
    await db.updateTable('salary_changes').set({ status: 'FAILED', apply_error: msg }).where('id', '=', changeId).execute();
    if (c.promotion_request_id) await db.updateTable('promotion_requests').set({ status: 'FAILED' }).where('id', '=', c.promotion_request_id).execute();
    await logApproval(db, { entityType: c.promotion_request_id ? 'promotion_request' : 'salary_change', entityId: c.promotion_request_id ?? changeId, userId: actorUserId, action: 'FAIL', previousStatus: c.status, newStatus: 'FAILED', comment: msg });
    await app.audit(null, { action: 'compensation.change.failed', entityType: 'salary_change', entityId: changeId, newValue: { error: msg }, metadata: { requestId } });
    return { status: 'FAILED', result: null, error: msg };
  }
  // Post-commit: promotion letter (best effort, never rolls back the salary change)
  if (pre.promotion_request_id && (r.payload as any).issueLetter !== false) {
    try {
      const { issueLetter } = await import('../letters/routes.js');
      const ch = ((result as any)?.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const l = await issueLetter(app, { employeeId: r.employee_id, templateCode: 'PROMOTION_LETTER', userId: actorUserId, hrRequestId: requestId, change: { ...ch, effectiveDate: r.effective_date } });
      result = { ...(result ?? {}), letterId: l.id, letterNo: l.letterNo };
      await db.updateTable('hr_requests').set({ result: JSON.stringify(result) }).where('id', '=', requestId).execute();
    } catch { /* letter template missing: salary change stands */ }
  }
  return { status: 'APPLIED', result };
}
