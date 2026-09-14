import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission, resolveScope } from '../../plugins/rbac.js';
import { teamEmployeeIds } from '../employees/service.js';
import { startWorkflow } from '../workflows/service.js';
import { applyApprovedOvertime, pickOvertimeRule } from './service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const otOut = z.object({ id: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), date: z.string(), requestedMinutes: z.number(), approvedMinutes: z.number().nullable(), computedMinutes: z.number().nullable(), dayKind: z.string(), multiplier: z.number().nullable(), reason: z.string().nullable(), status: z.string(), workflowInstanceId: z.string().nullable(), decidedAt: z.string().nullable(), createdAt: z.string() });
const otMap = (o: Record<string, any>) => ({ id: o.id, employeeId: o.employee_id, employeeNo: o.employee_no, employeeName: o.full_name_en, date: o.attendance_date, requestedMinutes: o.requested_minutes, approvedMinutes: o.approved_minutes, computedMinutes: o.computed_minutes ?? null, dayKind: o.day_kind, multiplier: o.multiplier === null ? null : Number(o.multiplier), reason: o.reason, status: o.status, workflowInstanceId: o.workflow_instance_id, decidedAt: o.decided_at ? new Date(o.decided_at).toISOString() : null, createdAt: new Date(o.created_at).toISOString() });

