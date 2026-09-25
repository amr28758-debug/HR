import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { addTimeline } from '../hr-requests/timeline.js';

import { structureRoutes } from './structure.routes.js';
import { changeRoutes } from './changes.routes.js';
import { reviewRoutes } from './reviews.routes.js';
import { planningRoutes } from './planning.routes.js';
import { insightRoutes } from './insights.routes.js';

/**
 * Compensation center: deductions, bonuses, loans/advances (+ instalment schedules) and the compensation management module
 * (see docs/COMPENSATION.md).
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

  // ── Compensation management (salary structure, changes, promotions, reviews, budgets, scenarios, insights) ──
  // Increment cycles were superseded by salary reviews (/compensation/reviews) — same tables, renamed and extended in migration 0015.
  await app.register(structureRoutes);
  await app.register(changeRoutes);
  await app.register(reviewRoutes);
  await app.register(planningRoutes);
  await app.register(insightRoutes);
};
