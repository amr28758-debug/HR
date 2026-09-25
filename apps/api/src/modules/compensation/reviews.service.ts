import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { annualCost, budgetUsage, calculateIncrease, evaluateEligibility, recommendMeritIncrease, round2, type CeilingAction, type EligibilityRules } from '@burtplace/core';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../plugins/errors.js';
import type { Principal } from '../../plugins/auth.js';
import { applyHrRequest, nextRequestNo, snapshotEmployee } from '../hr-requests/service.js';
import { previewWorkflow, startWorkflow } from '../workflows/service.js';
import { asBand, bandFor, LIVE_STATUSES, loadProfiles, nextCompNo, structureLines, WORKING_STATUSES, type BandRow } from './data.js';
import { loadPolicy } from './policy.js';
import { budgetApplies, defaultMeritCells, findAnnualDuplicate, loadCostLines, logApproval, type CostLine } from './service.js';
import { distributeToTotal } from '@burtplace/core';

/**
 * Annual salary review cycles (table salary_reviews, formerly increment_cycles).
 *   DRAFT → populate (eligibility rules + merit matrix/default % + band ceiling handling) → HR edits items (overrides need
 *   compensation:override + justification) → submit (workflow COMP_SALARY_REVIEW, never auto-approved) → HR/Finance/Management
 *   decisions mirrored as statuses → on final approval every item is applied in its own transaction (idempotent, resumable) → COMPLETED.
 */
export interface ReviewInput {
  name: string; year: number; effectiveDate: string; reviewPeriodStart?: string | null; reviewPeriodEnd?: string | null;
  defaultPercentage: number; maxPercentage?: number | null; budgetAmount?: number | null; currency?: string;
  eligibilityRules: EligibilityRules; recommendationMethod: 'DEFAULT_PERCENT' | 'MERIT_MATRIX'; meritMatrixId?: string | null; performanceCycleId?: string | null;
  defaultCeilingAction?: CeilingAction | null; notes?: string | null; scenarioId?: string | null;
}
const EDITABLE = ['DRAFT'];

export async function createReview(app: FastifyInstance, req: FastifyRequest, p: Principal, b: ReviewInput): Promise<string> {
  if (Number(b.effectiveDate.slice(0, 4)) !== b.year) throw unprocessable('The effective date must fall in the review year');
  if (b.maxPercentage !== null && b.maxPercentage !== undefined && b.maxPercentage < b.defaultPercentage) throw unprocessable('Maximum increase % must be ≥ the default %');
  const r = await app.db.insertInto('salary_reviews').values({
    name: b.name, cycle_year: b.year, effective_date: b.effectiveDate, review_period_start: b.reviewPeriodStart ?? null, review_period_end: b.reviewPeriodEnd ?? null, default_percentage: b.defaultPercentage, max_percentage: b.maxPercentage ?? null,
    budget_amount: b.budgetAmount ?? null, currency: b.currency ?? 'AED', eligibility_rules: JSON.stringify(b.eligibilityRules ?? {}), recommendation_method: b.recommendationMethod, merit_matrix_id: b.meritMatrixId ?? null,
    performance_cycle_id: b.performanceCycleId ?? null, default_ceiling_action: b.defaultCeilingAction ?? null, notes: b.notes ?? null, scenario_id: b.scenarioId ?? null, filters: JSON.stringify({}), created_by: p.userId, status: 'DRAFT',
  }).returning('id').executeTakeFirstOrThrow();
  await logApproval(app.db, { entityType: 'salary_review', entityId: r.id, userId: p.userId, userName: p.displayName, action: 'CREATE', previousStatus: null, newStatus: 'DRAFT', comment: b.name });
  await app.audit(req, { action: 'compensation.review.create', entityType: 'salary_review', entityId: r.id, newValue: b });
  return r.id;
}

export async function getReviewRow(db: Kysely<DB>, id: string) {
  const r = await db.selectFrom('salary_reviews').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!r) throw notFound('Salary review', id);
  return r;
}

