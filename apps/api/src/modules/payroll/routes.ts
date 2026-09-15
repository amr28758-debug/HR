import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { monthRange, PAYROLL_VARIABLES, validateFormula } from '@burtplace/core';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { lockTimesheet } from '../timesheets/service.js';
import { startWorkflow } from '../workflows/service.js';
import { calculateRun, PAYROLL_TRANSITIONS } from './service.js';

const n = (v: unknown) => Number(v);
const runOut = z.object({ id: z.string(), code: z.string(), year: z.number(), month: z.number(), periodStart: z.string(), periodEnd: z.string(), paymentDate: z.string().nullable(), status: z.string(), currency: z.string(), employeeCount: z.number(), totalGross: z.number(), totalEarnings: z.number(), totalDeductions: z.number(), totalNet: z.number(), filters: z.unknown(), notes: z.string().nullable(), createdAt: z.string(), lockedAt: z.string().nullable(), paidAt: z.string().nullable(), allowedTransitions: z.array(z.string()) });
const runMap = (r: Record<string, any>) => ({ id: r.id, code: r.code, year: r.period_year, month: r.period_month, periodStart: r.period_start, periodEnd: r.period_end, paymentDate: r.payment_date, status: r.status, currency: r.currency, employeeCount: r.employee_count, totalGross: n(r.total_gross), totalEarnings: n(r.total_earnings), totalDeductions: n(r.total_deductions), totalNet: n(r.total_net), filters: r.filters, notes: r.notes, createdAt: new Date(r.created_at).toISOString(), lockedAt: r.locked_at ? new Date(r.locked_at).toISOString() : null, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null, allowedTransitions: (PAYROLL_TRANSITIONS[r.status] ?? []).map((t) => t.to) });
const lineOut = z.object({ componentCode: z.string(), description: z.string().nullable(), quantity: z.number().nullable(), rate: z.number().nullable(), amount: z.number(), isAdjustment: z.boolean() });
const peOut = z.object({ id: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), departmentName: z.string().nullable(), siteName: z.string().nullable(), projectCode: z.string().nullable(), basicSalary: z.number(), grossSalary: z.number(), dailyRate: z.number(), hourlyRate: z.number(), workedDays: z.number(), paidDays: z.number(), unpaidLeaveDays: z.number(), absentDays: z.number(), overtimeMinutes: z.number(), totalEarnings: z.number(), totalDeductions: z.number(), netSalary: z.number(), hasExceptions: z.boolean(), exceptions: z.array(z.string()), bankIban: z.string().nullable() });
const peMap = (p: Record<string, any>) => ({ id: p.id, employeeId: p.employee_id, employeeNo: p.employee_no, employeeName: p.employee_name, departmentName: p.department_name ?? null, siteName: p.site_name ?? null, projectCode: p.project_code ?? null, basicSalary: n(p.basic_salary), grossSalary: n(p.gross_salary), dailyRate: n(p.daily_rate), hourlyRate: n(p.hourly_rate), workedDays: n(p.worked_days), paidDays: n(p.paid_days), unpaidLeaveDays: n(p.unpaid_leave_days), absentDays: n(p.absent_days), overtimeMinutes: p.overtime_minutes, totalEarnings: n(p.total_earnings), totalDeductions: n(p.total_deductions), netSalary: n(p.net_salary), hasExceptions: p.has_exceptions, exceptions: (p.exceptions ?? []) as string[], bankIban: p.bank_iban });

