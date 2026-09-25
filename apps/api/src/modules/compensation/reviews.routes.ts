import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { unprocessable } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { approvalOut } from './changes.routes.js';
import { cancelReview, completeReview, createReview, getReviewRow, populateReview, reopenReview, reviewSummary, submitReview, updateReviewItems } from './reviews.service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ceiling = z.enum(['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE']);
export const eligibilityIn = z.object({
  minServiceMonths: z.number().int().min(0).nullable().optional(), minMonthsSinceLastIncrease: z.number().int().min(0).nullable().optional(), lastIncreaseBefore: isoDate.nullable().optional(),
  employmentStatuses: z.array(z.string()).nullable().optional(), employmentTypes: z.array(z.string()).nullable().optional(), minRatingScore: z.number().nullable().optional(), ratingCodes: z.array(z.string()).nullable().optional(), requireRating: z.boolean().nullable().optional(),
  excludeDisciplinaryWithinMonths: z.number().int().min(0).nullable().optional(), excludeOnProbation: z.boolean().nullable().optional(),
  departmentIds: z.array(z.string().uuid()).nullable().optional(), gradeIds: z.array(z.string().uuid()).nullable().optional(), siteIds: z.array(z.string().uuid()).nullable().optional(), designationIds: z.array(z.string().uuid()).nullable().optional(),
}).default({});
const summaryOut = z.object({ items: z.number(), proposed: z.number(), excluded: z.number(), ineligible: z.number(), completed: z.number(), failed: z.number(), actionRequired: z.number(), exceptions: z.number(), aboveMax: z.number(), currentPayroll: z.number(), monthlyIncrease: z.number(), annualIncrease: z.number(), averagePct: z.number(), budget: z.number().nullable(), remaining: z.number().nullable(), utilizationPct: z.number().nullable() });
const reviewOut = z.object({ id: z.string(), name: z.string(), year: z.number(), effectiveDate: z.string(), reviewPeriodStart: z.string().nullable(), reviewPeriodEnd: z.string().nullable(), defaultPercentage: z.number(), maxPercentage: z.number().nullable(), budgetAmount: z.number().nullable(), currency: z.string(), eligibilityRules: z.record(z.unknown()), recommendationMethod: z.string(), meritMatrixId: z.string().nullable(), performanceCycleId: z.string().nullable(), defaultCeilingAction: z.string().nullable(), status: z.string(), notes: z.string().nullable(), decisionComment: z.string().nullable(), workflowInstanceId: z.string().nullable(), submittedAt: z.string().nullable(), approvedAt: z.string().nullable(), completedAt: z.string().nullable(), createdAt: z.string(), summary: summaryOut });
const itemOut = z.object({ id: z.string(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), department: z.string().nullable(), designation: z.string().nullable() }), gradeCode: z.string().nullable(), ratingScore: z.number().nullable(), ratingCode: z.string().nullable(), eligible: z.boolean(), ineligibilityReasons: z.array(z.string()), currentSalary: z.number().nullable(), currentGross: z.number(), band: z.object({ min: z.number(), mid: z.number(), max: z.number() }).nullable(), compaRatio: z.number().nullable(), rangePenetration: z.number().nullable(), recommendedPct: z.number().nullable(), matrixMaxPct: z.number().nullable(), proposedPct: z.number(), proposedAmount: z.number(), proposedSalary: z.number().nullable(), finalSalary: z.number().nullable(), newGross: z.number(), exceedsMaxBy: z.number(), ceilingAction: z.string().nullable(), outcome: z.string().nullable(), requiresException: z.boolean(), justification: z.string().nullable(), note: z.string().nullable(), alerts: z.array(z.unknown()), status: z.string(), salaryChangeId: z.string().nullable(), applyError: z.string().nullable() });
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const T = ['compensation'];
  const reviewMap = async (x: any) => ({ id: x.id, name: x.name, year: x.cycle_year, effectiveDate: x.effective_date, reviewPeriodStart: x.review_period_start, reviewPeriodEnd: x.review_period_end, defaultPercentage: Number(x.default_percentage), maxPercentage: num(x.max_percentage), budgetAmount: num(x.budget_amount), currency: x.currency, eligibilityRules: x.eligibility_rules ?? {}, recommendationMethod: x.recommendation_method, meritMatrixId: x.merit_matrix_id, performanceCycleId: x.performance_cycle_id, defaultCeilingAction: x.default_ceiling_action, status: x.status, notes: x.notes, decisionComment: x.decision_comment, workflowInstanceId: x.workflow_instance_id, submittedAt: iso(x.submitted_at), approvedAt: iso(x.approved_at), completedAt: iso(x.completed_at), createdAt: iso(x.created_at)!, summary: await reviewSummary(app.db, x.id, num(x.budget_amount)) });
  const itemMap = (x: any) => ({ id: x.id, employee: { id: x.employee_id, employeeNo: x.employee_no, name: x.full_name_en, department: x.department ?? null, designation: x.designation ?? null }, gradeCode: x.grade_code, ratingScore: num(x.performance_rating), ratingCode: x.rating_code, eligible: x.eligible, ineligibilityReasons: x.ineligibility_reasons ?? [], currentSalary: num(x.current_salary), currentGross: Number(x.current_gross), band: x.band_max === null ? null : { min: Number(x.band_min), mid: Number(x.band_mid), max: Number(x.band_max) }, compaRatio: num(x.compa_ratio), rangePenetration: num(x.range_penetration), recommendedPct: num(x.recommended_pct), matrixMaxPct: num(x.matrix_max_pct), proposedPct: Number(x.proposed_percentage), proposedAmount: Number(x.proposed_amount), proposedSalary: num(x.proposed_salary), finalSalary: num(x.final_salary), newGross: Number(x.new_gross), exceedsMaxBy: Number(x.exceeds_max_by), ceilingAction: x.ceiling_action, outcome: x.outcome, requiresException: x.requires_exception, justification: x.override_justification, note: x.note, alerts: x.alerts ?? [], status: x.status, salaryChangeId: x.salary_change_id, applyError: x.apply_error });
  const reviewIn = z.object({ name: z.string().min(3).max(120), year: z.number().int().min(2000).max(2100), effectiveDate: isoDate, reviewPeriodStart: isoDate.nullable().optional(), reviewPeriodEnd: isoDate.nullable().optional(), defaultPercentage: z.number().min(0).max(100).default(0), maxPercentage: z.number().min(0).max(100).nullable().optional(), budgetAmount: z.number().min(0).nullable().optional(), currency: z.string().length(3).default('AED'), eligibilityRules: eligibilityIn, recommendationMethod: z.enum(['DEFAULT_PERCENT', 'MERIT_MATRIX']).default('DEFAULT_PERCENT'), meritMatrixId: z.string().uuid().nullable().optional(), performanceCycleId: z.string().uuid().nullable().optional(), defaultCeilingAction: ceiling.nullable().optional(), notes: z.string().max(2000).nullable().optional() });

  r.get('/reviews', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Annual salary review cycles with cost summary', querystring: z.object({ status: z.string().optional(), year: z.coerce.number().int().optional() }), response: { 200: z.array(reviewOut) } } }, async (req) => {
    let q = app.db.selectFrom('salary_reviews').selectAll().where('deleted_at', 'is', null);
    if (req.query.status) q = q.where('status', '=', req.query.status);
    if (req.query.year) q = q.where('cycle_year', '=', req.query.year);
    return Promise.all((await q.orderBy('created_at', 'desc').execute()).map(reviewMap));
  });
  r.post('/reviews', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Create a salary review cycle (DRAFT). populate=true also generates the employee items.', body: reviewIn.extend({ populate: z.boolean().default(true) }), response: { 201: reviewOut, 409: errorSchema, 422: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const { populate, ...b } = req.body;
    const id = await createReview(app, req, p, b as any);
    if (populate) await populateReview(app, req, p, id);
    return reply.status(201).send(await reviewMap(await getReviewRow(app.db, id)));
  });
  r.get('/reviews/:id', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Review with approval trail and workflow steps', params: idParam, response: { 200: reviewOut.extend({ approvals: z.array(approvalOut), tasks: z.array(z.object({ step: z.string(), status: z.string(), role: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), comment: z.string().nullable() })) }) } } }, async (req) => {
    const x = await getReviewRow(app.db, req.params.id);
    const approvals = (await app.db.selectFrom('compensation_approval_actions').selectAll().where('entity_type', '=', 'salary_review').where('entity_id', '=', x.id).orderBy('id').execute()).map((a) => ({ id: a.id, at: new Date(a.occurred_at).toISOString(), user: a.user_name, role: a.role_code, action: a.action, step: a.step_key, comment: a.comment, previousStatus: a.previous_status, newStatus: a.new_status }));
    const tasks = x.workflow_instance_id ? await app.db.selectFrom('workflow_tasks as t').leftJoin('users as u', 'u.id', 't.decided_by').select(['t.step_key', 't.status', 't.assignee_role_code', 'u.display_name', 't.decided_at', 't.comment']).where('t.instance_id', '=', x.workflow_instance_id).orderBy('t.step_index').execute() : [];
    return { ...(await reviewMap(x)), approvals, tasks: tasks.map((t) => ({ step: t.step_key, status: t.status, role: t.assignee_role_code, decidedBy: t.display_name ?? null, decidedAt: iso(t.decided_at), comment: t.comment })) };
  });
  r.put('/reviews/:id', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Edit a DRAFT review (re-populate afterwards to apply new rules)', params: idParam, body: reviewIn.partial(), response: { 200: reviewOut, 422: errorSchema } } }, async (req) => {
    const x = await getReviewRow(app.db, req.params.id);
    if (x.status !== 'DRAFT') throw unprocessable(`Review is ${x.status}; only DRAFT reviews can be edited`);
    const b = req.body;
    await app.db.updateTable('salary_reviews').set({ ...(b.name !== undefined && { name: b.name }), ...(b.year !== undefined && { cycle_year: b.year }), ...(b.effectiveDate !== undefined && { effective_date: b.effectiveDate }), ...(b.reviewPeriodStart !== undefined && { review_period_start: b.reviewPeriodStart }), ...(b.reviewPeriodEnd !== undefined && { review_period_end: b.reviewPeriodEnd }), ...(b.defaultPercentage !== undefined && { default_percentage: b.defaultPercentage }), ...(b.maxPercentage !== undefined && { max_percentage: b.maxPercentage }), ...(b.budgetAmount !== undefined && { budget_amount: b.budgetAmount }), ...(b.eligibilityRules !== undefined && { eligibility_rules: JSON.stringify(b.eligibilityRules) }), ...(b.recommendationMethod !== undefined && { recommendation_method: b.recommendationMethod }), ...(b.meritMatrixId !== undefined && { merit_matrix_id: b.meritMatrixId }), ...(b.performanceCycleId !== undefined && { performance_cycle_id: b.performanceCycleId }), ...(b.defaultCeilingAction !== undefined && { default_ceiling_action: b.defaultCeilingAction }), ...(b.notes !== undefined && { notes: b.notes }) }).where('id', '=', x.id).execute();
    await app.audit(req, { action: 'compensation.review.update', entityType: 'salary_review', entityId: x.id, oldValue: { name: x.name, defaultPercentage: Number(x.default_percentage), maxPercentage: x.max_percentage, budget: x.budget_amount, rules: x.eligibility_rules }, newValue: b });
    return reviewMap(await getReviewRow(app.db, x.id));
  });
  r.post('/reviews/:id/populate', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Regenerate the items: identify eligible employees, recommend increases (merit matrix or default %), apply the ceiling rule', params: idParam, response: { 200: z.object({ items: z.number(), eligible: z.number(), ineligible: z.number() }), 422: errorSchema } } }, async (req) => populateReview(app, req, requireAuth(req), req.params.id));
  r.get('/reviews/:id/items', { preHandler: [requirePermission('compensation:read'), requirePermission('salary:read')], schema: { tags: T, summary: 'Review items (restricted: salary:read)', params: idParam, querystring: paginationQuery.merge(z.object({ status: z.string().optional(), eligible: z.coerce.boolean().optional(), attention: z.coerce.boolean().optional(), search: z.string().max(100).optional(), departmentId: z.string().uuid().optional() })), response: { 200: paginated(itemOut) } } }, async (req) => {
    const q = req.query;
    let b = app.db.selectFrom('salary_review_items as x').innerJoin('employees as e', 'e.id', 'x.employee_id').leftJoin('departments as d', 'd.id', 'x.department_id').leftJoin('designations as g', 'g.id', 'x.designation_id').selectAll('x').select(['e.employee_no', 'e.full_name_en', 'd.name as department', 'g.title as designation']).where('x.cycle_id', '=', req.params.id);
    if (q.status) b = b.where('x.status', '=', q.status);
    if (q.eligible !== undefined) b = b.where('x.eligible', '=', q.eligible);
    if (q.attention) b = b.where((eb) => eb.or([eb('x.outcome', '=', 'ACTION_REQUIRED'), eb('x.requires_exception', '=', true), eb('x.exceeds_max_by', '>', 0), eb('x.status', '=', 'FAILED')]));
    if (q.departmentId) b = b.where('x.department_id', '=', q.departmentId);
    if (q.search) b = b.where((eb) => eb.or([eb('e.full_name_en', 'ilike', `%${q.search}%`), eb('e.employee_no', 'ilike', `%${q.search}%`)]));
    const total = Number((await b.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return { data: (await b.orderBy('x.exceeds_max_by', 'desc').orderBy('e.employee_no').limit(q.pageSize).offset(offset(q)).execute()).map(itemMap), meta: pageMeta(q, total) };
  });
  r.patch('/reviews/:id/items', { preHandler: [requirePermission('compensation:propose'), requirePermission('salary:read')], schema: { tags: T, summary: 'Edit items (percentage / amount / new salary, ceiling action, include/exclude). Beyond matrix/review maximum or including ineligible employees needs compensation:override + justification.', params: idParam, body: z.object({ items: z.array(z.object({ id: z.string().uuid(), percentage: z.number().min(0).max(100).optional(), amount: z.number().min(0).optional(), newSalary: z.number().min(0).optional(), ceilingAction: ceiling.nullable().optional(), status: z.enum(['PROPOSED', 'EXCLUDED']).optional(), note: z.string().max(500).optional(), justification: z.string().max(2000).optional() })).min(1).max(1000) }), response: { 200: z.object({ updated: z.number(), summary: summaryOut }), 403: errorSchema, 422: errorSchema } } }, async (req) => {
    const updated = await updateReviewItems(app, req, requireAuth(req), req.params.id, req.body.items);
    const x = await getReviewRow(app.db, req.params.id);
    return { updated, summary: await reviewSummary(app.db, x.id, num(x.budget_amount)) };
  });
  r.post('/reviews/:id/bulk-ceiling', { preHandler: [requirePermission('compensation:propose'), requirePermission('salary:read')], schema: { tags: T, summary: 'Apply one ceiling action to every item that exceeds its band maximum without a decision', params: idParam, body: z.object({ ceilingAction: z.enum(['CAP_AT_MAX', 'CANCEL']) }), response: { 200: z.object({ updated: z.number(), summary: summaryOut }) } } }, async (req) => {
    const items = await app.db.selectFrom('salary_review_items').select(['id', 'proposed_percentage', 'recommended_pct']).where('cycle_id', '=', req.params.id).where('outcome', '=', 'ACTION_REQUIRED').where('status', '=', 'PROPOSED').execute();
    const updated = items.length ? await updateReviewItems(app, req, requireAuth(req), req.params.id, items.map((i) => ({ id: i.id, percentage: Number(i.recommended_pct ?? 0), ceilingAction: req.body.ceilingAction }))) : 0;
    const x = await getReviewRow(app.db, req.params.id);
    return { updated, summary: await reviewSummary(app.db, x.id, num(x.budget_amount)) };
  });
  r.post('/reviews/:id/submit', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Submit the review for approval (COMP_SALARY_REVIEW). Blocked while ceiling decisions are open or the budget would be exceeded.', params: idParam, response: { 200: reviewOut, 422: errorSchema } } }, async (req) => {
    await submitReview(app, req, requireAuth(req), req.params.id);
    return reviewMap(await getReviewRow(app.db, req.params.id));
  });
  r.post('/reviews/:id/approve', { preHandler: requirePermission('workflows:act'), schema: { tags: T, summary: 'Approve (or reject) my pending step on the review', params: idParam, body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'), comment: z.string().max(1000).optional() }), response: { 200: reviewOut, 403: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const x = await getReviewRow(app.db, req.params.id);
    if (!x.workflow_instance_id) throw unprocessable('This review is not awaiting approval');
    const t = (await app.db.selectFrom('workflow_tasks').select(['id', 'assignee_user_id', 'assignee_role_code']).where('instance_id', '=', x.workflow_instance_id).where('status', '=', 'PENDING').execute()).find((t) => t.assignee_user_id === p.userId || (t.assignee_role_code && p.roles.includes(t.assignee_role_code)));
    if (!t) throw unprocessable('You have no pending approval step on this review');
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/tasks/${t.id}/decide`, headers: { authorization: String(req.headers.authorization ?? '') }, payload: req.body });
    if (res.statusCode !== 200) { const e = res.json() as any; throw Object.assign(new Error(e?.error?.message ?? 'Decision failed'), { statusCode: res.statusCode }); }
    return reviewMap(await getReviewRow(app.db, x.id));
  });
  r.post('/reviews/:id/complete', { preHandler: requirePermission('salary:write'), schema: { tags: T, summary: 'Apply approved items (automatic on final approval; use to retry FAILED items). Each employee is applied atomically.', params: idParam, response: { 200: z.object({ completed: z.number(), failed: z.array(z.object({ employeeId: z.string(), error: z.string() })) }), 422: errorSchema } } }, async (req) => completeReview(app, req.params.id, requireAuth(req).userId));
  r.post('/reviews/:id/cancel', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Cancel a review (not after items were applied)', params: idParam, body: z.object({ reason: z.string().min(1).max(500) }), response: { 200: reviewOut, 422: errorSchema } } }, async (req) => {
    await cancelReview(app, req, requireAuth(req), req.params.id, req.body.reason);
    return reviewMap(await getReviewRow(app.db, req.params.id));
  });
  r.post('/reviews/:id/reopen', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Return a REJECTED review to DRAFT for rework', params: idParam, body: z.object({ reason: z.string().min(1).max(500) }), response: { 200: reviewOut, 422: errorSchema } } }, async (req) => {
    await reopenReview(app, req, requireAuth(req), req.params.id, req.body.reason);
    return reviewMap(await getReviewRow(app.db, req.params.id));
  });
};