/** (Re)build the review's items from the current workforce. Only in DRAFT. `pctOverrides` (from scenarios) replace the recommendation. */
export async function populateReview(app: FastifyInstance, req: FastifyRequest | null, p: Principal, id: string, pctOverrides?: Map<string, number>): Promise<{ items: number; eligible: number; ineligible: number }> {
  const db = app.db;
  const r = await getReviewRow(db, id);
  if (!EDITABLE.includes(r.status)) throw unprocessable(`Review is ${r.status}; items can only be (re)generated in DRAFT`);
  const policy = await loadPolicy(db);
  const rules = (r.eligibility_rules ?? {}) as EligibilityRules;
  const profiles = await loadProfiles(db, policy, { departmentIds: rules.departmentIds ?? undefined, siteIds: rules.siteIds ?? undefined, gradeIds: rules.gradeIds ?? undefined, designationIds: rules.designationIds ?? undefined, performanceCycleId: r.performance_cycle_id }, r.effective_date);
  const cells = r.recommendation_method === 'MERIT_MATRIX' ? await defaultMeritCells(db, r.merit_matrix_id) : [];
  const bands = new Map<string, BandRow | null>();
  for (const g of new Set(profiles.map((x) => x.gradeId).filter(Boolean) as string[])) bands.set(g, await bandFor(db, g, r.effective_date));
  const inOtherReview = new Set((await db.selectFrom('salary_review_items as i').innerJoin('salary_reviews as s', 's.id', 'i.cycle_id').select('i.employee_id').where('s.id', '<>', id).where('s.deleted_at', 'is', null).where('s.status', 'not in', ['REJECTED', 'CANCELLED', 'COMPLETED'])
    .where('i.status', 'in', ['PROPOSED', 'APPROVED']).where('i.eligible', '=', true).where((eb) => eb.fn('date_part', [eb.val('year'), eb.ref('s.effective_date')]), '=', r.cycle_year).execute()).map((x) => x.employee_id));
  const rows = profiles.map((pr) => {
    const band = pr.gradeId ? bands.get(pr.gradeId) ?? null : null;
    const el = evaluateEligibility(rules, { joiningDate: pr.joiningDate, lastIncreaseDate: pr.lastIncreaseDate, status: pr.status, employmentType: pr.employmentType, ratingScore: pr.ratingScore, ratingCode: pr.ratingCode, lastDisciplinaryDate: pr.lastDisciplinaryDate, onProbation: pr.onProbation, departmentId: pr.departmentId, gradeId: pr.gradeId, siteId: pr.siteId, designationId: pr.designationId, hasSalary: pr.currentSalary !== null }, r.effective_date);
    if (pr.annualIncrementYears.includes(r.cycle_year)) el.reasons.push(`Annual increase already processed for ${r.cycle_year}`);
    if (inOtherReview.has(pr.employeeId)) el.reasons.push(`Already included in another ${r.cycle_year} salary review`);
    const eligible = el.reasons.length === 0;
    const cur = pr.currentSalary ?? 0;
    const compa = band && band.mid > 0 ? round2((cur / band.mid) * 100) : null;
    const cell = cells.length ? recommendMeritIncrease(cells, pr.ratingCode, compa) : null;
    const recommended = pctOverrides?.get(pr.employeeId) ?? (r.recommendation_method === 'MERIT_MATRIX' ? cell?.recommendedPct ?? 0 : Number(r.default_percentage));
    const calc = eligible ? calculateIncrease({ currentSalary: cur, band: asBand(band), increasePct: recommended, ceilingAction: (r.default_ceiling_action as CeilingAction | null) ?? null, allowedCeilingActions: policy.ceilingActions, maxIncreasePct: r.max_percentage === null ? null : Number(r.max_percentage) }) : null;
    const inc = calc?.finalIncreaseAmount ?? 0;
    const basic = pr.basicSalary ?? 0, gross = pr.grossSalary ?? 0;
    return {
      cycle_id: id, employee_id: pr.employeeId, current_basic: basic, current_gross: gross, performance_rating: pr.ratingScore, grade_code: pr.gradeCode, grade_id: pr.gradeId, department_id: pr.departmentId, site_id: pr.siteId, designation_id: pr.designationId,
      salary_basis: pr.salaryBasis, current_salary: cur, band_min: band?.min ?? null, band_mid: band?.mid ?? null, band_max: band?.max ?? null, compa_ratio: compa, range_penetration: calc?.before?.rangePenetration ?? pr.rangePenetration, rating_code: pr.ratingCode,
      eligible, ineligibility_reasons: JSON.stringify(el.reasons), recommended_pct: eligible ? recommended : null, matrix_max_pct: cell?.maxPct ?? null,
      proposed_percentage: calc?.finalIncreasePct ?? 0, proposed_amount: inc, proposed_salary: calc?.proposedSalary ?? cur, final_salary: calc?.finalSalary ?? cur,
      new_basic: pr.salaryBasis === 'BASIC' ? round2(basic + inc) : gross > 0 ? round2(basic * ((gross + inc) / gross)) : basic, new_gross: round2(gross + inc),
      exceeds_max_by: calc?.exceedsMaxBy ?? 0, ceiling_action: calc?.ceilingAction ?? null, outcome: calc?.outcome ?? null, requires_exception: calc?.requiresException ?? false, alerts: JSON.stringify(calc?.alerts ?? []),
      status: eligible ? 'PROPOSED' : 'INELIGIBLE',
    };
  });
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('salary_review_items').where('cycle_id', '=', id).execute();
    for (let i = 0; i < rows.length; i += 200) if (rows.slice(i, i + 200).length) await trx.insertInto('salary_review_items').values(rows.slice(i, i + 200)).execute();
    await app.audit(req, { action: 'compensation.review.populate', entityType: 'salary_review', entityId: id, newValue: { items: rows.length, eligible: rows.filter((x) => x.eligible).length } }, 'api', trx);
  });
  return { items: rows.length, eligible: rows.filter((x) => x.eligible).length, ineligible: rows.filter((x) => !x.eligible).length };
}