export const overtimeRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const query = () => app.db.selectFrom('overtime_requests as o').innerJoin('employees as e', 'e.id', 'o.employee_id').leftJoin('attendance_daily as d', 'd.id', 'o.attendance_daily_id').selectAll('o').select(['e.employee_no', 'e.full_name_en', 'd.overtime_minutes as computed_minutes']);

  r.get('/rules', { preHandler: requirePermission('overtime:read', 'overtime:read:team', 'overtime:read:own'), schema: { tags: ['overtime'], summary: 'Overtime rules (multipliers, caps, approvals)', response: { 200: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), dayKind: z.string(), multiplier: z.number(), scope: z.string(), scopeId: z.string().nullable(), minMinutes: z.number(), maxMinutesPerDay: z.number().nullable(), maxMinutesPerMonth: z.number().nullable(), roundingMinutes: z.number(), requiresManagerApproval: z.boolean(), requiresHrApprovalOverMinutes: z.number().nullable(), isStatutory: z.boolean(), isActive: z.boolean() })) } } }, async () => (await app.db.selectFrom('overtime_rules').selectAll().orderBy('day_kind').orderBy('priority').execute()).map((x) => ({ id: x.id, code: x.code, name: x.name, dayKind: x.day_kind, multiplier: Number(x.multiplier), scope: x.scope, scopeId: x.scope_id, minMinutes: x.min_minutes, maxMinutesPerDay: x.max_minutes_per_day, maxMinutesPerMonth: x.max_minutes_per_month, roundingMinutes: x.rounding_minutes, requiresManagerApproval: x.requires_manager_approval, requiresHrApprovalOverMinutes: x.requires_hr_approval_over_minutes, isStatutory: x.is_statutory, isActive: x.is_active })));
  r.post('/rules', { preHandler: requirePermission('overtime:rules:write'), schema: { tags: ['overtime'], summary: 'Create/replace an OT rule (company policy; statutory items must be legally reviewed)', body: z.object({ code: z.string().min(1), name: z.string().min(1), dayKind: z.enum(['NORMAL', 'WEEK_OFF', 'PUBLIC_HOLIDAY']), multiplier: z.number().positive(), scope: z.enum(['GLOBAL', 'SITE', 'PROJECT', 'EMPLOYEE']).default('GLOBAL'), scopeId: z.string().uuid().nullable().optional(), minMinutes: z.number().int().min(0).default(30), maxMinutesPerDay: z.number().int().nullable().optional(), maxMinutesPerMonth: z.number().int().nullable().optional(), roundingMinutes: z.number().int().min(1).default(15), requiresManagerApproval: z.boolean().default(true), requiresHrApprovalOverMinutes: z.number().int().nullable().optional(), isStatutory: z.boolean().default(false), effectiveFrom: isoDate.optional() }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const b = req.body;
    const row = await app.db.insertInto('overtime_rules').values({ code: b.code, name: b.name, day_kind: b.dayKind, multiplier: b.multiplier, scope: b.scope, scope_id: b.scopeId ?? null, min_minutes: b.minMinutes, max_minutes_per_day: b.maxMinutesPerDay ?? null, max_minutes_per_month: b.maxMinutesPerMonth ?? null, rounding_minutes: b.roundingMinutes, requires_manager_approval: b.requiresManagerApproval, requires_hr_approval_over_minutes: b.requiresHrApprovalOverMinutes ?? null, is_statutory: b.isStatutory, ...(b.effectiveFrom && { effective_from: b.effectiveFrom }) }).onConflict((oc) => oc.column('code').doUpdateSet({ name: b.name, multiplier: b.multiplier, max_minutes_per_day: b.maxMinutesPerDay ?? null, requires_hr_approval_over_minutes: b.requiresHrApprovalOverMinutes ?? null })).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'overtime.rule.upsert', entityType: 'overtime_rule', entityId: row.id, newValue: b });
    return reply.status(201).send({ id: row.id });
  });

  r.get('/requests', { preHandler: requirePermission('overtime:read', 'overtime:read:team', 'overtime:read:own'), schema: { tags: ['overtime'], summary: 'Overtime requests (scoped)', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), status: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() })), response: { 200: paginated(otOut) } } }, async (req) => {
    const p = requireAuth(req);
    const q = req.query;
    let base = query();
    const scope = resolveScope(p, 'overtime');
    if (scope === 'own') base = base.where('o.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (scope === 'team') base = base.where('o.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (q.employeeId) base = base.where('o.employee_id', '=', q.employeeId);
    if (q.status) base = base.where('o.status', '=', q.status);
    if (q.from) base = base.where('o.attendance_date', '>=', q.from);
    if (q.to) base = base.where('o.attendance_date', '<=', q.to);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('o.attendance_date', 'desc').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(otMap), meta: pageMeta(q, total) };
  });

  r.post('/requests', { preHandler: requirePermission('overtime:request', 'overtime:approve'), schema: { tags: ['overtime'], summary: 'Request overtime approval for a day (defaults to the computed OT minutes; starts OVERTIME_APPROVAL workflow)', body: z.object({ employeeId: z.string().uuid().optional(), date: isoDate, requestedMinutes: z.number().int().positive().optional(), reason: z.string().max(1000).optional() }), response: { 201: otOut, 400: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const employeeId = req.body.employeeId ?? p.employeeId;
    if (!employeeId) throw badRequest('employeeId required');
    if (employeeId !== p.employeeId && !hasPermission(p, 'overtime:approve') && !hasPermission(p, 'overtime:read:team')) throw forbidden();
    const emp = await app.db.selectFrom('employees').select(['id', 'site_id', 'project_id']).where('id', '=', employeeId).executeTakeFirst();
    if (!emp) throw notFound('Employee', employeeId);
    const daily = await app.db.selectFrom('attendance_daily').select(['id', 'status', 'overtime_minutes', 'locked_at']).where('employee_id', '=', employeeId).where('attendance_date', '=', req.body.date).executeTakeFirst();
    if (daily?.locked_at) throw badRequest('Day is locked');
    const computed = daily?.overtime_minutes ?? 0;
    const requested = req.body.requestedMinutes ?? computed;
    if (requested <= 0) throw badRequest('No overtime minutes to request for this day');
    if (requested > computed && !hasPermission(p, 'overtime:approve')) throw badRequest(`Requested minutes (${requested}) exceed computed overtime (${computed})`);
    const dayKind = daily?.status === 'WEEK_OFF' ? 'WEEK_OFF' : daily?.status === 'PUBLIC_HOLIDAY' ? 'PUBLIC_HOLIDAY' : 'NORMAL';
    const rule = await pickOvertimeRule(app.db, emp, dayKind, req.body.date);
    if (rule?.max_minutes_per_day && requested > rule.max_minutes_per_day) throw badRequest(`Exceeds maximum OT per day (${rule.max_minutes_per_day} min) per rule ${rule.code}`);
    const ot = await app.db.insertInto('overtime_requests').values({ employee_id: employeeId, attendance_date: req.body.date, attendance_daily_id: daily?.id ?? null, requested_minutes: requested, day_kind: dayKind, overtime_rule_id: rule?.id ?? null, multiplier: rule ? Number(rule.multiplier) : null, reason: req.body.reason ?? null, requested_by: p.userId }).returning('id').executeTakeFirstOrThrow();
    const wf = await startWorkflow(app.db, { code: 'OVERTIME_APPROVAL', entityType: 'overtime_request', entityId: ot.id, initiatedBy: p.userId, context: { employeeId, requested_minutes: requested, dayKind, date: req.body.date } });
    if (wf) await app.db.updateTable('overtime_requests').set({ workflow_instance_id: wf }).where('id', '=', ot.id).execute();
    else await applyApprovedOvertime(app.db, ot.id);
    await app.audit(req, { action: 'overtime.request', entityType: 'overtime_request', entityId: ot.id, newValue: { employeeId, date: req.body.date, requested, dayKind, rule: rule?.code }, approvalRef: wf });
    return reply.status(201).send(otMap(await query().where('o.id', '=', ot.id).executeTakeFirstOrThrow()));
  });

  r.post('/requests/:id/decide', { preHandler: requirePermission('overtime:approve'), schema: { tags: ['overtime'], summary: 'Direct HR decision (bypasses remaining workflow steps; audited)', params: idParam, body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), approvedMinutes: z.number().int().min(0).optional(), note: z.string().max(500).optional() }), response: { 200: otOut } } }, async (req) => {
    const p = requireAuth(req);
    const ot = await app.db.selectFrom('overtime_requests').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!ot) throw notFound('Overtime request', req.params.id);
    if (ot.status !== 'PENDING') throw badRequest('Already decided');
    await app.db.updateTable('overtime_requests').set({ status: req.body.decision, approved_minutes: req.body.decision === 'APPROVED' ? Math.min(req.body.approvedMinutes ?? ot.requested_minutes, ot.requested_minutes) : 0, decided_by: p.userId, decided_at: new Date(), decision_note: req.body.note ?? null }).where('id', '=', ot.id).execute();
    if (ot.workflow_instance_id) { await app.db.updateTable('workflow_instances').set({ status: req.body.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED', completed_at: new Date() }).where('id', '=', ot.workflow_instance_id).execute(); await app.db.updateTable('workflow_tasks').set({ status: 'SKIPPED' }).where('instance_id', '=', ot.workflow_instance_id).where('status', '=', 'PENDING').execute(); }
    if (req.body.decision === 'APPROVED') await applyApprovedOvertime(app.db, ot.id);
    await app.audit(req, { action: `overtime.${req.body.decision.toLowerCase()}`, entityType: 'overtime_request', entityId: ot.id, newValue: req.body });
    return otMap(await query().where('o.id', '=', ot.id).executeTakeFirstOrThrow());
  });
};
