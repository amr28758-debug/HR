import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { countLeaveDays, eachDate } from '@burtplace/core';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission, resolveScope } from '../../plugins/rbac.js';
import { assertCanSeeEmployee, teamEmployeeIds } from '../employees/service.js';
import { loadScheduleContext, resolveFor } from '../attendance/processor.service.js';
import { startWorkflow } from '../workflows/service.js';
import { applyLeaveDecision, runMonthlyAccrual } from './service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lrOut = z.object({ id: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), leaveTypeCode: z.string(), leaveTypeName: z.string(), startDate: z.string(), endDate: z.string(), isHalfDay: z.boolean(), halfDayPart: z.string().nullable(), totalDays: z.number(), reason: z.string().nullable(), status: z.string(), workflowInstanceId: z.string().nullable(), decidedAt: z.string().nullable(), decisionNote: z.string().nullable(), createdAt: z.string() });
const lrMap = (l: Record<string, any>) => ({ id: l.id, employeeId: l.employee_id, employeeNo: l.employee_no, employeeName: l.full_name_en, leaveTypeCode: l.lt_code, leaveTypeName: l.lt_name, startDate: l.start_date, endDate: l.end_date, isHalfDay: l.is_half_day, halfDayPart: l.half_day_part, totalDays: Number(l.total_days), reason: l.reason, status: l.status, workflowInstanceId: l.workflow_instance_id, decidedAt: l.decided_at ? new Date(l.decided_at).toISOString() : null, decisionNote: l.decision_note, createdAt: new Date(l.created_at).toISOString() });