export interface ItemEdit { id: string; percentage?: number; amount?: number; newSalary?: number; ceilingAction?: CeilingAction | null; status?: 'PROPOSED' | 'EXCLUDED'; note?: string; justification?: string }
export async function updateReviewItems(app: FastifyInstance, req: FastifyRequest, p: Principal, id: string, edits: ItemEdit[]): Promise<number> {
  const db = app.db;
  const r = await getReviewRow(db, id);
  if (!EDITABLE.includes(r.status)) throw unprocessable(`Review is ${r.status}; items can only be edited in DRAFT`);
  const policy = await loadPolicy(db);
  const canOverride = p.permissions.has('compensation:override');
  let n = 0;
  await db.transaction().execute(async (trx) => {
    for (const e of edits) {
      const x = await trx.selectFrom('salary_review_items').selectAll().where('id', '=', e.id).where('cycle_id', '=', id).executeTakeFirst();
      if (!x) throw notFound('Review item', e.id);
      const patch: Record<string, unknown> = {};
      const overrideNeeded: string[] = [];
      let status = x.status;
      if (e.status) {
        if (x.status === 'INELIGIBLE' && e.status === 'PROPOSED') overrideNeeded.push(`Including an ineligible employee (${(x.ineligibility_reasons as string[]).join('; ')})`);
        status = e.status; patch.status = e.status;
      }
      if (e.percentage !== undefined || e.amount !== undefined || e.newSalary !== undefined || e.ceilingAction !== undefined) {
        const cur = Number(x.current_salary);
        const band = x.band_max === null ? null : { min: Number(x.band_min), mid: Number(x.band_mid), max: Number(x.band_max) };
        const input = e.percentage !== undefined ? { increasePct: e.percentage } : e.amount !== undefined ? { increaseAmount: e.amount } : e.newSalary !== undefined ? { newSalary: e.newSalary } : { increasePct: Number(x.recommended_pct ?? x.proposed_percentage) };
        let calc;
        try { calc = calculateIncrease({ currentSalary: cur, band, ...input, ceilingAction: e.ceilingAction === undefined ? (x.ceiling_action as CeilingAction | null) : e.ceilingAction, allowedCeilingActions: policy.ceilingActions, maxIncreasePct: r.max_percentage === null ? null : Number(r.max_percentage) }); }
        catch (err) { throw unprocessable((err as Error).message); }
        if (calc.finalIncreaseAmount < 0) throw unprocessable('A salary review cannot decrease salaries — use a salary correction');
        if (calc.exceedsMaxIncreasePct) overrideNeeded.push(`Increase ${calc.finalIncreasePct}% exceeds the review maximum ${r.max_percentage}%`);
        if (x.matrix_max_pct !== null && calc.finalIncreasePct > Number(x.matrix_max_pct)) overrideNeeded.push(`Increase ${calc.finalIncreasePct}% exceeds the merit-matrix maximum ${x.matrix_max_pct}%`);
        if (calc.requiresException && !(e.justification ?? x.override_justification)) throw unprocessable('A justification is required to request a salary-band exception');
        const basic = Number(x.current_basic), gross = Number(x.current_gross), inc = calc.finalIncreaseAmount;
        Object.assign(patch, { proposed_percentage: calc.finalIncreasePct, proposed_amount: inc, proposed_salary: calc.proposedSalary, final_salary: calc.finalSalary, exceeds_max_by: calc.exceedsMaxBy, ceiling_action: calc.ceilingAction, outcome: calc.outcome, requires_exception: calc.requiresException, alerts: JSON.stringify(calc.alerts),
          new_basic: x.salary_basis === 'BASIC' ? round2(basic + inc) : gross > 0 ? round2(basic * ((gross + inc) / gross)) : basic, new_gross: round2(gross + inc) });
      }
      if (overrideNeeded.length && status !== 'EXCLUDED') {
        if (!canOverride) throw forbidden(`${overrideNeeded[0]} — compensation:override is required`);
        if (!e.justification?.trim()) throw unprocessable(`${overrideNeeded[0]} — a justification is required`);
        if (x.status === 'INELIGIBLE' && e.status === 'PROPOSED') patch.eligible = true;
      }
      if (e.justification?.trim()) { patch.override_justification = e.justification.trim(); patch.overridden_by = p.userId; }
      if (e.note !== undefined) patch.note = e.note;
      if (Object.keys(patch).length) { await trx.updateTable('salary_review_items').set(patch).where('id', '=', x.id).execute(); n++; }
    }
    await app.audit(req, { action: 'compensation.review.items.edit', entityType: 'salary_review', entityId: id, newValue: { edits } }, 'api', trx);
  });
  return n;
}