export const payrollRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const peQuery = () => app.db.selectFrom('payroll_employees as p').leftJoin('departments as d', 'd.id', 'p.department_id').leftJoin('sites as s', 's.id', 'p.site_id').leftJoin('projects as pr', 'pr.id', 'p.project_id').selectAll('p').select(['d.name as department_name', 's.name as site_name', 'pr.code as project_code']);

  // Policies & components
  r.get('/policies', { preHandler: requirePermission('payroll:read'), schema: { tags: ['payroll'], summary: 'Payroll policies (versioned formulas)', response: { 200: z.array(z.object({ id: z.string(), code: z.string(), version: z.number(), name: z.string(), effectiveFrom: z.string(), effectiveTo: z.string().nullable(), isStatutory: z.boolean(), config: z.unknown(), notes: z.string().nullable(), variables: z.array(z.string()) })) } } }, async () => (await app.db.selectFrom('payroll_policies').selectAll().orderBy('code').orderBy('version', 'desc').execute()).map((p) => ({ id: p.id, code: p.code, version: p.version, name: p.name, effectiveFrom: p.effective_from, effectiveTo: p.effective_to, isStatutory: p.is_statutory, config: p.config, notes: p.notes, variables: PAYROLL_VARIABLES })));
  r.post('/policies', { preHandler: requirePermission('payroll:run'), schema: { tags: ['payroll'], summary: 'Create a new policy version (formulas validated; previous version closed)', body: z.object({ code: z.string().default('DEFAULT'), name: z.string().min(1), effectiveFrom: z.string(), isStatutory: z.boolean().default(false), notes: z.string().optional(), config: z.object({ daysInMonthDivisor: z.number().positive(), hoursPerDay: z.number().positive(), rateBase: z.enum(['GROSS', 'BASIC']), overtime: z.object({ NORMAL: z.number(), WEEK_OFF: z.number(), PUBLIC_HOLIDAY: z.number() }), lateDeduction: z.object({ enabled: z.boolean(), perMinute: z.boolean(), graceMinutesPerMonth: z.number() }), earlyLeaveDeduction: z.object({ enabled: z.boolean(), perMinute: z.boolean() }), absenceDeductionDays: z.number(), rounding: z.number().int().min(0).max(4), formulas: z.record(z.string()), treatMissingPunchAsPresent: z.boolean().optional() }) }), response: { 201: z.object({ id: z.string(), version: z.number() }), 400: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    for (const [k, f] of Object.entries(req.body.config.formulas)) { const v = validateFormula(f, [...PAYROLL_VARIABLES, 'daily_rate', 'hourly_rate']); if (!v.ok) throw badRequest(`Formula ${k} invalid: ${v.error}`); }
    const prev = await app.db.selectFrom('payroll_policies').select(['id', 'version']).where('code', '=', req.body.code).orderBy('version', 'desc').executeTakeFirst();
    const row = await app.db.transaction().execute(async (trx) => {
      if (prev) await trx.updateTable('payroll_policies').set({ effective_to: req.body.effectiveFrom }).where('id', '=', prev.id).where('effective_to', 'is', null).execute();
      return trx.insertInto('payroll_policies').values({ code: req.body.code, version: (prev?.version ?? 0) + 1, name: req.body.name, effective_from: req.body.effectiveFrom, is_statutory: req.body.isStatutory, config: JSON.stringify(req.body.config), notes: req.body.notes ?? null, created_by: p.userId }).returning(['id', 'version']).executeTakeFirstOrThrow();
    });
    await app.audit(req, { action: 'payroll.policy.create', entityType: 'payroll_policy', entityId: row.id, newValue: req.body });
    return reply.status(201).send(row);
  });
  r.get('/components', { preHandler: requirePermission('payroll:read', 'salary:read'), schema: { tags: ['payroll'], summary: 'Salary components', response: { 200: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), calcMethod: z.string(), isFixedPay: z.boolean(), sortOrder: z.number(), isActive: z.boolean() })) } } }, async () => (await app.db.selectFrom('salary_components').selectAll().orderBy('sort_order').execute()).map((c) => ({ id: c.id, code: c.code, name: c.name, kind: c.kind, calcMethod: c.calc_method, isFixedPay: c.is_fixed_pay, sortOrder: c.sort_order, isActive: c.is_active })));

  // Runs
  r.get('/runs', { preHandler: requirePermission('payroll:read'), schema: { tags: ['payroll'], summary: 'Payroll runs', response: { 200: z.array(runOut) } } }, async () => (await app.db.selectFrom('payroll_runs').selectAll().orderBy('period_year', 'desc').orderBy('period_month', 'desc').execute()).map(runMap));
  r.post('/runs', { preHandler: requirePermission('payroll:run'), schema: { tags: ['payroll'], summary: 'Create a payroll run for a period', body: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), paymentDate: z.string().optional(), notes: z.string().optional(), filters: z.object({ siteIds: z.array(z.string().uuid()).optional(), departmentIds: z.array(z.string().uuid()).optional(), projectIds: z.array(z.string().uuid()).optional() }).default({}) }), response: { 201: runOut, 409: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const { start, end } = monthRange(req.body.year, req.body.month);
    const run = await app.db.insertInto('payroll_runs').values({ code: `PR-${req.body.year}-${String(req.body.month).padStart(2, '0')}`, period_year: req.body.year, period_month: req.body.month, period_start: start, period_end: end, payment_date: req.body.paymentDate ?? null, notes: req.body.notes ?? null, filters: JSON.stringify(req.body.filters), created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'payroll.run.create', entityType: 'payroll_run', entityId: run.id, newValue: req.body });
    return reply.status(201).send(runMap(run));
  });
  r.get('/runs/:id', { preHandler: requirePermission('payroll:read'), schema: { tags: ['payroll'], summary: 'Payroll run', params: idParam, response: { 200: runOut, 404: errorSchema } } }, async (req) => { const run = await app.db.selectFrom('payroll_runs').selectAll().where('id', '=', req.params.id).executeTakeFirst(); if (!run) throw notFound('Payroll run', req.params.id); return runMap(run); });
  r.post('/runs/:id/calculate', { preHandler: requirePermission('payroll:run'), schema: { tags: ['payroll'], summary: 'Calculate the run from timesheets + salary structures + policy (re-runnable until FINANCE_REVIEW)', params: idParam, response: { 200: z.object({ employees: z.number(), totals: z.object({ gross: z.number(), earnings: z.number(), deductions: z.number(), net: z.number() }), exceptions: z.number() }), 422: errorSchema } } }, async (req) => {
    const res = await calculateRun(app.db, req.params.id);
    await app.audit(req, { action: 'payroll.run.calculate', entityType: 'payroll_run', entityId: req.params.id, metadata: res });
    return res;
  });
  r.post('/runs/:id/transition', { preHandler: requirePermission('payroll:run', 'payroll:review:hr', 'payroll:review:finance', 'payroll:approve', 'payroll:lock', 'payroll:pay'), schema: { tags: ['payroll'], summary: 'Move a run through DRAFT → HR_REVIEW → FINANCE_REVIEW → MANAGEMENT_APPROVAL → APPROVED → LOCKED → BANK_WPS → PAID → CLOSED', params: idParam, body: z.object({ to: z.string(), note: z.string().max(1000).optional() }), response: { 200: runOut, 403: errorSchema, 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const run = await app.db.selectFrom('payroll_runs').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!run) throw notFound('Payroll run', req.params.id);
    const edge = (PAYROLL_TRANSITIONS[run.status] ?? []).find((t) => t.to === req.body.to);
    if (!edge) throw unprocessable(`Cannot move from ${run.status} to ${req.body.to}`);
    if (!hasPermission(p, edge.permission)) throw forbidden(`Requires ${edge.permission}`);
    if (req.body.to === 'FINANCE_REVIEW') { const ex = await app.db.selectFrom('payroll_employees').select((eb) => eb.fn.countAll<number>().as('n')).where('payroll_run_id', '=', run.id).where('has_exceptions', '=', true).executeTakeFirstOrThrow(); if (Number(ex.n) > 0 && !req.body.note) throw unprocessable(`${ex.n} employee(s) have exceptions; provide a note acknowledging them to proceed`); }
    const now = new Date();
    const stamps: Record<string, object> = { FINANCE_REVIEW: { hr_reviewed_by: p.userId, hr_reviewed_at: now }, MANAGEMENT_APPROVAL: { finance_reviewed_by: p.userId, finance_reviewed_at: now }, APPROVED: { approved_by: p.userId, approved_at: now }, LOCKED: { locked_by: p.userId, locked_at: now }, PAID: { paid_at: now }, CLOSED: { closed_at: now } };
    await app.db.transaction().execute(async (trx) => {
      await trx.updateTable('payroll_runs').set({ status: req.body.to as any, ...(stamps[req.body.to] ?? {}) }).where('id', '=', run.id).execute();
      if (req.body.to === 'LOCKED') {
        const tsIds = await trx.selectFrom('payroll_employees').select('timesheet_id').where('payroll_run_id', '=', run.id).where('timesheet_id', 'is not', null).execute();
        for (const t of tsIds) await lockTimesheet(trx, t.timesheet_id!);
        await trx.updateTable('payroll_adjustments').set({ status: 'APPLIED', applied_at: now, target_run_id: run.id }).where('status', '=', 'APPROVED').where('id', 'in', (eb) => eb.selectFrom('payroll_earnings').select('adjustment_id').where('adjustment_id', 'is not', null).where('payroll_employee_id', 'in', eb.selectFrom('payroll_employees').select('id').where('payroll_run_id', '=', run.id))).execute();
        await trx.updateTable('payroll_adjustments').set({ status: 'APPLIED', applied_at: now, target_run_id: run.id }).where('status', '=', 'APPROVED').where('id', 'in', (eb) => eb.selectFrom('payroll_deductions').select('adjustment_id').where('adjustment_id', 'is not', null).where('payroll_employee_id', 'in', eb.selectFrom('payroll_employees').select('id').where('payroll_run_id', '=', run.id))).execute();
        // reduce loan outstanding
        const loanLines = await trx.selectFrom('payroll_deductions as d').innerJoin('payroll_employees as pe', 'pe.id', 'd.payroll_employee_id').select(['pe.employee_id', 'd.component_code', 'd.amount']).where('pe.payroll_run_id', '=', run.id).where('d.component_code', 'in', ['LOAN', 'ADVANCE']).execute();
        for (const l of loanLines) await trx.updateTable('employee_loans').set((eb) => ({ outstanding: eb('outstanding', '-', Number(l.amount)) })).where('employee_id', '=', l.employee_id).where('loan_type', '=', l.component_code).where('status', '=', 'ACTIVE').execute();
        await trx.updateTable('employee_loans').set({ status: 'CLOSED' }).where('outstanding', '<=', 0).where('status', '=', 'ACTIVE').execute();
        // instalment schedule, approved deductions and one-off bonuses for this period are now APPLIED
        await trx.updateTable('loan_installments').set({ status: 'DEDUCTED', payroll_run_id: run.id }).where('status', '=', 'SCHEDULED').where('period_year', '=', run.period_year).where('period_month', '=', run.period_month).where('loan_id', 'in', (eb) => eb.selectFrom('employee_loans').select('id').where('employee_id', 'in', eb.selectFrom('payroll_employees').select('employee_id').where('payroll_run_id', '=', run.id))).execute();
        await trx.updateTable('employee_deductions').set({ status: 'APPLIED', payroll_run_id: run.id }).where('status', '=', 'APPROVED').where('period_year', '=', run.period_year).where('period_month', '=', run.period_month).where('employee_id', 'in', (eb) => eb.selectFrom('payroll_employees').select('employee_id').where('payroll_run_id', '=', run.id)).execute();
        await trx.updateTable('employee_bonuses').set({ status: 'APPLIED', payroll_run_id: run.id }).where('status', '=', 'APPROVED').where('is_recurring', '=', false).where('period_year', '=', run.period_year).where('period_month', '=', run.period_month).where('employee_id', 'in', (eb) => eb.selectFrom('payroll_employees').select('employee_id').where('payroll_run_id', '=', run.id)).execute();
        // payslip records
        const pes = await trx.selectFrom('payroll_employees').select(['id', 'employee_no']).where('payroll_run_id', '=', run.id).execute();
        for (const pe of pes) await trx.insertInto('payslips').values({ payroll_employee_id: pe.id, payslip_no: `${run.code}-${pe.employee_no}` }).onConflict((oc) => oc.doNothing()).execute();
      }
    });
    await app.audit(req, { action: `payroll.run.${req.body.to.toLowerCase()}`, entityType: 'payroll_run', entityId: run.id, oldValue: { status: run.status }, newValue: { status: req.body.to }, reason: req.body.note });
    return runMap(await app.db.selectFrom('payroll_runs').selectAll().where('id', '=', run.id).executeTakeFirstOrThrow());
  });
  r.get('/runs/:id/employees', { preHandler: requirePermission('payroll:read'), schema: { tags: ['payroll'], summary: 'Payroll register (employees in a run)', params: idParam, querystring: paginationQuery.merge(z.object({ q: z.string().optional(), exceptionsOnly: z.coerce.boolean().optional(), siteId: z.string().uuid().optional(), projectId: z.string().uuid().optional() })), response: { 200: paginated(peOut) } } }, async (req) => {
    const q = req.query;
    let base = peQuery().where('p.payroll_run_id', '=', req.params.id);
    if (q.q) base = base.where((eb) => eb.or([eb('p.employee_no', 'ilike', `%${q.q}%`), eb('p.employee_name', 'ilike', `%${q.q}%`)]));
    if (q.exceptionsOnly) base = base.where('p.has_exceptions', '=', true);
    if (q.siteId) base = base.where('p.site_id', '=', q.siteId);
    if (q.projectId) base = base.where('p.project_id', '=', q.projectId);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('p.employee_no').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(peMap), meta: pageMeta(q, total) };
  });
  r.get('/employees/:id', { preHandler: requirePermission('payroll:read', 'payslips:read:own'), schema: { tags: ['payroll'], summary: 'Payroll detail for one employee in a run (payslip data)', params: idParam, response: { 200: peOut.extend({ run: runOut, earnings: z.array(lineOut), deductions: z.array(lineOut), trace: z.unknown().nullable(), timesheetId: z.string().nullable(), payslipNo: z.string().nullable() }) } } }, async (req) => {
    const p = requireAuth(req);
    const pe = await peQuery().where('p.id', '=', req.params.id).executeTakeFirst();
    if (!pe) throw notFound('Payroll employee', req.params.id);
    if (!hasPermission(p, 'payroll:read') && pe.employee_id !== p.employeeId) throw forbidden();
    const run = await app.db.selectFrom('payroll_runs').selectAll().where('id', '=', pe.payroll_run_id).executeTakeFirstOrThrow();
    if (!hasPermission(p, 'payroll:read') && !['LOCKED', 'BANK_WPS', 'PAID', 'CLOSED'].includes(run.status)) throw notFound('Payslip');
    const earnings = await app.db.selectFrom('payroll_earnings').selectAll().where('payroll_employee_id', '=', pe.id).execute();
    const deductions = await app.db.selectFrom('payroll_deductions').selectAll().where('payroll_employee_id', '=', pe.id).execute();
    const slip = await app.db.selectFrom('payslips').select('payslip_no').where('payroll_employee_id', '=', pe.id).executeTakeFirst();
    const lm = (l: Record<string, any>) => ({ componentCode: l.component_code, description: l.description, quantity: l.quantity === null ? null : n(l.quantity), rate: l.rate === null ? null : n(l.rate), amount: n(l.amount), isAdjustment: l.is_adjustment });
    return { ...peMap(pe), run: runMap(run), earnings: earnings.map(lm), deductions: deductions.map(lm), trace: hasPermission(p, 'payroll:read') ? pe.calculation_trace : null, timesheetId: pe.timesheet_id, payslipNo: slip?.payslip_no ?? null };
  });
  r.get('/my-payslips', { preHandler: requirePermission('payslips:read:own'), schema: { tags: ['payroll'], summary: 'Published payslips for the current employee', response: { 200: z.array(z.object({ payrollEmployeeId: z.string(), payslipNo: z.string(), year: z.number(), month: z.number(), netSalary: z.number(), status: z.string() })) } } }, async (req) => {
    const p = requireAuth(req);
    if (!p.employeeId) return [];
    const rows = await app.db.selectFrom('payslips as s').innerJoin('payroll_employees as pe', 'pe.id', 's.payroll_employee_id').innerJoin('payroll_runs as r', 'r.id', 'pe.payroll_run_id').select(['pe.id', 's.payslip_no', 'r.period_year', 'r.period_month', 'pe.net_salary', 'r.status']).where('pe.employee_id', '=', p.employeeId).where('r.status', 'in', ['LOCKED', 'BANK_WPS', 'PAID', 'CLOSED']).orderBy('r.period_year', 'desc').orderBy('r.period_month', 'desc').execute();
    return rows.map((x) => ({ payrollEmployeeId: x.id, payslipNo: x.payslip_no, year: x.period_year, month: x.period_month, netSalary: n(x.net_salary), status: x.status }));
  });

  // Adjustments (post-lock changes)
  const adjOut = z.object({ id: z.string(), employeeId: z.string(), componentCode: z.string(), amount: z.number(), reason: z.string(), status: z.string(), originRunId: z.string().nullable(), targetRunId: z.string().nullable(), createdAt: z.string() });
  r.get('/adjustments', { preHandler: requirePermission('payroll:read'), schema: { tags: ['payroll'], summary: 'Payroll adjustments', querystring: z.object({ status: z.string().optional(), employeeId: z.string().uuid().optional() }), response: { 200: z.array(adjOut) } } }, async (req) => {
    let q = app.db.selectFrom('payroll_adjustments as a').innerJoin('salary_components as c', 'c.id', 'a.component_id').selectAll('a').select('c.code');
    if (req.query.status) q = q.where('a.status', '=', req.query.status);
    if (req.query.employeeId) q = q.where('a.employee_id', '=', req.query.employeeId);
    return (await q.orderBy('a.created_at', 'desc').limit(500).execute()).map((a) => ({ id: a.id, employeeId: a.employee_id, componentCode: a.code, amount: n(a.amount), reason: a.reason, status: a.status, originRunId: a.origin_run_id, targetRunId: a.target_run_id, createdAt: new Date(a.created_at).toISOString() }));
  });
  r.post('/adjustments', { preHandler: requirePermission('payroll:adjust'), schema: { tags: ['payroll'], summary: 'Request an adjustment (applied to the next unlocked run after approval)', body: z.object({ employeeId: z.string().uuid(), componentCode: z.string(), amount: z.number(), reason: z.string().min(5).max(1000), originRunId: z.string().uuid().optional(), targetRunId: z.string().uuid().optional() }), response: { 201: adjOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const comp = await app.db.selectFrom('salary_components').select(['id', 'code']).where('code', '=', req.body.componentCode).executeTakeFirst();
    if (!comp) throw badRequest('Unknown component');
    const a = await app.db.insertInto('payroll_adjustments').values({ employee_id: req.body.employeeId, component_id: comp.id, amount: req.body.amount, reason: req.body.reason, origin_run_id: req.body.originRunId ?? null, target_run_id: req.body.targetRunId ?? null, requested_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    const wf = await startWorkflow(app.db, { code: 'PAYROLL_ADJUSTMENT', entityType: 'payroll_adjustment', entityId: a.id, initiatedBy: p.userId, context: { employeeId: req.body.employeeId, amount: req.body.amount } });
    if (wf) await app.db.updateTable('payroll_adjustments').set({ workflow_instance_id: wf }).where('id', '=', a.id).execute();
    await app.audit(req, { action: 'payroll.adjustment.request', entityType: 'payroll_adjustment', entityId: a.id, newValue: req.body, reason: req.body.reason, approvalRef: wf });
    return reply.status(201).send({ id: a.id, employeeId: a.employee_id, componentCode: comp.code, amount: n(a.amount), reason: a.reason, status: a.status, originRunId: a.origin_run_id, targetRunId: a.target_run_id, createdAt: new Date(a.created_at).toISOString() });
  });
  r.post('/adjustments/:id/decide', { preHandler: requirePermission('payroll:approve', 'payroll:review:finance'), schema: { tags: ['payroll'], summary: 'Approve/reject an adjustment', params: idParam, body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().optional() }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const p = requireAuth(req);
    const res = await app.db.updateTable('payroll_adjustments').set({ status: req.body.decision, approved_by: p.userId, approved_at: new Date() }).where('id', '=', req.params.id).where('status', '=', 'PENDING').returning('id').executeTakeFirst();
    if (!res) throw badRequest('Adjustment not pending');
    await app.audit(req, { action: `payroll.adjustment.${req.body.decision.toLowerCase()}`, entityType: 'payroll_adjustment', entityId: req.params.id, reason: req.body.note });
    return { ok: true };
  });

  // Loans
  r.post('/loans', { preHandler: requirePermission('payroll:adjust'), schema: { tags: ['payroll'], summary: 'Register a loan/advance (deducted per run until settled)', body: z.object({ employeeId: z.string().uuid(), loanType: z.enum(['LOAN', 'ADVANCE']).default('LOAN'), principal: z.number().positive(), installment: z.number().positive(), startPeriod: z.string(), notes: z.string().optional() }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const p = requireAuth(req);
    const l = await app.db.insertInto('employee_loans').values({ employee_id: req.body.employeeId, loan_type: req.body.loanType, principal: req.body.principal, installment: req.body.installment, outstanding: req.body.principal, start_period: req.body.startPeriod, notes: req.body.notes ?? null, created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'payroll.loan.create', entityType: 'employee_loan', entityId: l.id, newValue: req.body });
    return reply.status(201).send({ id: l.id });
  });

  // Bank / WPS export — generic bank file. UAE WPS SIF format REQUIRES MOHRE/BANK SPECIFICATION CONFIRMATION before use.
  r.get('/runs/:id/bank-file', { preHandler: requirePermission('payroll:pay'), schema: { tags: ['payroll'], summary: 'Generic CSV bank transfer file for a LOCKED+ run. NOTE: not a certified WPS SIF; the SIF layout REQUIRES VENDOR/BANK CONFIRMATION.', params: idParam, produces: ['text/csv'] } }, async (req, reply) => {
    const run = await app.db.selectFrom('payroll_runs').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!run) throw notFound('Payroll run', req.params.id);
    if (!['LOCKED', 'BANK_WPS', 'PAID', 'CLOSED'].includes(run.status)) throw unprocessable('Run must be LOCKED before exporting a bank file');
    const rows = await app.db.selectFrom('payroll_employees').select(['employee_no', 'employee_name', 'bank_iban', 'net_salary', 'paid_days', 'basic_salary']).where('payroll_run_id', '=', run.id).orderBy('employee_no').execute();
    const csv = ['employee_no,employee_name,iban,net_salary,paid_days,currency,period', ...rows.map((x) => [x.employee_no, `"${x.employee_name.replace(/"/g, '""')}"`, x.bank_iban ?? '', n(x.net_salary).toFixed(2), n(x.paid_days), run.currency, `${run.period_year}-${String(run.period_month).padStart(2, '0')}`].join(','))].join('\n');
    await app.audit(req, { action: 'payroll.bank_file.export', entityType: 'payroll_run', entityId: run.id, metadata: { rows: rows.length } });
    return reply.header('content-type', 'text/csv').header('content-disposition', `attachment; filename="${run.code}-bank.csv"`).send(csv);
  });
};
