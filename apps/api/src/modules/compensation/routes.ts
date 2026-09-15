import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { addTimeline } from '../hr-requests/timeline.js';

/**
 * Compensation center: deductions, bonuses, loans/advances (+ instalment schedules) and bulk increment cycles.
 * Creation of new items goes through HR requests (POST /hr-requests, type BONUS/DEDUCTION/LOAN/ADVANCE/SALARY_CHANGE);
 * this module lists, adjusts and runs increment cycles. Everything here is restricted (compensation:read/write).
 */
const empCols = ['e.employee_no', 'e.full_name_en', 'g.title as designation', 'd.name as department'] as const;
const empOut = z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), designation: z.string().nullable(), department: z.string().nullable() });
const emp = (x: any) => ({ id: x.employee_id, employeeNo: x.employee_no, name: x.full_name_en, designation: x.designation ?? null, department: x.department ?? null });
const period = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

export const compensationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const listQuery = paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), status: z.string().optional(), periodYear: z.coerce.number().int().optional(), periodMonth: z.coerce.number().int().optional() }));

  // ── Deductions ──
  const dedOut = z.object({ id: z.string(), employee: empOut, componentCode: z.string(), componentName: z.string(), amount: z.number(), reason: z.string(), deductionDate: z.string(), period: z.string(), source: z.string(), status: z.string(), hrRequestId: z.string().nullable(), payrollRunId: z.string().nullable(), createdAt: z.string() });
  const dedQ = () => app.db.selectFrom('employee_deductions as x').innerJoin('employees as e', 'e.id', 'x.employee_id').innerJoin('salary_components as c', 'c.id', 'x.component_id').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('departments as d', 'd.id', 'e.department_id').selectAll('x').select([...empCols, 'c.code as component_code', 'c.name as component_name']);
  const dedMap = (x: any) => ({ id: x.id, employee: emp(x), componentCode: x.component_code, componentName: x.component_name, amount: Number(x.amount), reason: x.reason, deductionDate: x.deduction_date, period: period(x.period_year, x.period_month), source: x.source, status: x.status, hrRequestId: x.hr_request_id, payrollRunId: x.payroll_run_id, createdAt: new Date(x.created_at).toISOString() });
  r.get('/deductions', { preHandler: requirePermission('compensation:read', 'salary:read:own'), schema: { tags: ['compensation'], summary: 'Deductions (restricted; employees see their own)', querystring: listQuery, response: { 200: paginated(dedOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = dedQ();
    if (!hasPermission(p, 'compensation:read')) q = q.where('x.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (req.query.employeeId) q = q.where('x.employee_id', '=', req.query.employeeId);
    if (req.query.status) q = q.where('x.status', '=', req.query.status.toUpperCase());
    if (req.query.periodYear) q = q.where('x.period_year', '=', req.query.periodYear);
    if (req.query.periodMonth) q = q.where('x.period_month', '=', req.query.periodMonth);
    const total = Number((await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return { data: (await q.orderBy('x.created_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute()).map(dedMap), meta: pageMeta(req.query, total) };
  });
  r.post('/deductions/:id/cancel', { preHandler: requirePermission('compensation:write'), schema: { tags: ['compensation'], summary: 'Cancel a deduction that has not been applied to payroll', params: idParam, body: z.object({ reason: z.string().max(500) }), response: { 200: dedOut, 422: errorSchema } } }, async (req) => {
    const x = await app.db.selectFrom('employee_deductions').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!x) throw notFound('Deduction', req.params.id);
    if (x.status === 'APPLIED') throw unprocessable('Deduction already applied in a payroll run');
    await app.db.updateTable('employee_deductions').set({ status: 'CANCELLED' }).where('id', '=', x.id).execute();
    await app.audit(req, { action: 'compensation.deduction.cancel', entityType: 'employee_deduction', entityId: x.id, oldValue: { status: x.status }, newValue: { status: 'CANCELLED' }, reason: req.body.reason });
    return dedMap(await dedQ().where('x.id', '=', x.id).executeTakeFirstOrThrow());
  });

  // ── Bonuses ──
  const bonusOut = z.object({ id: z.string(), employee: empOut, bonusType: z.string(), componentCode: z.string(), amount: z.number().nullable(), percentage: z.number().nullable(), reason: z.string(), period: z.string(), isRecurring: z.boolean(), recurringMonths: z.number().nullable(), status: z.string(), hrRequestId: z.string().nullable(), payrollRunId: z.string().nullable(), createdAt: z.string() });
  const bonusQ = () => app.db.selectFrom('employee_bonuses as x').innerJoin('employees as e', 'e.id', 'x.employee_id').innerJoin('salary_components as c', 'c.id', 'x.component_id').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('departments as d', 'd.id', 'e.department_id').selectAll('x').select([...empCols, 'c.code as component_code']);
  const bonusMap = (x: any) => ({ id: x.id, employee: emp(x), bonusType: x.bonus_type, componentCode: x.component_code, amount: x.amount === null ? null : Number(x.amount), percentage: x.percentage === null ? null : Number(x.percentage), reason: x.reason, period: period(x.period_year, x.period_month), isRecurring: x.is_recurring, recurringMonths: x.recurring_months, status: x.status, hrRequestId: x.hr_request_id, payrollRunId: x.payroll_run_id, createdAt: new Date(x.created_at).toISOString() });
  r.get('/bonuses', { preHandler: requirePermission('compensation:read', 'salary:read:own'), schema: { tags: ['compensation'], summary: 'Bonuses (restricted; employees see their own)', querystring: listQuery, response: { 200: paginated(bonusOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = bonusQ();
    if (!hasPermission(p, 'compensation:read')) q = q.where('x.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (req.query.employeeId) q = q.where('x.employee_id', '=', req.query.employeeId);
    if (req.query.status) q = q.where('x.status', '=', req.query.status.toUpperCase());
    if (req.query.periodYear) q = q.where('x.period_year', '=', req.query.periodYear);
    if (req.query.periodMonth) q = q.where('x.period_month', '=', req.query.periodMonth);
    const total = Number((await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return { data: (await q.orderBy('x.created_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute()).map(bonusMap), meta: pageMeta(req.query, total) };
  });
  r.post('/bonuses/:id/cancel', { preHandler: requirePermission('compensation:write'), schema: { tags: ['compensation'], summary: 'Cancel a bonus that has not been paid', params: idParam, body: z.object({ reason: z.string().max(500) }), response: { 200: bonusOut, 422: errorSchema } } }, async (req) => {
    const x = await app.db.selectFrom('employee_bonuses').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!x) throw notFound('Bonus', req.params.id);
    if (x.status === 'APPLIED') throw unprocessable('Bonus already applied in a payroll run');
    await app.db.updateTable('employee_bonuses').set({ status: 'CANCELLED' }).where('id', '=', x.id).execute();
    await app.audit(req, { action: 'compensation.bonus.cancel', entityType: 'employee_bonus', entityId: x.id, oldValue: { status: x.status }, newValue: { status: 'CANCELLED' }, reason: req.body.reason });
    return bonusMap(await bonusQ().where('x.id', '=', x.id).executeTakeFirstOrThrow());
  });

  // ── Loans & advances ──
  const instOut = z.object({ id: z.string(), period: z.string(), amount: z.number(), status: z.string(), payrollRunId: z.string().nullable() });
  const loanOut = z.object({ id: z.string(), employee: empOut, loanType: z.string(), principal: z.number(), installment: z.number(), outstanding: z.number(), startPeriod: z.string(), endPeriod: z.string().nullable(), status: z.string(), reason: z.string().nullable(), hrRequestId: z.string().nullable(), createdAt: z.string(), installments: z.array(instOut) });
  const loanQ = () => app.db.selectFrom('employee_loans as x').innerJoin('employees as e', 'e.id', 'x.employee_id').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('departments as d', 'd.id', 'e.department_id').selectAll('x').select([...empCols]);
  const loanMap = async (x: any) => ({ id: x.id, employee: emp(x), loanType: x.loan_type, principal: Number(x.principal), installment: Number(x.installment), outstanding: Number(x.outstanding), startPeriod: String(x.start_period).slice(0, 7), endPeriod: x.end_period ? String(x.end_period).slice(0, 7) : null, status: x.status, reason: x.reason ?? x.notes ?? null, hrRequestId: x.hr_request_id, createdAt: new Date(x.created_at).toISOString(),
    installments: (await app.db.selectFrom('loan_installments').selectAll().where('loan_id', '=', x.id).orderBy('period_year').orderBy('period_month').execute()).map((i) => ({ id: i.id, period: period(i.period_year, i.period_month), amount: Number(i.amount), status: i.status, payrollRunId: i.payroll_run_id })) });
  r.get('/loans', { preHandler: requirePermission('compensation:read', 'salary:read:own'), schema: { tags: ['compensation'], summary: 'Loans & advances with instalment schedules (restricted; employees see their own)', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), status: z.string().optional(), loanType: z.enum(['LOAN', 'ADVANCE']).optional() })), response: { 200: paginated(loanOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = loanQ();
    if (!hasPermission(p, 'compensation:read')) q = q.where('x.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (req.query.employeeId) q = q.where('x.employee_id', '=', req.query.employeeId);
    if (req.query.status) q = q.where('x.status', '=', req.query.status.toUpperCase());
    if (req.query.loanType) q = q.where('x.loan_type', '=', req.query.loanType);
    const total = Number((await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return { data: await Promise.all((await q.orderBy('x.created_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute()).map(loanMap)), meta: pageMeta(req.query, total) };
  });
  r.patch('/loans/:id', { preHandler: requirePermission('compensation:write'), schema: { tags: ['compensation'], summary: 'Pause / resume / close a loan, or reschedule its remaining instalments', params: idParam, body: z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']).optional(), installment: z.number().positive().optional(), reason: z.string().max(500) }), response: { 200: loanOut, 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const x = await app.db.selectFrom('employee_loans').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!x) throw notFound('Loan', req.params.id);
    if (x.status === 'CLOSED') throw unprocessable('Loan is closed');
    await app.db.transaction().execute(async (trx) => {
      const patch: Record<string, unknown> = {};
      if (req.body.status) patch.status = req.body.status;
      if (req.body.installment) {
        patch.installment = req.body.installment;
        // Rebuild the SCHEDULED instalments from the next open period onwards.
        const open = await trx.selectFrom('loan_installments').selectAll().where('loan_id', '=', x.id).where('status', '=', 'SCHEDULED').orderBy('period_year').orderBy('period_month').execute();
        await trx.deleteFrom('loan_installments').where('loan_id', '=', x.id).where('status', '=', 'SCHEDULED').execute();
        let remaining = Number(x.outstanding); let y = open[0]?.period_year ?? new Date().getFullYear(); let m = open[0]?.period_month ?? new Date().getMonth() + 1;
        while (remaining > 0.004) { const amt = Math.min(req.body.installment, Math.round(remaining * 100) / 100); await trx.insertInto('loan_installments').values({ loan_id: x.id, period_year: y, period_month: m, amount: amt }).execute(); remaining -= amt; m++; if (m > 12) { m = 1; y++; } }
        patch.end_period = `${y}-${String(m).padStart(2, '0')}-01`;
      }
      if (Object.keys(patch).length) await trx.updateTable('employee_loans').set(patch).where('id', '=', x.id).execute();
    });
    await app.audit(req, { action: 'compensation.loan.update', entityType: 'employee_loan', entityId: x.id, oldValue: { status: x.status, installment: Number(x.installment) }, newValue: req.body, reason: req.body.reason });
    await addTimeline(app.db, { employeeId: x.employee_id, type: x.loan_type, title: `${x.loan_type === 'ADVANCE' ? 'Advance' : 'Loan'} ${req.body.status ? req.body.status.toLowerCase() : 'rescheduled'}`, description: req.body.reason, refType: 'employee_loan', refId: x.id, actorUserId: p.userId, visibility: 'EMPLOYEE' });
    return loanMap(await loanQ().where('x.id', '=', x.id).executeTakeFirstOrThrow());
  });

  // ── Increment cycles (bulk) ──
  const cycleOut = z.object({ id: z.string(), name: z.string(), year: z.number(), effectiveDate: z.string(), defaultPercentage: z.number(), status: z.string(), filters: z.record(z.unknown()), notes: z.string().nullable(), createdAt: z.string(), approvedAt: z.string().nullable(), appliedAt: z.string().nullable(), stats: z.object({ entries: z.number(), included: z.number(), currentGross: z.number(), newGross: z.number(), costIncrease: z.number() }) });
  const entryOut = z.object({ id: z.string(), employee: empOut, gradeCode: z.string().nullable(), performanceRating: z.number().nullable(), currentBasic: z.number(), currentGross: z.number(), proposedPercentage: z.number(), proposedAmount: z.number(), newBasic: z.number(), newGross: z.number(), status: z.string(), note: z.string().nullable() });
  async function cycleStats(id: string) {
    const s = await app.db.selectFrom('increment_entries').select((eb) => [eb.fn.countAll<number>().as('entries'), eb.fn.count<number>('id').filterWhere('status', '!=', 'EXCLUDED').as('included'), eb.fn.sum<number>('current_gross').filterWhere('status', '!=', 'EXCLUDED').as('cur'), eb.fn.sum<number>('new_gross').filterWhere('status', '!=', 'EXCLUDED').as('nw')]).where('cycle_id', '=', id).executeTakeFirstOrThrow();
    const cur = Number(s.cur ?? 0), nw = Number(s.nw ?? 0);
    return { entries: Number(s.entries), included: Number(s.included), currentGross: cur, newGross: nw, costIncrease: Math.round((nw - cur) * 100) / 100 };
  }
  const cycleMap = async (c: any) => ({ id: c.id, name: c.name, year: c.cycle_year, effectiveDate: c.effective_date, defaultPercentage: Number(c.default_percentage), status: c.status, filters: c.filters ?? {}, notes: c.notes, createdAt: new Date(c.created_at).toISOString(), approvedAt: c.approved_at ? new Date(c.approved_at).toISOString() : null, appliedAt: c.applied_at ? new Date(c.applied_at).toISOString() : null, stats: await cycleStats(c.id) });
  const entryMap = (x: any) => ({ id: x.id, employee: emp(x), gradeCode: x.grade_code, performanceRating: x.performance_rating === null ? null : Number(x.performance_rating), currentBasic: Number(x.current_basic), currentGross: Number(x.current_gross), proposedPercentage: Number(x.proposed_percentage), proposedAmount: Number(x.proposed_amount), newBasic: Number(x.new_basic), newGross: Number(x.new_gross), status: x.status, note: x.note });
  const entryQ = (cycleId: string) => app.db.selectFrom('increment_entries as x').innerJoin('employees as e', 'e.id', 'x.employee_id').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('departments as d', 'd.id', 'e.department_id').selectAll('x').select([...empCols]).where('x.cycle_id', '=', cycleId);

  r.get('/increment-cycles', { preHandler: requirePermission('compensation:read'), schema: { tags: ['compensation'], summary: 'Increment cycles', response: { 200: z.array(cycleOut) } } }, async () => Promise.all((await app.db.selectFrom('increment_cycles').selectAll().orderBy('created_at', 'desc').execute()).map(cycleMap)));
  r.post('/increment-cycles', { preHandler: requirePermission('compensation:write'), schema: { tags: ['compensation'], summary: 'Create an increment cycle and populate entries from current salaries (filters: departmentIds, siteIds, projectIds, gradeIds)', body: z.object({ name: z.string().min(1), year: z.number().int(), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), defaultPercentage: z.number().min(0).max(100).default(0), filters: z.object({ departmentIds: z.array(z.string().uuid()).optional(), siteIds: z.array(z.string().uuid()).optional(), projectIds: z.array(z.string().uuid()).optional(), gradeIds: z.array(z.string().uuid()).optional() }).default({}), notes: z.string().max(2000).optional() }), response: { 201: cycleOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const b = req.body;
    const c = await app.db.transaction().execute(async (trx) => {
      const c = await trx.insertInto('increment_cycles').values({ name: b.name, cycle_year: b.year, effective_date: b.effectiveDate, default_percentage: b.defaultPercentage, filters: JSON.stringify(b.filters), notes: b.notes ?? null, created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
      let q = trx.selectFrom('employees as e').leftJoin('grades as g', 'g.id', 'e.grade_id').select(['e.id', 'g.code as grade_code']).where('e.deleted_at', 'is', null).where('e.status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED']);
      if (b.filters.departmentIds?.length) q = q.where('e.department_id', 'in', b.filters.departmentIds);
      if (b.filters.siteIds?.length) q = q.where('e.site_id', 'in', b.filters.siteIds);
      if (b.filters.projectIds?.length) q = q.where('e.project_id', 'in', b.filters.projectIds);
      if (b.filters.gradeIds?.length) q = q.where('e.grade_id', 'in', b.filters.gradeIds);
      const emps = await q.execute();
      const cycle = await trx.selectFrom('performance_cycles').select('id').where('cycle_year', '=', b.year).orderBy('created_at', 'desc').executeTakeFirst();
      for (const e of emps) {
        const ss = await trx.selectFrom('employee_salary_structures').select(['basic_salary', 'gross_salary']).where('employee_id', '=', e.id).orderBy('version', 'desc').executeTakeFirst();
        if (!ss) continue;
        const rating = cycle ? (await trx.selectFrom('performance_reviews').select('final_rating').where('cycle_id', '=', cycle.id).where('employee_id', '=', e.id).executeTakeFirst())?.final_rating ?? null : null;
        const basic = Number(ss.basic_salary), gross = Number(ss.gross_salary), pct = b.defaultPercentage;
        const nb = Math.round(basic * (1 + pct / 100) * 100) / 100, ng = Math.round(gross * (1 + pct / 100) * 100) / 100;
        await trx.insertInto('increment_entries').values({ cycle_id: c.id, employee_id: e.id, current_basic: basic, current_gross: gross, performance_rating: rating === null ? null : Number(rating), grade_code: e.grade_code, proposed_percentage: pct, proposed_amount: Math.round((ng - gross) * 100) / 100, new_basic: nb, new_gross: ng }).execute();
      }
      return c;
    });
    await app.audit(req, { action: 'compensation.increment_cycle.create', entityType: 'increment_cycle', entityId: c.id, newValue: b });
    return reply.status(201).send(await cycleMap(c));
  });
  r.get('/increment-cycles/:id', { preHandler: requirePermission('compensation:read'), schema: { tags: ['compensation'], summary: 'Increment cycle with entries', params: idParam, response: { 200: cycleOut.extend({ entries: z.array(entryOut) }) } } }, async (req) => {
    const c = await app.db.selectFrom('increment_cycles').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!c) throw notFound('Increment cycle', req.params.id);
    return { ...(await cycleMap(c)), entries: (await entryQ(c.id).orderBy('e.employee_no').execute()).map(entryMap) };
  });
  r.patch('/increment-cycles/:id/entries', { preHandler: requirePermission('compensation:write'), schema: { tags: ['compensation'], summary: 'Bulk edit entries (percentage or amount per employee; exclude/include). Only in DRAFT/IN_REVIEW.', params: idParam, body: z.object({ entries: z.array(z.object({ id: z.string().uuid(), percentage: z.number().min(0).max(100).optional(), amount: z.number().min(0).optional(), status: z.enum(['PROPOSED', 'EXCLUDED']).optional(), note: z.string().max(500).optional() })).min(1) }), response: { 200: z.object({ updated: z.number(), stats: cycleOut.shape.stats }) } } }, async (req) => {
    const c = await app.db.selectFrom('increment_cycles').select('status').where('id', '=', req.params.id).executeTakeFirst();
    if (!c) throw notFound('Increment cycle', req.params.id);
    if (!['DRAFT', 'IN_REVIEW'].includes(c.status)) throw unprocessable(`Cycle is ${c.status}`);
    let updated = 0;
    for (const e of req.body.entries) {
      const x = await app.db.selectFrom('increment_entries').selectAll().where('id', '=', e.id).where('cycle_id', '=', req.params.id).executeTakeFirst();
      if (!x) continue;
      const basic = Number(x.current_basic), gross = Number(x.current_gross);
      let pct = Number(x.proposed_percentage), amt = Number(x.proposed_amount);
      if (e.percentage !== undefined) { pct = e.percentage; amt = Math.round(gross * pct) / 100; }
      else if (e.amount !== undefined) { amt = e.amount; pct = gross ? Math.round((amt / gross) * 100000) / 1000 : 0; }
      const ng = Math.round((gross + amt) * 100) / 100, nb = Math.round(basic * (1 + pct / 100) * 100) / 100;
      await app.db.updateTable('increment_entries').set({ proposed_percentage: pct, proposed_amount: amt, new_basic: nb, new_gross: ng, ...(e.status && { status: e.status }), ...(e.note !== undefined && { note: e.note }) }).where('id', '=', x.id).execute();
      updated++;
    }
    await app.audit(req, { action: 'compensation.increment_cycle.edit', entityType: 'increment_cycle', entityId: req.params.id, newValue: { updated, ids: req.body.entries.map((e) => e.id) } });
    return { updated, stats: await cycleStats(req.params.id) };
  });
  r.post('/increment-cycles/:id/transition', { preHandler: requirePermission('compensation:write'), schema: { tags: ['compensation'], summary: 'DRAFT → IN_REVIEW → APPROVED → APPLIED (APPLIED creates a salary version per included employee, source INCREMENT). APPROVED/APPLIED need salary:write.', params: idParam, body: z.object({ to: z.enum(['IN_REVIEW', 'APPROVED', 'APPLIED', 'CANCELLED', 'DRAFT']), reason: z.string().max(500).optional() }), response: { 200: cycleOut.extend({ applied: z.number().optional(), failed: z.array(z.object({ employeeId: z.string(), error: z.string() })).optional() }), 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const c = await app.db.selectFrom('increment_cycles').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!c) throw notFound('Increment cycle', req.params.id);
    const allowed: Record<string, string[]> = { DRAFT: ['IN_REVIEW', 'CANCELLED'], IN_REVIEW: ['APPROVED', 'DRAFT', 'CANCELLED'], APPROVED: ['APPLIED', 'IN_REVIEW', 'CANCELLED'], APPLIED: [], CANCELLED: [] };
    if (!allowed[c.status]?.includes(req.body.to)) throw unprocessable(`Cannot move cycle from ${c.status} to ${req.body.to}`);
    if ((req.body.to === 'APPROVED' || req.body.to === 'APPLIED') && !hasPermission(p, 'salary:write')) throw badRequest('salary:write is required to approve or apply an increment cycle');
    let applied = 0; const failed: { employeeId: string; error: string }[] = [];
    if (req.body.to === 'APPLIED') {
      const { createHrRequest } = await import('../hr-requests/service.js');
      const entries = await app.db.selectFrom('increment_entries').selectAll().where('cycle_id', '=', c.id).where('status', 'in', ['PROPOSED', 'APPROVED']).execute();
      for (const e of entries) {
        try {
          // Each employee gets an INCREMENT request whose workflow is bypassed (the cycle itself was approved) → applied immediately.
          const before = await app.db.selectFrom('employee_salary_structures').select('version').where('employee_id', '=', e.employee_id).orderBy('version', 'desc').executeTakeFirst();
          const res = await createHrRequest(app, { type: 'INCREMENT', employeeId: e.employee_id, title: `${c.name} — increment ${Number(e.proposed_percentage)}%`, payload: { percentage: Number(e.proposed_percentage), cycleId: c.id }, effectiveDate: c.effective_date, reason: `Increment cycle ${c.name}`, requestedBy: p.userId, bypassWorkflow: true });
          const after = await app.db.selectFrom('employee_salary_structures').select(['id', 'version']).where('employee_id', '=', e.employee_id).orderBy('version', 'desc').executeTakeFirst();
          const ok = res.status === 'APPLIED' && after && after.version !== (before?.version ?? 0);
          await app.db.updateTable('increment_entries').set({ status: ok ? 'APPLIED' : 'APPROVED', hr_request_id: res.id, applied_salary_structure_id: ok ? after!.id : null }).where('id', '=', e.id).execute();
          if (ok) applied++; else failed.push({ employeeId: e.employee_id, error: `request ${res.status}` });
        } catch (err) { failed.push({ employeeId: e.employee_id, error: (err as Error).message }); }
      }
    }
    await app.db.updateTable('increment_cycles').set({ status: req.body.to, ...(req.body.to === 'APPROVED' && { approved_by: p.userId, approved_at: new Date() }), ...(req.body.to === 'APPLIED' && { applied_at: new Date() }) }).where('id', '=', c.id).execute();
    await app.audit(req, { action: `compensation.increment_cycle.${req.body.to.toLowerCase()}`, entityType: 'increment_cycle', entityId: c.id, oldValue: { status: c.status }, newValue: { status: req.body.to, applied, failed }, reason: req.body.reason });
    return { ...(await cycleMap(await app.db.selectFrom('increment_cycles').selectAll().where('id', '=', c.id).executeTakeFirstOrThrow())), applied, failed };
  });

  // ── Grade band check (used by promotion/salary forms) ──
  r.get('/grade-check', { preHandler: requirePermission('compensation:read'), schema: { tags: ['compensation'], summary: 'Where a proposed basic sits within a grade band', querystring: z.object({ gradeId: z.string().uuid(), basic: z.coerce.number() }), response: { 200: z.object({ grade: z.string(), min: z.number().nullable(), mid: z.number().nullable(), max: z.number().nullable(), position: z.enum(['BELOW_MIN', 'IN_BAND', 'ABOVE_MAX', 'NO_BAND']), compaRatio: z.number().nullable() }) } } }, async (req) => {
    const g = await app.db.selectFrom('grades').selectAll().where('id', '=', req.query.gradeId).executeTakeFirst();
    if (!g) throw notFound('Grade', req.query.gradeId);
    const min = g.min_salary === null ? null : Number(g.min_salary), mid = g.mid_salary === null ? null : Number(g.mid_salary), max = g.max_salary === null ? null : Number(g.max_salary);
    const position: 'BELOW_MIN' | 'IN_BAND' | 'ABOVE_MAX' | 'NO_BAND' = min === null || max === null ? 'NO_BAND' : req.query.basic < min ? 'BELOW_MIN' : req.query.basic > max ? 'ABOVE_MAX' : 'IN_BAND';
    return { grade: g.code, min, mid, max, position, compaRatio: mid ? Math.round((req.query.basic / mid) * 1000) / 1000 : null };
  });

};