export interface ReviewSummary { items: number; proposed: number; excluded: number; ineligible: number; completed: number; failed: number; actionRequired: number; exceptions: number; aboveMax: number; currentPayroll: number; monthlyIncrease: number; annualIncrease: number; averagePct: number; budget: number | null; remaining: number | null; utilizationPct: number | null }
export async function reviewSummary(db: Kysely<DB>, id: string, budget: number | null): Promise<ReviewSummary> {
  const policy = await loadPolicy(db);
  const items = await db.selectFrom('salary_review_items').select(['status', 'outcome', 'requires_exception', 'exceeds_max_by', 'current_gross', 'proposed_amount', 'proposed_percentage']).where('cycle_id', '=', id).execute();
  const live = items.filter((i) => ['PROPOSED', 'APPROVED', 'COMPLETED', 'FAILED'].includes(i.status));
  const monthly = round2(live.reduce((s, i) => s + Number(i.proposed_amount), 0));
  const annual = annualCost(monthly, policy.annualizationMonths);
  return {
    items: items.length, proposed: items.filter((i) => i.status === 'PROPOSED' || i.status === 'APPROVED').length, excluded: items.filter((i) => i.status === 'EXCLUDED').length, ineligible: items.filter((i) => i.status === 'INELIGIBLE').length,
    completed: items.filter((i) => i.status === 'COMPLETED').length, failed: items.filter((i) => i.status === 'FAILED').length,
    actionRequired: live.filter((i) => i.outcome === 'ACTION_REQUIRED').length, exceptions: live.filter((i) => i.requires_exception).length, aboveMax: live.filter((i) => Number(i.exceeds_max_by) > 0).length,
    currentPayroll: round2(live.reduce((s, i) => s + Number(i.current_gross), 0)), monthlyIncrease: monthly, annualIncrease: annual,
    averagePct: live.length ? round2(live.reduce((s, i) => s + Number(i.proposed_percentage), 0) / live.length) : 0,
    budget, remaining: budget === null ? null : round2(budget - annual), utilizationPct: budget ? round2((annual / budget) * 100) : null,
  };
}