export const leaveRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const query = () => app.db.selectFrom('leave_requests as l').innerJoin('employees as e', 'e.id', 'l.employee_id').innerJoin('leave_types as lt', 'lt.id', 'l.leave_type_id').selectAll('l').select(['e.employee_no', 'e.full_name_en', 'lt.code as lt_code', 'lt.name as lt_name']);

  r.get('/types', { preHandler: requirePermission('leave:read', 'leave:read:team', 'leave:read:own'), schema: { tags: ['leave'], summary: 'Leave types', response: { 200: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), isPaid: z.boolean(), requiresAttachment: z.boolean(), color: z.string().nullable() })) } } }, async () => (await app.db.selectFrom('leave_types').selectAll().where('is_active', '=', true).orderBy('sort_order').execute()).map((t) => ({ id: t.id, code: t.code, name: t.name, nameAr: t.name_ar, isPaid: t.is_paid, requiresAttachment: t.requires_attachment, color: t.color })));

  r.get('/balances/:employeeId', { preHandler: requirePermission('leave:read', 'leave:read:team', 'leave:read:own'), schema: { tags: ['leave'], summary: 'Leave balances for an employee', params: z.object({ employeeId: z.string().uuid() }), querystring: z.object({ year: z.coerce.number().int().optional() }), response: { 200: z.array(z.object({ leaveTypeCode: z.string(), leaveTypeName: z.string(), year: z.number(), opening: z.number(), accrued: z.number(), used: z.number(), pending: z.number(), adjusted: z.number(), balance: z.number(), available: z.number() })) } } }, async (req) => {
    await assertCanSeeEmployee(app.db, requireAuth(req), 'leave', req.params.employeeId);
    const year = req.query.year ?? new Date().getFullYear();
    const rows = await app.db.selectFrom('leave_balances as b').innerJoin('leave_types as t', 't.id', 'b.leave_type_id').selectAll('b').select(['t.code', 't.name']).where('b.employee_id', '=', req.params.employeeId).where('b.period_year', '=', year).orderBy('t.sort_order').execute();
    return rows.map((b) => ({ leaveTypeCode: b.code, leaveTypeName: b.name, year: b.period_year, opening: Number(b.opening_days), accrued: Number(b.accrued_days), used: Number(b.used_days), pending: Number(b.pending_days), adjusted: Number(b.adjusted_days), balance: Number(b.balance_days), available: Number(b.balance_days) - Number(b.pending_days) }));
  });

  r.get('/requests', { preHandler: requirePermission('leave:read', 'leave:read:team', 'leave:read:own'), schema: { tags: ['leave'], summary: 'Leave requests (scoped)', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), status: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() })), response: { 200: paginated(lrOut) } } }, async (req) => {
    const p = requireAuth(req);
    const q = req.query;
    let base = query();
    const scope = resolveScope(p, 'leave');
    if (scope === 'own') base = base.where('l.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (scope === 'team') base = base.where('l.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (q.employeeId) base = base.where('l.employee_id', '=', q.employeeId);
    if (q.status) base = base.where('l.status', '=', q.status);
    if (q.from) base = base.where('l.end_date', '>=', q.from);
    if (q.to) base = base.where('l.start_date', '<=', q.to);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('l.created_at', 'desc').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(lrMap), meta: pageMeta(q, total) };
  });

  r.post('/requests', { preHandler: requirePermission('leave:request:own', 'leave:request:any'), schema: { tags: ['leave'], summary: 'Submit a leave request (days computed from work pattern/holidays; balance checked; approval workflow started)', body: z.object({ employeeId: z.string().uuid().optional(), leaveTypeCode: z.string(), startDate: isoDate, endDate: isoDate, isHalfDay: z.boolean().default(false), halfDayPart: z.enum(['AM', 'PM']).optional(), reason: z.string().max(1000).optional(), attachmentObjectKey: z.string().optional() }), response: { 201: lrOut, 400: errorSchema, 422: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const b = req.body;
    const employeeId = b.employeeId ?? p.employeeId;
    if (!employeeId) throw badRequest('employeeId required');
    if (employeeId !== p.employeeId && !hasPermission(p, 'leave:request:any')) throw forbidden('You can only request leave for yourself');
    if (b.endDate < b.startDate) throw badRequest('endDate must be >= startDate');
    if (b.isHalfDay && b.startDate !== b.endDate) throw badRequest('Half-day leave must be a single day');
    const lt = await app.db.selectFrom('leave_types').selectAll().where('code', '=', b.leaveTypeCode).where('is_active', '=', true).executeTakeFirst();
    if (!lt) throw badRequest(`Unknown leave type ${b.leaveTypeCode}`);
    if (lt.requires_attachment && !b.attachmentObjectKey) throw badRequest('This leave type requires an attachment');
    const overlap = await app.db.selectFrom('leave_requests').select('id').where('employee_id', '=', employeeId).where('status', 'in', ['PENDING', 'APPROVED']).where('start_date', '<=', b.endDate).where('end_date', '>=', b.startDate).executeTakeFirst();
    if (overlap) throw badRequest('Overlaps an existing pending/approved leave request');
    const policy = await app.db.selectFrom('leave_policies').selectAll().where('leave_type_id', '=', lt.id).where('is_active', '=', true).orderBy('effective_from', 'desc').executeTakeFirst();
    const ctx = await loadScheduleContext(app.db, employeeId, b.startDate, b.endDate);
    if (!ctx) throw notFound('Employee', employeeId);
    const weekOffDates = new Set(eachDate(b.startDate, b.endDate).filter((d) => resolveFor(ctx, d).isWeekOff));
    const totalDays = countLeaveDays(b.startDate, b.endDate, [], new Set([...ctx.holidays].filter((h) => h >= b.startDate && h <= b.endDate)), { countWeekOffs: policy?.count_week_offs ?? false, countHolidays: policy?.count_holidays ?? false }, b.isHalfDay)
      - (policy?.count_week_offs ? 0 : [...weekOffDates].filter((d) => !ctx.holidays.has(d) || policy?.count_holidays).length);
    if (totalDays <= 0) throw badRequest('The selected period contains no chargeable leave days');
    if (lt.is_paid && lt.code !== 'OTHER') {
      const year = Number(b.startDate.slice(0, 4));
      const bal = await app.db.selectFrom('leave_balances').select(['id', 'balance_days', 'pending_days']).where('employee_id', '=', employeeId).where('leave_type_id', '=', lt.id).where('period_year', '=', year).executeTakeFirst();
      const available = bal ? Number(bal.balance_days) - Number(bal.pending_days) : 0;
      const allowNegative = Number(policy?.allow_negative_days ?? 0);
      if (available + allowNegative < totalDays) throw badRequest(`Insufficient ${lt.code} balance: available ${available}, requested ${totalDays}`);
      if (bal) await app.db.updateTable('leave_balances').set((eb) => ({ pending_days: eb('pending_days', '+', totalDays) })).where('id', '=', bal.id).execute();
    }
    const lr = await app.db.insertInto('leave_requests').values({ employee_id: employeeId, leave_type_id: lt.id, start_date: b.startDate, end_date: b.endDate, is_half_day: b.isHalfDay, half_day_part: b.halfDayPart ?? null, total_days: totalDays, reason: b.reason ?? null, attachment_object_key: b.attachmentObjectKey ?? null, requested_by: p.userId }).returning('id').executeTakeFirstOrThrow();
    const wf = await startWorkflow(app.db, { code: 'LEAVE_APPROVAL', entityType: 'leave_request', entityId: lr.id, initiatedBy: p.userId, context: { employeeId, leaveTypeCode: lt.code, totalDays, startDate: b.startDate } });
    if (wf) await app.db.updateTable('leave_requests').set({ workflow_instance_id: wf }).where('id', '=', lr.id).execute();
    else await applyLeaveDecision(app, lr.id, 'APPROVED'); // no workflow configured → auto-approve
    await app.audit(req, { action: 'leave.request', entityType: 'leave_request', entityId: lr.id, newValue: { ...b, totalDays }, approvalRef: wf });
    return reply.status(201).send(lrMap(await query().where('l.id', '=', lr.id).executeTakeFirstOrThrow()));
  });

  r.post('/requests/:id/cancel', { preHandler: requirePermission('leave:request:own', 'leave:request:any'), schema: { tags: ['leave'], summary: 'Cancel a pending or future approved leave (restores balance, recalculates attendance)', params: idParam, body: z.object({ reason: z.string().max(500).optional() }), response: { 200: lrOut } } }, async (req) => {
    const p = requireAuth(req);
    const lr = await app.db.selectFrom('leave_requests').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!lr) throw notFound('Leave request', req.params.id);
    if (lr.employee_id !== p.employeeId && !hasPermission(p, 'leave:request:any')) throw forbidden();
    if (!['PENDING', 'APPROVED'].includes(lr.status)) throw badRequest('Only pending or approved requests can be cancelled');
    const year = Number(lr.start_date.slice(0, 4));
    const bal = await app.db.selectFrom('leave_balances').select('id').where('employee_id', '=', lr.employee_id).where('leave_type_id', '=', lr.leave_type_id).where('period_year', '=', year).executeTakeFirst();
    await app.db.transaction().execute(async (trx) => {
      if (bal) {
        if (lr.status === 'PENDING') await trx.updateTable('leave_balances').set((eb) => ({ pending_days: eb('pending_days', '-', Number(lr.total_days)) })).where('id', '=', bal.id).execute();
        else { await trx.updateTable('leave_balances').set((eb) => ({ used_days: eb('used_days', '-', Number(lr.total_days)) })).where('id', '=', bal.id).execute(); await trx.insertInto('leave_balance_transactions').values({ balance_id: bal.id, txn_type: 'REVERSAL', days: Number(lr.total_days), reference_id: lr.id, note: req.body.reason ?? null }).execute(); }
      }
      await trx.updateTable('leave_requests').set({ status: 'CANCELLED', cancelled_at: new Date(), decision_note: req.body.reason ?? null }).where('id', '=', lr.id).execute();
      if (lr.workflow_instance_id) { await trx.updateTable('workflow_instances').set({ status: 'CANCELLED', completed_at: new Date() }).where('id', '=', lr.workflow_instance_id).execute(); await trx.updateTable('workflow_tasks').set({ status: 'CANCELLED' }).where('instance_id', '=', lr.workflow_instance_id).where('status', '=', 'PENDING').execute(); }
    });
    if (lr.status === 'APPROVED') { const today = new Date().toISOString().slice(0, 10); const dates = eachDate(lr.start_date, lr.end_date).filter((d) => d <= today); if (dates.length) await app.queues.enqueueProcessAffected(dates.map((date) => ({ employeeId: lr.employee_id, date }))); }
    await app.audit(req, { action: 'leave.cancel', entityType: 'leave_request', entityId: lr.id, oldValue: { status: lr.status }, newValue: { status: 'CANCELLED' }, reason: req.body.reason });
    return lrMap(await query().where('l.id', '=', lr.id).executeTakeFirstOrThrow());
  });

  r.get('/calendar', { preHandler: requirePermission('leave:read', 'leave:read:team'), schema: { tags: ['leave'], summary: 'Team availability calendar', querystring: z.object({ from: isoDate, to: isoDate, siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional() }), response: { 200: z.array(z.object({ employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), leaveTypeCode: z.string(), startDate: z.string(), endDate: z.string(), status: z.string() })) } } }, async (req) => {
    const p = requireAuth(req);
    let q = query().where('l.status', 'in', ['PENDING', 'APPROVED']).where('l.end_date', '>=', req.query.from).where('l.start_date', '<=', req.query.to);
    if (resolveScope(p, 'leave') === 'team') q = q.where('l.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (req.query.siteId) q = q.where('e.site_id', '=', req.query.siteId);
    if (req.query.departmentId) q = q.where('e.department_id', '=', req.query.departmentId);
    return (await q.orderBy('l.start_date').limit(2000).execute()).map((l) => ({ employeeId: l.employee_id, employeeNo: l.employee_no, employeeName: l.full_name_en, leaveTypeCode: l.lt_code, startDate: l.start_date, endDate: l.end_date, status: l.status }));
  });

  r.post('/accrual/run', { preHandler: requirePermission('leave:policy:write'), schema: { tags: ['leave'], summary: 'Run monthly accrual (idempotent per month)', body: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }), response: { 200: z.object({ accrued: z.number() }) } } }, async (req) => {
    const accrued = await runMonthlyAccrual(app, req.body.year, req.body.month);
    await app.audit(req, { action: 'leave.accrual.run', entityType: 'leave_balance', metadata: { ...req.body, accrued } });
    return { accrued };
  });
  r.post('/balances/adjust', { preHandler: requirePermission('leave:policy:write'), schema: { tags: ['leave'], summary: 'Manual balance adjustment (audited)', body: z.object({ employeeId: z.string().uuid(), leaveTypeCode: z.string(), year: z.number().int(), days: z.number(), note: z.string().min(5) }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const p = requireAuth(req);
    const lt = await app.db.selectFrom('leave_types').select('id').where('code', '=', req.body.leaveTypeCode).executeTakeFirst();
    if (!lt) throw badRequest('Unknown leave type');
    const bal = await app.db.insertInto('leave_balances').values({ employee_id: req.body.employeeId, leave_type_id: lt.id, period_year: req.body.year }).onConflict((oc) => oc.columns(['employee_id', 'leave_type_id', 'period_year']).doUpdateSet({ updated_at: new Date() })).returning('id').executeTakeFirstOrThrow();
    await app.db.updateTable('leave_balances').set((eb) => ({ adjusted_days: eb('adjusted_days', '+', req.body.days) })).where('id', '=', bal.id).execute();
    await app.db.insertInto('leave_balance_transactions').values({ balance_id: bal.id, txn_type: 'ADJUSTMENT', days: req.body.days, note: req.body.note, created_by: p.userId }).execute();
    await app.audit(req, { action: 'leave.balance.adjust', entityType: 'leave_balance', entityId: bal.id, newValue: req.body, reason: req.body.note });
    return { ok: true };
  });
};
