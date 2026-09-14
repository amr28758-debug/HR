import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { ATTENDANCE_EXCEPTION_TYPES, DAY_STATUSES, PUNCH_DIRECTIONS } from '@burtplace/types';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, notFound } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission, resolveScope } from '../../plugins/rbac.js';
import { inboundBatchSchema } from '../../integrations/biometric/webhook-adapter.js';
import { webhookProvider } from '../../integrations/biometric/registry.js';
import { ingestEvents } from './ingest.service.js';
import { loadScheduleContext, processAffected, processEmployeeDay, processRange } from './processor.service.js';
import { assertCanSeeEmployee, teamEmployeeIds } from '../employees/service.js';
import { startWorkflow } from '../workflows/service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dailyOut = z.object({
  id: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), date: z.string(), status: z.string(), shiftCode: z.string().nullable(), siteName: z.string().nullable(),
  firstInAt: z.string().nullable(), lastOutAt: z.string().nullable(), scheduledStartAt: z.string().nullable(), scheduledEndAt: z.string().nullable(),
  scheduledMinutes: z.number(), workedMinutes: z.number(), breakMinutes: z.number(), netWorkedMinutes: z.number(), lateMinutes: z.number(), earlyLeaveMinutes: z.number(),
  overtimeMinutes: z.number(), approvedOvertimeMinutes: z.number(), holidayMinutes: z.number(), weekendMinutes: z.number(), leaveTypeCode: z.string().nullable(), isPaidDay: z.boolean(), punchCount: z.number(), isManualOverride: z.boolean(), lockedAt: z.string().nullable(),
});
const ts = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const dailyMap = (d: Record<string, any>) => ({
  id: d.id, employeeId: d.employee_id, employeeNo: d.employee_no, employeeName: d.full_name_en, date: d.attendance_date, status: d.status, shiftCode: d.shift_code ?? null, siteName: d.site_name ?? null,
  firstInAt: ts(d.first_in_at), lastOutAt: ts(d.last_out_at), scheduledStartAt: ts(d.scheduled_start_at), scheduledEndAt: ts(d.scheduled_end_at),
  scheduledMinutes: d.scheduled_minutes, workedMinutes: d.worked_minutes, breakMinutes: d.break_minutes, netWorkedMinutes: d.net_worked_minutes, lateMinutes: d.late_minutes, earlyLeaveMinutes: d.early_leave_minutes,
  overtimeMinutes: d.overtime_minutes, approvedOvertimeMinutes: d.approved_overtime_minutes, holidayMinutes: d.holiday_minutes, weekendMinutes: d.weekend_minutes, leaveTypeCode: d.leave_type_code, isPaidDay: d.is_paid_day, punchCount: d.punch_count, isManualOverride: d.is_manual_override, lockedAt: ts(d.locked_at),
});