/** Company/department/grade/site budgets that this review (on top of already-approved spend) would exceed. */
async function reviewBudgetViolations(db: Kysely<DB>, id: string, year: number): Promise<{ name: string; exceededBy: number }[]> {
  const policy = await loadPolicy(db);
  if (policy.budgetEnforcement === 'OFF') return [];
  const budgets = await db.selectFrom('compensation_budgets').selectAll().where('fiscal_year', '=', year).where('status', '=', 'ACTIVE').where('deleted_at', 'is', null).execute();
  if (!budgets.length) return [];
  const others = (await loadCostLines(db, year, policy.annualizationMonths)).filter((l) => l.approved);
  const mine: CostLine[] = (await db.selectFrom('salary_review_items as i').select(['i.id', 'i.employee_id', 'i.department_id', 'i.site_id', 'i.grade_id', 'i.proposed_amount']).where('i.cycle_id', '=', id).where('i.status', 'in', ['PROPOSED', 'APPROVED', 'FAILED']).where('i.salary_change_id', 'is', null).execute())
    .map((i) => ({ employeeId: i.employee_id, departmentId: i.department_id, siteId: i.site_id, gradeId: i.grade_id, changeType: 'ANNUAL_INCREMENT', annualCost: annualCost(Number(i.proposed_amount), policy.annualizationMonths), approved: true, sourceId: i.id }));
  const otherLines = others.filter((l) => !mine.some((m) => m.sourceId === l.sourceId));
  return budgets.map((b) => { const u = budgetUsage(Number(b.amount), 0, [...otherLines, ...mine].filter((l) => budgetApplies(b as any, l)).reduce((s, l) => s + l.annualCost, 0)); return { name: b.name, exceededBy: round2(u.approvedCost - u.allocated) }; }).filter((v) => v.exceededBy > 0.004);
}

