import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { AppError, forbidden, notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { CHANGE_TYPES, loadProfiles, PENDING_STATUSES, type Profile } from './data.js';
import { loadPolicy } from './policy.js';
import { cancelSalaryChange, createPromotion, createSalaryChange, evaluateChange, evaluatePromotion, submitSalaryChange } from './service.js';

/** Employee compensation profiles, salary history, salary changes (8 types) and promotions. Individual amounts need salary:read. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ceiling = z.enum(['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE']);
const alertOut = z.object({ code: z.string(), severity: z.string(), message: z.string(), amount: z.number().optional() });
const bandOut = z.object({ id: z.string(), min: z.number(), mid: z.number(), max: z.number(), currency: z.string(), effectiveFrom: z.string(), effectiveTo: z.string().nullable() }).nullable();
export const profileOut = z.object({
  employeeId: z.string(), employeeNo: z.string(), name: z.string(), status: z.string(), employmentType: z.string(), joiningDate: z.string().nullable(),
  department: z.string().nullable(), departmentId: z.string().nullable(), site: z.string().nullable(), siteId: z.string().nullable(), designation: z.string().nullable(), designationId: z.string().nullable(),
  gradeId: z.string().nullable(), gradeCode: z.string().nullable(), gradeName: z.string().nullable(), titleGradeCode: z.string().nullable(),
  currency: z.string(), salaryBasis: z.string(), currentSalary: z.number().nullable(), basicSalary: z.number().nullable(), grossSalary: z.number().nullable(),
  band: bandOut, compaRatio: z.number().nullable(), rangePenetration: z.number().nullable(), remainingToMax: z.number().nullable(), maxPossibleIncreasePct: z.number().nullable(), aboveMaxBy: z.number(), belowMinBy: z.number(),
  bandStatus: z.object({ code: z.string(), label: z.string(), color: z.string() }),
  lastIncreaseDate: z.string().nullable(), lastPromotionDate: z.string().nullable(), lastReviewDate: z.string().nullable(),
  ratingScore: z.number().nullable(), ratingCode: z.string().nullable(), ratingLabel: z.string().nullable(), dueForReview: z.boolean(),
});
export const profileMap = (x: Profile) => ({ ...x, band: x.band ? { id: x.band.id, min: x.band.min, mid: x.band.mid, max: x.band.max, currency: x.band.currency, effectiveFrom: x.band.effectiveFrom, effectiveTo: x.band.effectiveTo } : null });

const changeOut = z.object({
  id: z.string(), changeNo: z.string(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), department: z.string().nullable() }), changeType: z.string(), status: z.string(), source: z.string(),
  currency: z.string(), salaryBasis: z.string(), oldSalary: z.number(), increaseAmount: z.number(), increasePct: z.number(), newSalary: z.number(), annualCost: z.number(), effectiveDate: z.string(),
  reason: z.string(), comments: z.string().nullable(), justification: z.string().nullable(), oldGrade: z.string().nullable(), newGrade: z.string().nullable(), oldTitle: z.string().nullable(), newTitle: z.string().nullable(),
  band: z.object({ min: z.number(), mid: z.number(), max: z.number() }).nullable(), compaBefore: z.number().nullable(), compaAfter: z.number().nullable(), exceedsMaxBy: z.number(), ceilingAction: z.string().nullable(), requiresException: z.boolean(),
  recommendedPct: z.number().nullable(), isOverride: z.boolean(), duplicateOverride: z.boolean(), budgetOverride: z.boolean(), outsideWorkflow: z.boolean(), alerts: z.array(alertOut),
  requestedBy: z.string().nullable(), approvedBy: z.string().nullable(), approvedAt: z.string().nullable(), submittedAt: z.string().nullable(), completedAt: z.string().nullable(), createdAt: z.string(),
  hrRequestId: z.string().nullable(), promotionRequestId: z.string().nullable(), reviewId: z.string().nullable(), applyError: z.string().nullable(),
});
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export const approvalOut = z.object({ id: z.number(), at: z.string(), user: z.string().nullable(), role: z.string().nullable(), action: z.string(), step: z.string().nullable(), comment: z.string().nullable(), previousStatus: z.string().nullable(), newStatus: z.string() });

export const changeRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const T = ['compensation'];

  const changeQ = () => app.db.selectFrom('salary_changes as c').innerJoin('employees as e', 'e.id', 'c.employee_id').leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('grades as og', 'og.id', 'c.old_grade_id').leftJoin('grades as ng', 'ng.id', 'c.new_grade_id').leftJoin('designations as ot', 'ot.id', 'c.old_designation_id').leftJoin('designations as nt', 'nt.id', 'c.new_designation_id')
    .leftJoin('users as rq', 'rq.id', 'c.requested_by').leftJoin('users as ap', 'ap.id', 'c.approved_by')
    .selectAll('c').select(['e.employee_no', 'e.full_name_en', 'd.name as department', 'og.code as old_grade', 'ng.code as new_grade', 'ot.title as old_title', 'nt.title as new_title', 'rq.display_name as requested_name', 'ap.display_name as approved_name']);
  const changeMap = (c: any) => ({
    id: c.id, changeNo: c.change_no, employee: { id: c.employee_id, employeeNo: c.employee_no, name: c.full_name_en, department: c.department ?? null }, changeType: c.change_type, status: c.status, source: c.source,
    currency: c.currency, salaryBasis: c.salary_basis, oldSalary: Number(c.old_salary), increaseAmount: Number(c.increase_amount), increasePct: Number(c.increase_pct), newSalary: Number(c.new_salary), annualCost: Number(c.annual_cost), effectiveDate: c.effective_date,
    reason: c.reason, comments: c.comments, justification: c.justification, oldGrade: c.old_grade ?? null, newGrade: c.new_grade ?? null, oldTitle: c.old_title ?? null, newTitle: c.new_title ?? null,
    band: c.band_max === null ? null : { min: Number(c.band_min), mid: Number(c.band_mid), max: Number(c.band_max) }, compaBefore: num(c.compa_before), compaAfter: num(c.compa_after), exceedsMaxBy: Number(c.exceeds_max_by), ceilingAction: c.ceiling_action, requiresException: c.requires_exception,
    recommendedPct: num(c.recommended_pct), isOverride: c.is_override, duplicateOverride: c.duplicate_override, budgetOverride: c.budget_override, outsideWorkflow: c.outside_workflow, alerts: (c.alerts ?? []) as any[],
    requestedBy: c.requested_name ?? null, approvedBy: c.approved_name ?? null, approvedAt: iso(c.approved_at), submittedAt: iso(c.submitted_at), completedAt: iso(c.completed_at), createdAt: iso(c.created_at)!,
    hrRequestId: c.hr_request_id, promotionRequestId: c.promotion_request_id, reviewId: c.review_id, applyError: c.apply_error,
  });
  const approvals = async (entityType: string, id: string) => (await app.db.selectFrom('compensation_approval_actions').selectAll().where('entity_type', '=', entityType).where('entity_id', '=', id).orderBy('occurred_at').orderBy('id').execute())
    .map((a) => ({ id: a.id, at: new Date(a.occurred_at).toISOString(), user: a.user_name, role: a.role_code, action: a.action, step: a.step_key, comment: a.comment, previousStatus: a.previous_status, newStatus: a.new_status }));
  /** Salary visibility: salary:read, or the employee's own record with salary:read:own. */
  const assertSalaryVisible = (req: FastifyRequest, employeeId: string) => { const p = requireAuth(req); if (!hasPermission(p, 'salary:read') && !(hasPermission(p, 'salary:read:own') && p.employeeId === employeeId)) throw forbidden('Salary information is restricted (salary:read)'); };

  // ── Profiles ──
  r.get('/employees', { preHandler: requirePermission('salary:read'), schema: { tags: T, summary: 'Employee compensation profiles (band position, status, review dates). Restricted: salary:read.',
    querystring: paginationQuery.merge(z.object({ departmentId: z.string().uuid().optional(), siteId: z.string().uuid().optional(), gradeId: z.string().uuid().optional(), designationId: z.string().uuid().optional(), employmentType: z.string().optional(), gender: z.string().optional(), bandStatus: z.string().optional(), color: z.string().optional(), dueForReview: z.coerce.boolean().optional(), search: z.string().max(100).optional() })),
    response: { 200: paginated(profileOut) } } }, async (req) => {
    const q = req.query;
    const policy = await loadPolicy(app.db);
    let rows = await loadProfiles(app.db, policy, { departmentIds: q.departmentId ? [q.departmentId] : undefined, siteIds: q.siteId ? [q.siteId] : undefined, gradeIds: q.gradeId ? [q.gradeId] : undefined, designationIds: q.designationId ? [q.designationId] : undefined, employmentTypes: q.employmentType ? [q.employmentType] : undefined, genders: q.gender ? [q.gender] : undefined, search: q.search });
    if (q.bandStatus) rows = rows.filter((x) => x.bandStatus.code === q.bandStatus);
    if (q.color) rows = rows.filter((x) => x.bandStatus.color === q.color);
    if (q.dueForReview !== undefined) rows = rows.filter((x) => x.dueForReview === q.dueForReview);
    const key = (q.sort ?? 'employeeNo') as keyof Profile;
    if (['employeeNo', 'name', 'currentSalary', 'compaRatio', 'rangePenetration', 'gradeCode', 'department'].includes(key as string)) rows.sort((a, b) => { const x = a[key] as any, y = b[key] as any; const c = x === null ? -1 : y === null ? 1 : x < y ? -1 : x > y ? 1 : 0; return q.order === 'desc' ? -c : c; });
    return { data: rows.slice(offset(q), offset(q) + q.pageSize).map(profileMap), meta: pageMeta(q, rows.length) };
  });

  r.get('/employee/:id', { preHandler: requirePermission('salary:read', 'salary:read:own'), schema: { tags: T, summary: 'Employee compensation page: profile, salary history, changes, approvals, alerts and allowed actions', params: idParam,
    response: { 200: z.object({ profile: profileOut, history: z.array(z.unknown()), changes: z.array(changeOut), promotions: z.array(z.unknown()), approvals: z.array(approvalOut.extend({ entity: z.string(), reference: z.string() })), alerts: z.array(z.unknown()), actions: z.array(z.object({ key: z.string(), label: z.string(), enabled: z.boolean(), reason: z.string().nullable() })) }), 403: errorSchema } } }, async (req) => {
    assertSalaryVisible(req, req.params.id);
    const p = requireAuth(req);
    const policy = await loadPolicy(app.db);
    const [profile] = await loadProfiles(app.db, policy, { employeeIds: [req.params.id], includeAllStatuses: true });
    if (!profile) throw notFound('Employee', req.params.id);
    const changes = (await changeQ().where('c.employee_id', '=', req.params.id).orderBy('c.effective_date', 'desc').orderBy('c.created_at', 'desc').execute()).map(changeMap);
    const promotions = await app.db.selectFrom('promotion_requests as x').leftJoin('grades as g', 'g.id', 'x.new_grade_id').leftJoin('designations as t', 't.id', 'x.new_designation_id').select(['x.id', 'x.promotion_no', 'x.status', 'x.effective_date', 'x.new_salary', 'x.current_salary', 'g.code as grade', 't.title']).where('x.employee_id', '=', req.params.id).orderBy('x.created_at', 'desc').execute();
    const trail: any[] = [];
    for (const c of changes.filter((c) => c.source !== 'HR_REQUEST' && c.source !== 'DIRECT')) {
      for (const a of await approvals(c.promotionRequestId ? 'promotion_request' : 'salary_change', c.promotionRequestId ?? c.id)) trail.push({ ...a, entity: c.changeType, reference: c.changeNo });
    }
    const alerts = await app.db.selectFrom('salary_alerts').selectAll().where('employee_id', '=', req.params.id).where('status', '<>', 'RESOLVED').orderBy('severity').execute();
    const pending = changes.some((c) => (PENDING_STATUSES as readonly string[]).includes(c.status));
    const can = hasPermission(p, 'compensation:propose');
    const working = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED'].includes(profile.status);
    const why = (ok: boolean, r: string) => (ok ? null : r);
    const year = new Date().getFullYear();
    const actions = [
      { key: 'ANNUAL_INCREMENT', label: 'Annual increment', extra: profile.annualIncrementYears.includes(year) ? `Annual increase already processed for ${year}` : null },
      { key: 'PROMOTION', label: 'Promotion', extra: null }, { key: 'MARKET_ADJUSTMENT', label: 'Adjustment', extra: null }, { key: 'SALARY_CORRECTION', label: 'Salary correction', extra: null },
    ].map((a) => { const reason = why(can, 'compensation:propose required') ?? why(working, `Employee is ${profile.status}`) ?? why(profile.currentSalary !== null, 'No salary structure') ?? why(!pending, 'Another compensation change is pending approval') ?? a.extra; return { key: a.key, label: a.label, enabled: !reason || (a.key === 'ANNUAL_INCREMENT' && reason === a.extra && hasPermission(p, 'compensation:override')), reason }; });
    return { profile: profileMap(profile), history: await salaryHistory(req.params.id), changes, promotions: promotions.map((x) => ({ id: x.id, promotionNo: x.promotion_no, status: x.status, effectiveDate: x.effective_date, currentSalary: Number(x.current_salary), newSalary: Number(x.new_salary), grade: x.grade, title: x.title })), approvals: trail.sort((a, b) => b.at.localeCompare(a.at)), alerts: alerts.map((a) => ({ id: a.id, type: a.alert_type, severity: a.severity, status: a.status, message: a.message })), actions };
  });

  /** Timeline: every salary version (joining → latest) enriched by the ledger row that produced it. */
  async function salaryHistory(employeeId: string) {
    const policy = await loadPolicy(app.db);
    const versions = await app.db.selectFrom('employee_salary_structures as s').leftJoin('salary_changes as c', 'c.salary_structure_id', 's.id').leftJoin('users as u', 'u.id', 'c.approved_by')
      .select(['s.id', 's.version', 's.effective_from', 's.basic_salary', 's.gross_salary', 's.currency', 's.source', 's.reason as s_reason', 'c.change_no', 'c.change_type', 'c.reason', 'c.increase_pct', 'c.approved_at', 'u.display_name as approved_by', 'c.source as c_source'])
      .where('s.employee_id', '=', employeeId).orderBy('s.version').execute();
    let prev: number | null = null;
    return versions.map((v) => {
      const salary = Number(policy.bandBasis === 'GROSS' ? v.gross_salary : v.basic_salary);
      const type = v.change_type ?? (v.version === 1 ? 'JOINING' : ({ PROMOTION: 'PROMOTION', INCREMENT: 'ANNUAL_INCREMENT', GRADE_CHANGE: 'GRADE_CHANGE' } as Record<string, string>)[v.source] ?? 'SALARY_CHANGE');
      const out = { structureId: v.id, version: v.version, date: v.effective_from, year: Number(String(v.effective_from).slice(0, 4)), type, changeNo: v.change_no ?? null, salary, basic: Number(v.basic_salary), gross: Number(v.gross_salary), currency: v.currency,
        previousSalary: prev, increaseAmount: prev === null ? null : Math.round((salary - prev) * 100) / 100, increasePct: prev ? Math.round(((salary - prev) / prev) * 10000) / 100 : null, reason: v.reason ?? v.s_reason, approvedBy: v.approved_by ?? null, approvedAt: iso(v.approved_at), source: v.c_source ?? v.source };
      prev = salary;
      return out;
    }).reverse();
  }
  r.get('/employee/:id/history', { preHandler: requirePermission('salary:read', 'salary:read:own'), schema: { tags: T, summary: 'Salary timeline (joining salary → every change)', params: idParam, response: { 200: z.array(z.unknown()), 403: errorSchema } } }, async (req) => { assertSalaryVisible(req, req.params.id); return salaryHistory(req.params.id); });

  // ── Salary changes ──
  const changeIn = z.object({
    employeeId: z.string().uuid(), changeType: z.enum(CHANGE_TYPES).refine((t) => t !== 'PROMOTION', 'Use /promotions'), increasePct: z.number().min(-100).max(1000).optional(), increaseAmount: z.number().min(-1_000_000).max(1_000_000).optional(), newSalary: z.number().min(0).max(10_000_000).optional(),
    effectiveDate: isoDate, ceilingAction: ceiling.nullable().optional(), newGradeId: z.string().uuid().nullable().optional(), newDesignationId: z.string().uuid().nullable().optional(), overrideDuplicate: z.boolean().optional(), overrideBudget: z.boolean().optional(), justification: z.string().max(2000).nullable().optional(),
  });
  const evalOut = z.object({ employee: profileOut, band: bandOut, calculation: z.unknown(), recommendation: z.object({ ratingCode: z.string().nullable(), recommendedPct: z.number(), maxPct: z.number() }).nullable(), duplicate: z.object({ message: z.string(), reference: z.string() }).nullable(), budgetViolations: z.array(z.unknown()), overrideReasons: z.array(z.string()), blockers: z.array(z.string()), alerts: z.array(alertOut), annualCost: z.number(), allowedCeilingActions: z.array(z.string()) });
  const calculate = async (req: FastifyRequest, body: z.infer<typeof changeIn>) => {
    const policy = await loadPolicy(app.db);
    const ev = await evaluateChange(app.db, body as any, { policy });
    return { employee: profileMap(ev.profile), band: ev.band, calculation: ev.calc, recommendation: ev.recommendation, duplicate: ev.duplicate, budgetViolations: ev.budgetViolations, overrideReasons: ev.overrideReasons, blockers: ev.blockers, alerts: ev.alerts, annualCost: ev.annualCost, allowedCeilingActions: policy.ceilingActions };
  };
  r.post('/increments/calculate', { preHandler: [requirePermission('compensation:propose', 'compensation:read'), requirePermission('salary:read')], schema: { tags: T, summary: 'Calculate a proposed change (no data written): band position before/after, ceiling alert + available actions, merit recommendation, duplicate and budget checks', body: changeIn, response: { 200: evalOut, 422: errorSchema } } }, async (req) => calculate(req, req.body));
  r.post('/changes/calculate', { preHandler: [requirePermission('compensation:propose', 'compensation:read'), requirePermission('salary:read')], schema: { tags: T, summary: 'Alias of /increments/calculate for every change type', body: changeIn, response: { 200: evalOut, 422: errorSchema } } }, async (req) => calculate(req, req.body));

  const createBody = changeIn.extend({ reason: z.string().min(3).max(1000), comments: z.string().max(2000).nullable().optional(), submit: z.boolean().default(false) });
  const createChange = async (req: FastifyRequest, body: z.infer<typeof createBody>) => { const id = await createSalaryChange(app, req, requireAuth(req), body as any); return changeMap(await changeQ().where('c.id', '=', id).executeTakeFirstOrThrow()); };
  r.post('/changes', { preHandler: [requirePermission('compensation:propose'), requirePermission('salary:read')], schema: { tags: T, summary: 'Create a salary change (DRAFT; submit=true sends it for approval). Types: annual increment, market / special / demotion adjustment, salary correction, merit increase, grade change.', body: createBody, response: { 201: changeOut, 409: errorSchema, 422: errorSchema } } }, async (req, reply) => reply.status(201).send(await createChange(req, req.body)));
  r.post('/increments', { preHandler: [requirePermission('compensation:propose'), requirePermission('salary:read')], schema: { tags: T, summary: 'Create an individual annual increment (outside a review cycle)', body: createBody.omit({ changeType: true }), response: { 201: changeOut, 409: errorSchema, 422: errorSchema } } }, async (req, reply) => reply.status(201).send(await createChange(req, { ...req.body, changeType: 'ANNUAL_INCREMENT' })));

  r.get('/changes', { preHandler: requirePermission('salary:read'), schema: { tags: T, summary: 'Salary change ledger', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), changeType: z.string().optional(), status: z.string().optional(), year: z.coerce.number().int().optional(), pending: z.coerce.boolean().optional(), reviewId: z.string().uuid().optional() })), response: { 200: paginated(changeOut) } } }, async (req) => {
    const q = req.query;
    let b = changeQ();
    if (q.employeeId) b = b.where('c.employee_id', '=', q.employeeId);
    if (q.changeType) b = b.where('c.change_type', '=', q.changeType);
    if (q.status) b = b.where('c.status', '=', q.status);
    if (q.pending) b = b.where('c.status', 'in', [...PENDING_STATUSES]);
    if (q.year) b = b.where('c.effective_year', '=', q.year);
    if (q.reviewId) b = b.where('c.review_id', '=', q.reviewId);
    const total = Number((await b.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return { data: (await b.orderBy('c.created_at', 'desc').limit(q.pageSize).offset(offset(q)).execute()).map(changeMap), meta: pageMeta(q, total) };
  });
  r.get('/changes/:id', { preHandler: requirePermission('salary:read', 'salary:read:own'), schema: { tags: T, summary: 'Salary change with approval trail and workflow tasks', params: idParam, response: { 200: changeOut.extend({ approvals: z.array(approvalOut), tasks: z.array(z.object({ id: z.string(), step: z.string(), status: z.string(), role: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), comment: z.string().nullable() })) }), 404: errorSchema } } }, async (req) => {
    const c = await changeQ().where('c.id', '=', req.params.id).executeTakeFirst();
    if (!c) throw notFound('Salary change', req.params.id);
    assertSalaryVisible(req, c.employee_id);
    const wf = c.hr_request_id ? (await app.db.selectFrom('hr_requests').select('workflow_instance_id').where('id', '=', c.hr_request_id).executeTakeFirst())?.workflow_instance_id : null;
    const tasks = wf ? await app.db.selectFrom('workflow_tasks as t').leftJoin('users as u', 'u.id', 't.decided_by').select(['t.id', 't.step_key', 't.status', 't.assignee_role_code', 'u.display_name', 't.decided_at', 't.comment']).where('t.instance_id', '=', wf).orderBy('t.step_index').execute() : [];
    return { ...changeMap(c), approvals: await approvals(c.promotion_request_id ? 'promotion_request' : 'salary_change', c.promotion_request_id ?? c.id), tasks: tasks.map((t) => ({ id: t.id, step: t.step_key, status: t.status, role: t.assignee_role_code, decidedBy: t.display_name ?? null, decidedAt: iso(t.decided_at), comment: t.comment })) };
  });
  r.post('/changes/:id/submit', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Submit a DRAFT change for approval (workflow COMP_<TYPE>; refused when no approval chain is configured)', params: idParam, body: z.object({ overrideBudget: z.boolean().optional() }).default({}), response: { 200: changeOut, 409: errorSchema, 422: errorSchema } } }, async (req) => {
    await submitSalaryChange(app, req, requireAuth(req), req.params.id, req.body);
    return changeMap(await changeQ().where('c.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
  r.post('/changes/:id/cancel', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Cancel a draft or pending change (the record is kept)', params: idParam, body: z.object({ reason: z.string().min(1).max(500) }), response: { 200: changeOut, 422: errorSchema } } }, async (req) => {
    await cancelSalaryChange(app, req, requireAuth(req), req.params.id, req.body.reason);
    return changeMap(await changeQ().where('c.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  /** Approve / reject the caller's pending task on a compensation item — delegates to the workflow engine (same hooks, audit and segregation of duties). */
  const decide = async (req: FastifyRequest, instanceId: string | null | undefined, body: { decision: 'APPROVED' | 'REJECTED'; comment?: string }) => {
    const p = requireAuth(req);
    if (!instanceId) throw unprocessable('This item is not awaiting approval');
    const tasks = await app.db.selectFrom('workflow_tasks').select(['id', 'assignee_user_id', 'assignee_role_code']).where('instance_id', '=', instanceId).where('status', '=', 'PENDING').execute();
    const t = tasks.find((x) => x.assignee_user_id === p.userId || (x.assignee_role_code && p.roles.includes(x.assignee_role_code))) ?? (p.roles.includes('SUPER_ADMIN') ? tasks[0] : undefined);
    if (!t) throw forbidden('You have no pending approval step on this item');
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/tasks/${t.id}/decide`, headers: { authorization: String(req.headers.authorization ?? ''), ...(req.headers['x-api-key'] ? { 'x-api-key': String(req.headers['x-api-key']) } : {}) }, payload: body });
    if (res.statusCode !== 200) { const e = res.json() as any; throw new AppError(res.statusCode, e?.error?.code ?? 'ERROR', e?.error?.message ?? 'Decision failed'); }
    return res.json() as { instanceStatus: string };
  };
  const decisionBody = z.object({ decision: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'), comment: z.string().max(1000).optional() });
  const approveChange = async (req: FastifyRequest, id: string, body: z.infer<typeof decisionBody>) => {
    const c = await app.db.selectFrom('salary_changes').select('hr_request_id').where('id', '=', id).executeTakeFirst();
    if (!c) throw notFound('Salary change', id);
    const wf = c.hr_request_id ? (await app.db.selectFrom('hr_requests').select('workflow_instance_id').where('id', '=', c.hr_request_id).executeTakeFirst())?.workflow_instance_id : null;
    await decide(req, wf, body);
    return changeMap(await changeQ().where('c.id', '=', id).executeTakeFirstOrThrow());
  };
  r.post('/changes/:id/approve', { preHandler: requirePermission('workflows:act'), schema: { tags: T, summary: 'Approve (or reject) my pending step on a salary change', params: idParam, body: decisionBody, response: { 200: changeOut, 403: errorSchema } } }, async (req) => approveChange(req, req.params.id, req.body));
  r.post('/increments/:id/approve', { preHandler: requirePermission('workflows:act'), schema: { tags: T, summary: 'Alias: approve (or reject) my pending step on an increment', params: idParam, body: decisionBody, response: { 200: changeOut, 403: errorSchema } } }, async (req) => approveChange(req, req.params.id, req.body));

  // ── Promotions ──
  const promoIn = z.object({ employeeId: z.string().uuid(), newGradeId: z.string().uuid(), newDesignationId: z.string().uuid().nullable().optional(), newDepartmentId: z.string().uuid().nullable().optional(), newSalary: z.number().min(0).max(10_000_000).nullable().optional(), effectiveDate: isoDate, justification: z.string().max(2000).nullable().optional() });
  r.post('/promotions/calculate', { preHandler: [requirePermission('compensation:propose', 'compensation:read'), requirePermission('salary:read')], schema: { tags: T, summary: 'Recommended promotion salary from the configured rule and the target grade band (no data written)', body: promoIn, response: { 200: z.unknown() } } }, async (req) => {
    const ev = await evaluatePromotion(app.db, req.body);
    return { employee: profileMap(ev.profile), targetGrade: ev.targetGrade, band: ev.band, rule: ev.rule, recommendedSalary: ev.recommended.recommendedSalary, explanation: ev.recommended.explanation, newSalary: ev.newSalary, increaseAmount: ev.increaseAmount, increasePct: ev.increasePct, position: ev.position, alerts: ev.alerts, requiresException: ev.requiresException, overrideReasons: ev.overrideReasons, budgetViolations: ev.budgetViolations, annualCost: ev.annualCost, blockers: ev.blockers };
  });
  const promoOut = z.object({ id: z.string(), promotionNo: z.string(), status: z.string(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string() }), currentTitle: z.string().nullable(), currentGrade: z.string().nullable(), currentSalary: z.number(), newTitle: z.string().nullable(), newGrade: z.string(), newDepartment: z.string().nullable(), recommendedSalary: z.number().nullable(), newSalary: z.number(), increasePct: z.number(), currency: z.string(), ruleExplanation: z.string().nullable(), effectiveDate: z.string(), promotionReason: z.string(), performanceRating: z.string().nullable(), managerRecommendation: z.string().nullable(), hrComments: z.string().nullable(), justification: z.string().nullable(), alerts: z.array(alertOut), salaryChangeId: z.string().nullable(), hrRequestId: z.string().nullable(), requestedBy: z.string().nullable(), approvedBy: z.string().nullable(), approvedAt: z.string().nullable(), createdAt: z.string() });
  const promoQ = () => app.db.selectFrom('promotion_requests as x').innerJoin('employees as e', 'e.id', 'x.employee_id').leftJoin('designations as ct', 'ct.id', 'x.current_designation_id').leftJoin('grades as cg', 'cg.id', 'x.current_grade_id').leftJoin('designations as nt', 'nt.id', 'x.new_designation_id').innerJoin('grades as ng', 'ng.id', 'x.new_grade_id').leftJoin('departments as nd', 'nd.id', 'x.new_department_id').leftJoin('users as rq', 'rq.id', 'x.requested_by').leftJoin('users as ap', 'ap.id', 'x.approved_by')
    .selectAll('x').select(['e.employee_no', 'e.full_name_en', 'ct.title as current_title', 'cg.code as current_grade', 'nt.title as new_title', 'ng.code as new_grade', 'nd.name as new_department', 'rq.display_name as requested_name', 'ap.display_name as approved_name']);
  const promoMap = (x: any) => ({ id: x.id, promotionNo: x.promotion_no, status: x.status, employee: { id: x.employee_id, employeeNo: x.employee_no, name: x.full_name_en }, currentTitle: x.current_title ?? null, currentGrade: x.current_grade ?? null, currentSalary: Number(x.current_salary), newTitle: x.new_title ?? null, newGrade: x.new_grade, newDepartment: x.new_department ?? null, recommendedSalary: num(x.recommended_salary), newSalary: Number(x.new_salary), increasePct: Number(x.current_salary) > 0 ? Math.round(((Number(x.new_salary) - Number(x.current_salary)) / Number(x.current_salary)) * 10000) / 100 : 0, currency: x.currency, ruleExplanation: x.rule_explanation, effectiveDate: x.effective_date, promotionReason: x.promotion_reason, performanceRating: x.performance_rating_code, managerRecommendation: x.manager_recommendation, hrComments: x.hr_comments, justification: x.justification, alerts: (x.alerts ?? []) as any[], salaryChangeId: x.salary_change_id, hrRequestId: x.hr_request_id, requestedBy: x.requested_name ?? null, approvedBy: x.approved_name ?? null, approvedAt: iso(x.approved_at), createdAt: iso(x.created_at)! });
  r.post('/promotions', { preHandler: [requirePermission('compensation:propose'), requirePermission('salary:read')], schema: { tags: T, summary: 'Create a promotion request (DRAFT; submit=true sends it for approval on COMP_PROMOTION)', body: promoIn.extend({ promotionReason: z.string().min(3).max(2000), managerRecommendation: z.string().max(2000).nullable().optional(), hrComments: z.string().max(2000).nullable().optional(), submit: z.boolean().default(false), overrideBudget: z.boolean().optional() }), response: { 201: promoOut, 422: errorSchema } } }, async (req, reply) => {
    const id = await createPromotion(app, req, requireAuth(req), req.body);
    return reply.status(201).send(promoMap(await promoQ().where('x.id', '=', id).executeTakeFirstOrThrow()));
  });
  r.get('/promotions', { preHandler: requirePermission('salary:read'), schema: { tags: T, summary: 'Promotion requests', querystring: paginationQuery.merge(z.object({ status: z.string().optional(), employeeId: z.string().uuid().optional(), year: z.coerce.number().int().optional() })), response: { 200: paginated(promoOut) } } }, async (req) => {
    let b = promoQ();
    if (req.query.status) b = b.where('x.status', '=', req.query.status);
    if (req.query.employeeId) b = b.where('x.employee_id', '=', req.query.employeeId);
    if (req.query.year) b = b.where('x.effective_date', '>=', `${req.query.year}-01-01`).where('x.effective_date', '<=', `${req.query.year}-12-31`);
    const total = Number((await b.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return { data: (await b.orderBy('x.created_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute()).map(promoMap), meta: pageMeta(req.query, total) };
  });
  r.get('/promotions/:id', { preHandler: requirePermission('salary:read'), schema: { tags: T, summary: 'Promotion request with approval trail', params: idParam, response: { 200: promoOut.extend({ approvals: z.array(approvalOut) }), 404: errorSchema } } }, async (req) => {
    const x = await promoQ().where('x.id', '=', req.params.id).executeTakeFirst();
    if (!x) throw notFound('Promotion', req.params.id);
    return { ...promoMap(x), approvals: await approvals('promotion_request', x.id) };
  });
  const promoChange = async (id: string) => { const x = await app.db.selectFrom('promotion_requests').select(['salary_change_id']).where('id', '=', id).executeTakeFirst(); if (!x?.salary_change_id) throw notFound('Promotion', id); return x.salary_change_id; };
  r.post('/promotions/:id/submit', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Submit a promotion for approval', params: idParam, body: z.object({ overrideBudget: z.boolean().optional() }).default({}), response: { 200: promoOut, 422: errorSchema } } }, async (req) => {
    await submitSalaryChange(app, req, requireAuth(req), await promoChange(req.params.id), req.body);
    return promoMap(await promoQ().where('x.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
  r.post('/promotions/:id/cancel', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Cancel a draft or pending promotion', params: idParam, body: z.object({ reason: z.string().min(1).max(500) }), response: { 200: promoOut } } }, async (req) => {
    await cancelSalaryChange(app, req, requireAuth(req), await promoChange(req.params.id), req.body.reason);
    return promoMap(await promoQ().where('x.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
  r.post('/promotions/:id/approve', { preHandler: requirePermission('workflows:act'), schema: { tags: T, summary: 'Approve (or reject) my pending step on a promotion', params: idParam, body: decisionBody, response: { 200: promoOut, 403: errorSchema } } }, async (req) => {
    await approveChange(req, await promoChange(req.params.id), req.body);
    return promoMap(await promoQ().where('x.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── My pending compensation approvals ──
  r.get('/approvals/pending', { preHandler: requirePermission('workflows:act'), schema: { tags: T, summary: 'Compensation items waiting for my decision (changes, promotions, reviews)', response: { 200: z.array(z.object({ taskId: z.string(), step: z.string(), kind: z.string(), id: z.string(), reference: z.string(), title: z.string(), status: z.string(), amount: z.number().nullable(), createdAt: z.string() })) } } }, async (req) => {
    const p = requireAuth(req);
    const tasks = await app.db.selectFrom('workflow_tasks as t').innerJoin('workflow_instances as i', 'i.id', 't.instance_id').select(['t.id', 't.step_key', 't.created_at', 'i.entity_type', 'i.entity_id'])
      .where('t.status', '=', 'PENDING').where((eb) => eb.or([eb('t.assignee_user_id', '=', p.userId), ...(p.roles.length ? [eb('t.assignee_role_code', 'in', p.roles)] : [])])).where('i.entity_type', 'in', ['hr_request', 'salary_review']).execute();
    const out = [];
    for (const t of tasks) {
      if (t.entity_type === 'salary_review') { const r = await app.db.selectFrom('salary_reviews').select(['id', 'name', 'status']).where('id', '=', t.entity_id).executeTakeFirst(); if (r) out.push({ taskId: t.id, step: t.step_key, kind: 'REVIEW', id: r.id, reference: r.name, title: `Salary review — ${r.name}`, status: r.status, amount: null, createdAt: iso(t.created_at)! }); continue; }
      const c = await app.db.selectFrom('salary_changes as c').innerJoin('employees as e', 'e.id', 'c.employee_id').select(['c.id', 'c.change_no', 'c.change_type', 'c.status', 'c.increase_amount', 'c.promotion_request_id', 'e.full_name_en']).where('c.hr_request_id', '=', t.entity_id).executeTakeFirst();
      if (c) out.push({ taskId: t.id, step: t.step_key, kind: c.promotion_request_id ? 'PROMOTION' : 'CHANGE', id: c.promotion_request_id ?? c.id, reference: c.change_no, title: `${c.change_type.replace(/_/g, ' ')} — ${c.full_name_en}`, status: c.status, amount: hasPermission(p, 'salary:read') ? Number(c.increase_amount) : null, createdAt: iso(t.created_at)! });
    }
    return out;
  });
};