export const attendanceRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Ingest (device gateway / middleware / manual import) ──
  r.post('/events', {
    preHandler: requirePermission('attendance:ingest'),
    config: { rateLimit: false },
    schema: { tags: ['attendance'], summary: 'Ingest raw punch events (idempotent by fingerprint). Used by the Device Gateway / VYOM export / middleware.', body: inboundBatchSchema,
      response: { 202: z.object({ batchId: z.string(), received: z.number(), inserted: z.number(), duplicates: z.number(), rejected: z.number(), unmapped: z.number(), queuedProcessing: z.boolean() }), 400: errorSchema } },
  }, async (req, reply) => {
    const p = requireAuth(req);
    const events = webhookProvider.parseInboundEvents(req.body);
    const result = await ingestEvents(app.db, events, p.isServiceAccount ? 'GATEWAY' : 'API', p.userId);
    const queued = await app.queues.enqueueProcessAffected(result.affectedEmployeeDates);
    return reply.status(202).send({ batchId: result.batchId, received: result.received, inserted: result.inserted, duplicates: result.duplicates, rejected: result.rejected, unmapped: result.unmapped, queuedProcessing: queued });
  });

  // ── Raw ledger (read-only) ──
  const rawOut = z.object({ id: z.string(), fingerprint: z.string(), externalUserId: z.string(), employeeId: z.string().nullable(), employeeNo: z.string().nullable(), deviceCode: z.string(), siteId: z.string().nullable(), punchedAt: z.string(), direction: z.string(), verificationMethod: z.string(), source: z.string(), receivedAt: z.string(), processedAt: z.string().nullable() });
  r.get('/raw-events', { preHandler: requirePermission('attendance:read', 'attendance:read:team', 'attendance:read:own'), schema: { tags: ['attendance'], summary: 'Immutable raw punch ledger', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), deviceCode: z.string().optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), unprocessed: z.coerce.boolean().optional() })), response: { 200: paginated(rawOut) } } }, async (req) => {
    const p = requireAuth(req);
    const q = req.query;
    let base = app.db.selectFrom('attendance_raw_events as e').leftJoin('employees as emp', 'emp.id', 'e.employee_id').selectAll('e').select('emp.employee_no');
    const scope = resolveScope(p, 'attendance');
    if (scope === 'own') base = base.where('e.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (scope === 'team') base = base.where('e.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (q.employeeId) base = base.where('e.employee_id', '=', q.employeeId);
    if (q.deviceCode) base = base.where('e.device_code', '=', q.deviceCode);
    if (q.from) base = base.where('e.punched_at', '>=', new Date(q.from));
    if (q.to) base = base.where('e.punched_at', '<=', new Date(q.to));
    if (q.unprocessed) base = base.where('e.processed_at', 'is', null);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('e.punched_at', q.order === 'asc' ? 'asc' : 'desc').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map((e) => ({ id: e.id, fingerprint: e.event_fingerprint, externalUserId: e.external_user_id, employeeId: e.employee_id, employeeNo: e.employee_no ?? null, deviceCode: e.device_code, siteId: e.site_id, punchedAt: new Date(e.punched_at).toISOString(), direction: e.direction, verificationMethod: e.verification_method, source: e.source, receivedAt: new Date(e.received_at).toISOString(), processedAt: ts(e.processed_at) })), meta: pageMeta(q, total) };
  });

  // ── Daily attendance ──
  const dailyQuery = () => app.db.selectFrom('attendance_daily as d').innerJoin('employees as e', 'e.id', 'd.employee_id').leftJoin('shifts as s', 's.id', 'd.shift_id').leftJoin('sites as st', 'st.id', 'd.site_id').selectAll('d').select(['e.employee_no', 'e.full_name_en', 's.code as shift_code', 'st.name as site_name']);
  r.get('/daily', { preHandler: requirePermission('attendance:read', 'attendance:read:team', 'attendance:read:own'), schema: { tags: ['attendance'], summary: 'Daily attendance records (scoped)', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), from: isoDate, to: isoDate, status: z.enum(DAY_STATUSES).optional(), siteId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), departmentId: z.string().uuid().optional() })), response: { 200: paginated(dailyOut) } } }, async (req) => {
    const p = requireAuth(req);
    const q = req.query;
    let base = dailyQuery().where('d.attendance_date', '>=', q.from).where('d.attendance_date', '<=', q.to);
    const scope = resolveScope(p, 'attendance');
    if (scope === 'own') base = base.where('d.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (scope === 'team') base = base.where('d.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (q.employeeId) base = base.where('d.employee_id', '=', q.employeeId);
    if (q.status) base = base.where('d.status', '=', q.status);
    if (q.siteId) base = base.where('d.site_id', '=', q.siteId);
    if (q.projectId) base = base.where('d.project_id', '=', q.projectId);
    if (q.departmentId) base = base.where('e.department_id', '=', q.departmentId);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('d.attendance_date', 'desc').orderBy('e.employee_no').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(dailyMap), meta: pageMeta(q, total) };
  });

  r.get('/daily/:employeeId/:date/punches', { preHandler: requirePermission('attendance:read', 'attendance:read:team', 'attendance:read:own'), schema: { tags: ['attendance'], summary: 'Processed punches for one employee-day', params: z.object({ employeeId: z.string().uuid(), date: isoDate }), response: { 200: z.array(z.object({ id: z.string(), rawEventId: z.string().nullable(), correctionId: z.string().nullable(), punchedAt: z.string(), direction: z.string(), deviceId: z.string().nullable(), isIgnored: z.boolean(), ignoreReason: z.string().nullable() })) } } }, async (req) => {
    await assertCanSeeEmployee(app.db, requireAuth(req), 'attendance', req.params.employeeId);
    const rows = await app.db.selectFrom('attendance_events').selectAll().where('employee_id', '=', req.params.employeeId).where('attendance_date', '=', req.params.date).orderBy('punched_at').execute();
    return rows.map((e) => ({ id: e.id, rawEventId: e.raw_event_id, correctionId: e.correction_id, punchedAt: new Date(e.punched_at).toISOString(), direction: e.direction, deviceId: e.device_id, isIgnored: e.is_ignored, ignoreReason: e.ignore_reason }));
  });

  // ── Processing ──
  r.post('/process', { preHandler: requirePermission('attendance:process'), schema: { tags: ['attendance'], summary: 'Recalculate daily attendance for a date range (all or selected employees). Runs inline for ≤ 7 days, else queued.', body: z.object({ from: isoDate, to: isoDate, employeeIds: z.array(z.string().uuid()).optional() }), response: { 200: z.object({ mode: z.enum(['inline', 'queued']), processed: z.number().optional(), skipped: z.number().optional(), byStatus: z.record(z.number()).optional(), jobId: z.string().optional() }) } } }, async (req) => {
    const { from, to, employeeIds } = req.body;
    if (from > to) throw badRequest('from must be <= to');
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 864e5 + 1;
    if (days <= 7 || employeeIds?.length) {
      const res = await processRange(app.db, from, to, employeeIds);
      await app.audit(req, { action: 'attendance.process', entityType: 'attendance', metadata: { from, to, employeeIds, ...res } });
      return { mode: 'inline' as const, ...res };
    }
    const jobId = await app.queues.enqueueProcessRange(from, to);
    await app.audit(req, { action: 'attendance.process.queued', entityType: 'attendance', metadata: { from, to, jobId } });
    return { mode: 'queued' as const, jobId };
  });

  // ── Exceptions ──
  const exOut = z.object({ id: z.string(), employeeId: z.string().nullable(), employeeNo: z.string().nullable(), employeeName: z.string().nullable(), siteName: z.string().nullable(), date: z.string(), type: z.string(), status: z.string(), severity: z.string(), details: z.unknown(), rawEventId: z.string().nullable(), resolvedAt: z.string().nullable(), resolutionNote: z.string().nullable(), createdAt: z.string() });
  r.get('/exceptions', { preHandler: requirePermission('attendance:read', 'attendance:read:team'), schema: { tags: ['attendance'], summary: 'Exception queue', querystring: paginationQuery.merge(z.object({ status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']).optional(), type: z.enum(ATTENDANCE_EXCEPTION_TYPES).optional(), from: isoDate.optional(), to: isoDate.optional(), siteId: z.string().uuid().optional(), employeeId: z.string().uuid().optional() })), response: { 200: paginated(exOut) } } }, async (req) => {
    const p = requireAuth(req);
    const q = req.query;
    let base = app.db.selectFrom('attendance_exceptions as x').leftJoin('employees as e', 'e.id', 'x.employee_id').leftJoin('sites as s', 's.id', 'e.site_id').selectAll('x').select(['e.employee_no', 'e.full_name_en', 's.name as site_name']);
    if (resolveScope(p, 'attendance') === 'team') base = base.where('x.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    base = base.where('x.status', '=', q.status ?? 'OPEN');
    if (q.type) base = base.where('x.exception_type', '=', q.type);
    if (q.from) base = base.where('x.attendance_date', '>=', q.from);
    if (q.to) base = base.where('x.attendance_date', '<=', q.to);
    if (q.siteId) base = base.where('e.site_id', '=', q.siteId);
    if (q.employeeId) base = base.where('x.employee_id', '=', q.employeeId);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('x.attendance_date', 'desc').orderBy('x.severity').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map((x) => ({ id: x.id, employeeId: x.employee_id, employeeNo: x.employee_no ?? null, employeeName: x.full_name_en ?? null, siteName: x.site_name ?? null, date: x.attendance_date, type: x.exception_type, status: x.status, severity: x.severity, details: x.details, rawEventId: x.raw_event_id, resolvedAt: ts(x.resolved_at), resolutionNote: x.resolution_note, createdAt: new Date(x.created_at).toISOString() })), meta: pageMeta(q, total) };
  });
  r.post('/exceptions/:id/resolve', { preHandler: requirePermission('attendance:exceptions:resolve'), schema: { tags: ['attendance'], summary: 'Resolve or dismiss an exception', params: idParam, body: z.object({ status: z.enum(['RESOLVED', 'DISMISSED', 'IN_REVIEW']), note: z.string().max(1000).optional() }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const p = requireAuth(req);
    const res = await app.db.updateTable('attendance_exceptions').set({ status: req.body.status, resolution_note: req.body.note ?? null, resolved_by: req.body.status === 'IN_REVIEW' ? null : p.userId, resolved_at: req.body.status === 'IN_REVIEW' ? null : new Date() }).where('id', '=', req.params.id).returning('id').executeTakeFirst();
    if (!res) throw notFound('Exception', req.params.id);
    await app.audit(req, { action: 'attendance.exception.resolve', entityType: 'attendance_exception', entityId: req.params.id, newValue: req.body });
    return { ok: true };
  });

  // ── Corrections (raw stays untouched; correction + reason + approval) ──
  const corrOut = z.object({ id: z.string(), employeeId: z.string(), date: z.string(), rawEventId: z.string().nullable(), correctionType: z.string(), punchedAt: z.string().nullable(), direction: z.string().nullable(), overrideStatus: z.string().nullable(), overrideWorkedMinutes: z.number().nullable(), reason: z.string(), status: z.string(), workflowInstanceId: z.string().nullable(), createdAt: z.string() });
  const corrMap = (c: Record<string, any>) => ({ id: c.id, employeeId: c.employee_id, date: c.attendance_date, rawEventId: c.raw_event_id, correctionType: c.correction_type, punchedAt: ts(c.punched_at), direction: c.direction, overrideStatus: c.override_status, overrideWorkedMinutes: c.override_worked_minutes, reason: c.reason, status: c.status, workflowInstanceId: c.workflow_instance_id, createdAt: new Date(c.created_at).toISOString() });
  r.post('/corrections', { preHandler: requirePermission('attendance:correct'), schema: { tags: ['attendance'], summary: 'Request an attendance correction (goes through ATTENDANCE_CORRECTION workflow; raw event is never modified)', body: z.object({ employeeId: z.string().uuid(), date: isoDate, correctionType: z.enum(['ADD_PUNCH', 'IGNORE_PUNCH', 'CHANGE_DIRECTION', 'OVERRIDE_DAY']), rawEventId: z.string().uuid().optional(), punchedAt: z.string().datetime({ offset: true }).optional(), direction: z.enum(PUNCH_DIRECTIONS).optional(), overrideStatus: z.enum(DAY_STATUSES).optional(), overrideWorkedMinutes: z.number().int().min(0).max(1440).optional(), reason: z.string().min(5).max(1000) }), response: { 201: corrOut, 400: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const b = req.body;
    if (b.correctionType === 'ADD_PUNCH' && !b.punchedAt) throw badRequest('punchedAt required for ADD_PUNCH');
    if ((b.correctionType === 'IGNORE_PUNCH' || b.correctionType === 'CHANGE_DIRECTION') && !b.rawEventId) throw badRequest('rawEventId required');
    if (b.correctionType === 'CHANGE_DIRECTION' && !b.direction) throw badRequest('direction required');
    if (b.correctionType === 'OVERRIDE_DAY' && !b.overrideStatus) throw badRequest('overrideStatus required');
    const locked = await app.db.selectFrom('attendance_daily').select('locked_at').where('employee_id', '=', b.employeeId).where('attendance_date', '=', b.date).executeTakeFirst();
    if (locked?.locked_at) throw badRequest('This day belongs to a locked timesheet; use a payroll adjustment instead');
    const c = await app.db.insertInto('attendance_corrections').values({ employee_id: b.employeeId, attendance_date: b.date, raw_event_id: b.rawEventId ?? null, correction_type: b.correctionType, punched_at: b.punchedAt ? new Date(b.punchedAt) : null, direction: b.direction ?? null, override_status: b.overrideStatus ?? null, override_worked_minutes: b.overrideWorkedMinutes ?? null, reason: b.reason, requested_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    const wf = await startWorkflow(app.db, { code: 'ATTENDANCE_CORRECTION', entityType: 'attendance_correction', entityId: c.id, initiatedBy: p.userId, context: { employeeId: b.employeeId, date: b.date, correctionType: b.correctionType } });
    if (wf) await app.db.updateTable('attendance_corrections').set({ workflow_instance_id: wf }).where('id', '=', c.id).execute();
    await app.audit(req, { action: 'attendance.correction.request', entityType: 'attendance_correction', entityId: c.id, newValue: b, reason: b.reason, approvalRef: wf });
    return reply.status(201).send(corrMap({ ...c, workflow_instance_id: wf }));
  });
  r.get('/corrections', { preHandler: requirePermission('attendance:read', 'attendance:read:team'), schema: { tags: ['attendance'], summary: 'List corrections', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() })), response: { 200: paginated(corrOut) } } }, async (req) => {
    const q = req.query;
    let base = app.db.selectFrom('attendance_corrections').selectAll();
    if (q.employeeId) base = base.where('employee_id', '=', q.employeeId);
    if (q.status) base = base.where('status', '=', q.status);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('created_at', 'desc').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(corrMap), meta: pageMeta(q, total) };
  });

  // ── Employee self/manager view helper: monthly calendar ──
  r.get('/calendar/:employeeId', { preHandler: requirePermission('attendance:read', 'attendance:read:team', 'attendance:read:own'), schema: { tags: ['attendance'], summary: 'Month calendar for an employee', params: z.object({ employeeId: z.string().uuid() }), querystring: z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }), response: { 200: z.array(dailyOut) } } }, async (req) => {
    await assertCanSeeEmployee(app.db, requireAuth(req), 'attendance', req.params.employeeId);
    const from = `${req.query.year}-${String(req.query.month).padStart(2, '0')}-01`;
    const rows = await dailyQuery().where('d.employee_id', '=', req.params.employeeId).where(sql`date_trunc('month', d.attendance_date)`, '=', sql`${from}::date`).orderBy('d.attendance_date').execute();
    return rows.map(dailyMap);
  });

  // ── Reconciliation ──
  r.post('/reconcile', { preHandler: requirePermission('attendance:process'), schema: { tags: ['attendance'], summary: 'Run reconciliation: raw vs processed vs daily vs timesheet', body: z.object({ from: isoDate, to: isoDate }), response: { 200: z.object({ id: z.string(), summary: z.record(z.number()), findings: z.array(z.unknown()) }) } } }, async (req) => {
    const { runReconciliation } = await import('./reconciliation.service.js');
    const res = await runReconciliation(app.db, req.body.from, req.body.to);
    await app.audit(req, { action: 'attendance.reconcile', entityType: 'reconciliation_run', entityId: res.id, metadata: res.summary });
    return res;
  });
  r.get('/reconcile/latest', { preHandler: requirePermission('attendance:read'), schema: { tags: ['attendance'], summary: 'Latest reconciliation run', response: { 200: z.object({ id: z.string(), periodStart: z.string(), periodEnd: z.string(), summary: z.record(z.number()), findings: z.array(z.unknown()), createdAt: z.string() }).nullable() } } }, async () => {
    const r0 = await app.db.selectFrom('reconciliation_runs').selectAll().orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    return r0 ? { id: r0.id, periodStart: r0.period_start, periodEnd: r0.period_end, summary: r0.summary as Record<string, number>, findings: (r0.findings ?? []) as unknown[], createdAt: new Date(r0.created_at).toISOString() } : null;
  });

  // expose for tests/jobs
  app.decorate('attendanceProcessor', { loadScheduleContext, processEmployeeDay, processAffected, processRange });
  void hasPermission;
};

declare module 'fastify' {
  interface FastifyInstance { attendanceProcessor: { loadScheduleContext: typeof loadScheduleContext; processEmployeeDay: typeof processEmployeeDay; processAffected: typeof processAffected; processRange: typeof processRange } }
}