export async function submitReview(app: FastifyInstance, req: FastifyRequest, p: Principal, id: string): Promise<void> {
  const db = app.db;
  const r = await getReviewRow(db, id);
  if (r.status !== 'DRAFT') throw unprocessable(`Review is ${r.status}; only DRAFT reviews can be submitted`);
  const s = await reviewSummary(db, id, r.budget_amount === null ? null : Number(r.budget_amount));
  if (!s.proposed) throw unprocessable('The review has no proposed items — populate it first');
  if (s.actionRequired) throw new AppError(422, 'COMPENSATION_BLOCKED', `${s.actionRequired} employee(s) exceed the salary band maximum without a decision — choose cap, exception, cancel or grade change for each`, { actionRequired: s.actionRequired });
  const policy = await loadPolicy(db);
  if (s.budget !== null && s.annualIncrease > s.budget + 0.004 && policy.budgetEnforcement === 'BLOCK') throw new AppError(422, 'BUDGET_EXCEEDED', `Review cost ${s.annualIncrease} exceeds its budget ${s.budget} by ${round2(s.annualIncrease - s.budget)}`);
  const viol = await reviewBudgetViolations(db, id, r.cycle_year);
  if (viol.length && policy.budgetEnforcement === 'BLOCK') throw new AppError(422, 'BUDGET_EXCEEDED', `Budget "${viol[0]!.name}" would be exceeded by ${viol[0]!.exceededBy}`, { violations: viol });
  const ctx = { reviewId: id, reviewName: r.name, employees: s.proposed, annualCost: s.annualIncrease, monthlyIncrease: s.monthlyIncrease, exceptions: s.exceptions, requiresException: s.exceptions > 0, averagePct: s.averagePct };
  const preview = await previewWorkflow(db, 'COMP_SALARY_REVIEW', ctx);
  if (!preview || !preview.steps.length) throw unprocessable('No approval workflow is configured for COMP_SALARY_REVIEW — salary reviews are never auto-approved');
  const wf = await startWorkflow(db, { code: 'COMP_SALARY_REVIEW', entityType: 'salary_review', entityId: id, initiatedBy: p.userId, context: ctx });
  await db.updateTable('salary_reviews').set({ status: 'SUBMITTED', submitted_by: p.userId, submitted_at: new Date(), workflow_instance_id: wf, decision_comment: null }).where('id', '=', id).execute();
  await logApproval(db, { entityType: 'salary_review', entityId: id, userId: p.userId, userName: p.displayName, action: 'SUBMIT', previousStatus: 'DRAFT', newStatus: 'SUBMITTED', comment: `${s.proposed} employees · annual cost ${s.annualIncrease}` });
  await app.audit(req, { action: 'compensation.review.submit', entityType: 'salary_review', entityId: id, newValue: { summary: s, workflowInstanceId: wf } });
  void app.queues.add('notifications.deliver', {}).catch(() => undefined);
}

export async function cancelReview(app: FastifyInstance, req: FastifyRequest, p: Principal, id: string, reason: string): Promise<void> {
  const db = app.db;
  const r = await getReviewRow(db, id);
  if (['COMPLETED', 'CANCELLED'].includes(r.status)) throw unprocessable(`Review is ${r.status}`);
  const done = await db.selectFrom('salary_review_items').select('id').where('cycle_id', '=', id).where('status', '=', 'COMPLETED').executeTakeFirst();
  if (done) throw unprocessable('Some items were already applied — the review cannot be cancelled; complete the remaining items instead');
  await db.transaction().execute(async (trx) => {
    if (r.workflow_instance_id) { await trx.updateTable('workflow_instances').set({ status: 'CANCELLED', completed_at: new Date() }).where('id', '=', r.workflow_instance_id).where('status', 'in', ['PENDING', 'IN_PROGRESS']).execute(); await trx.updateTable('workflow_tasks').set({ status: 'CANCELLED' }).where('instance_id', '=', r.workflow_instance_id).where('status', '=', 'PENDING').execute(); }
    await trx.updateTable('salary_review_items').set({ status: 'CANCELLED' }).where('cycle_id', '=', id).where('status', 'in', ['PROPOSED', 'APPROVED', 'FAILED']).execute();
    await trx.updateTable('salary_reviews').set({ status: 'CANCELLED', cancelled_at: new Date(), decision_comment: reason }).where('id', '=', id).execute();
    await logApproval(trx, { entityType: 'salary_review', entityId: id, userId: p.userId, userName: p.displayName, action: 'CANCEL', previousStatus: r.status, newStatus: 'CANCELLED', comment: reason });
    await app.audit(req, { action: 'compensation.review.cancel', entityType: 'salary_review', entityId: id, oldValue: { status: r.status }, newValue: { status: 'CANCELLED' }, reason }, 'api', trx);
  });
}

export async function reopenReview(app: FastifyInstance, req: FastifyRequest, p: Principal, id: string, reason: string): Promise<void> {
  const r = await getReviewRow(app.db, id);
  if (r.status !== 'REJECTED') throw unprocessable('Only a REJECTED review can be reopened for rework');
  await app.db.updateTable('salary_reviews').set({ status: 'DRAFT', workflow_instance_id: null, approved_at: null, approved_by: null }).where('id', '=', id).execute();
  await logApproval(app.db, { entityType: 'salary_review', entityId: id, userId: p.userId, userName: p.displayName, action: 'REOPEN', previousStatus: 'REJECTED', newStatus: 'DRAFT', comment: reason });
  await app.audit(req, { action: 'compensation.review.reopen', entityType: 'salary_review', entityId: id, reason });
}

/** Apply every approved item (each in its own transaction). Idempotent: completed items are skipped; failures can be retried. */
export async function completeReview(app: FastifyInstance, id: string, actorUserId: string): Promise<{ completed: number; failed: { employeeId: string; error: string }[] }> {
  const db = app.db;
  const r = await getReviewRow(db, id);
  if (!r.approved_at || ['CANCELLED', 'REJECTED', 'DRAFT'].includes(r.status)) throw unprocessable(`Review is ${r.status} and not fully approved`);
  const policy = await loadPolicy(db);
  const viol = await reviewBudgetViolations(db, id, r.cycle_year);
  if (viol.length && policy.budgetEnforcement === 'BLOCK') throw new AppError(422, 'BUDGET_EXCEEDED', `Budget "${viol[0]!.name}" would be exceeded by ${viol[0]!.exceededBy} — increase the budget or rework the review`, { violations: viol });
  const items = await db.selectFrom('salary_review_items').selectAll().where('cycle_id', '=', id).where('eligible', '=', true).where('status', 'in', ['PROPOSED', 'APPROVED', 'FAILED']).orderBy('employee_id').execute();
  let completed = 0; const failed: { employeeId: string; error: string }[] = [];
  for (const it of items) {
    try {
      await db.transaction().execute(async (trx) => {
        const emp = await trx.selectFrom('employees').select(['status', 'deleted_at', 'grade_id']).where('id', '=', it.employee_id).forUpdate().executeTakeFirstOrThrow();
        if (emp.deleted_at || !(WORKING_STATUSES as readonly string[]).includes(emp.status)) throw unprocessable(`Employee is ${emp.status}`);
        const cur = await trx.selectFrom('employee_salary_structures').select(['id', 'basic_salary', 'gross_salary', 'currency']).where('employee_id', '=', it.employee_id).orderBy('version', 'desc').executeTakeFirstOrThrow();
        const curSalary = Number(it.salary_basis === 'GROSS' ? cur.gross_salary : cur.basic_salary);
        if (Math.abs(curSalary - Number(it.current_salary)) > 0.004) throw unprocessable(`Salary changed since the review was populated (${it.current_salary} → ${curSalary})`);
        const band = await bandFor(trx, emp.grade_id, r.effective_date);
        const finalSalary = Number(it.final_salary ?? curSalary);
        if (band && finalSalary > band.max + 0.004 && !it.requires_exception) throw unprocessable(`New salary ${finalSalary} exceeds the band maximum ${band.max} without an approved exception`);
        const dup = await findAnnualDuplicate(trx, it.employee_id, r.cycle_year, undefined, id);
        if (dup) throw conflict(dup.message);
        if (Number(it.proposed_amount) === 0) { await trx.updateTable('salary_review_items').set({ status: 'COMPLETED', apply_error: null }).where('id', '=', it.id).execute(); return; }
        const change = await trx.insertInto('salary_changes').values({
          change_no: await nextCompNo(trx, 'SC'), employee_id: it.employee_id, change_type: 'ANNUAL_INCREMENT', status: 'APPROVED', source: 'REVIEW', salary_basis: it.salary_basis, currency: cur.currency,
          old_salary: curSalary, increase_amount: Number(it.proposed_amount), increase_pct: Number(it.proposed_percentage), new_salary: finalSalary, old_basic: Number(cur.basic_salary), old_gross: Number(cur.gross_salary),
          annual_cost: annualCost(Number(it.proposed_amount), policy.annualizationMonths), effective_date: r.effective_date, reason: `${r.name}`, justification: it.override_justification,
          old_grade_id: emp.grade_id, new_grade_id: emp.grade_id, old_designation_id: it.designation_id, new_designation_id: it.designation_id, band_id: band?.id ?? null, band_min: band?.min ?? null, band_mid: band?.mid ?? null, band_max: band?.max ?? null,
          compa_before: it.compa_ratio, compa_after: band ? round2((finalSalary / band.mid) * 100) : null, exceeds_max_by: Number(it.exceeds_max_by), ceiling_action: it.ceiling_action, requires_exception: it.requires_exception, recommended_pct: it.recommended_pct,
          is_override: !!it.override_justification, alerts: JSON.stringify(it.alerts ?? []), review_id: id, review_item_id: it.id, requested_by: r.submitted_by, submitted_at: r.submitted_at, approved_by: r.approved_by, approved_at: r.approved_at,
        }).returning(['id', 'change_no']).executeTakeFirstOrThrow();
        const lines = it.salary_basis === 'GROSS' ? distributeToTotal(await structureLines(trx, cur.id), finalSalary).map((l) => ({ componentCode: l.componentCode, amount: l.amount })) : undefined;
        const hr = await trx.insertInto('hr_requests').values({
          request_no: await nextRequestNo(trx), request_type: 'INCREMENT', employee_id: it.employee_id, title: `${r.name} — ${Number(it.proposed_percentage)}%`,
          payload: JSON.stringify({ compensationChangeId: change.id, changeType: 'ANNUAL_INCREMENT', reviewId: id, ...(lines ? { lines } : { newBasic: finalSalary }) }), before_snapshot: JSON.stringify(await snapshotEmployee(trx, it.employee_id)),
          effective_date: r.effective_date, reason: `Salary review ${r.name}`, status: 'APPROVED', workflow_instance_id: r.workflow_instance_id, requested_by: r.submitted_by, decided_by: r.approved_by, decided_at: r.approved_at,
        }).returning('id').executeTakeFirstOrThrow();
        const applied = await applyHrRequest(app, hr.id, actorUserId, { trx });
        const structureId = (applied.result as any)?.salaryStructureId as string;
        const s = await trx.selectFrom('employee_salary_structures').select(['basic_salary', 'gross_salary']).where('id', '=', structureId).executeTakeFirstOrThrow();
        await trx.updateTable('salary_changes').set({ status: 'COMPLETED', hr_request_id: hr.id, salary_structure_id: structureId, new_basic: Number(s.basic_salary), new_gross: Number(s.gross_salary), completed_at: new Date() }).where('id', '=', change.id).execute();
        await trx.updateTable('salary_review_items').set({ status: 'COMPLETED', salary_change_id: change.id, hr_request_id: hr.id, applied_salary_structure_id: structureId, new_basic: Number(s.basic_salary), new_gross: Number(s.gross_salary), apply_error: null }).where('id', '=', it.id).execute();
        await app.audit(null, { action: 'compensation.change.completed', entityType: 'salary_change', entityId: change.id, oldValue: { salary: curSalary }, newValue: { salary: finalSalary, structureId }, reason: r.name, approvalRef: r.workflow_instance_id, metadata: { changeNo: change.change_no, type: 'ANNUAL_INCREMENT', employeeId: it.employee_id, reviewId: id } }, 'worker', trx);
      });
      completed++;
    } catch (e) {
      const msg = (e as Error).message;
      failed.push({ employeeId: it.employee_id, error: msg });
      await db.updateTable('salary_review_items').set({ status: 'FAILED', apply_error: msg }).where('id', '=', it.id).execute();
    }
  }
  if (!failed.length) {
    await db.updateTable('salary_reviews').set({ status: 'COMPLETED', completed_at: new Date(), applied_at: new Date() }).where('id', '=', id).execute();
    await logApproval(db, { entityType: 'salary_review', entityId: id, userId: actorUserId, action: 'COMPLETE', previousStatus: r.status, newStatus: 'COMPLETED', comment: `${completed} salary changes applied` });
  }
  await app.audit(null, { action: 'compensation.review.complete', entityType: 'salary_review', entityId: id, newValue: { completed, failed } }, 'worker');
  return { completed, failed };
}

export { LIVE_STATUSES };
