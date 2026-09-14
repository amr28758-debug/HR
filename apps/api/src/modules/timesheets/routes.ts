import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, notFound } from '../../plugins/errors.js';
import { requireAuth, requirePermission, resolveScope } from '../../plugins/rbac.js';
import { assertCanSeeEmployee, teamEmployeeIds } from '../employees/service.js';
import { generateTimesheet, generateTimesheetsForPeriod, lockTimesheet } from './service.js';

const tsOut = z.object({
  id: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), year: z.number(), month: z.number(), periodStart: z.string(), periodEnd: z.string(), status: z.string(), siteName: z.string().nullable(), projectCode: z.string().nullable(), departmentName: z.string().nullable(),
  calendarDays: z.number(), scheduledDays: z.number(), presentDays: z.number(), absentDays: z.number(), paidLeaveDays: z.number(), unpaidLeaveDays: z.number(), weekOffDays: z.number(), holidayDays: z.number(), missingPunchDays: z.number(),
  scheduledMinutes: z.number(), workedMinutes: z.number(), normalMinutes: z.number(), overtimeMinutes: z.number(), unapprovedOvertimeMinutes: z.number(), weekendOtMinutes: z.number(), holidayOtMinutes: z.number(), lateMinutes: z.number(), earlyLeaveMinutes: z.number(), lateCount: z.number(),
  adjustments: z.array(z.unknown()), generatedAt: z.string(), approvedAt: z.string().nullable(), lockedAt: z.string().nullable(), payrollRunId: z.string().nullable(),
});
const n = (v: unknown) => Number(v);
const tsMap = (t: Record<string, any>) => ({
  id: t.id, employeeId: t.employee_id, employeeNo: t.employee_no, employeeName: t.full_name_en, year: t.period_year, month: t.period_month, periodStart: t.period_start, periodEnd: t.period_end, status: t.status, siteName: t.site_name ?? null, projectCode: t.project_code ?? null, departmentName: t.department_name ?? null,
  calendarDays: t.calendar_days, scheduledDays: t.scheduled_days, presentDays: n(t.present_days), absentDays: n(t.absent_days), paidLeaveDays: n(t.paid_leave_days), unpaidLeaveDays: n(t.unpaid_leave_days), weekOffDays: t.week_off_days, holidayDays: t.holiday_days, missingPunchDays: t.missing_punch_days,
  scheduledMinutes: t.scheduled_minutes, workedMinutes: t.worked_minutes, normalMinutes: t.normal_minutes, overtimeMinutes: t.overtime_minutes, unapprovedOvertimeMinutes: t.unapproved_overtime_minutes, weekendOtMinutes: t.weekend_ot_minutes, holidayOtMinutes: t.holiday_ot_minutes, lateMinutes: t.late_minutes, earlyLeaveMinutes: t.early_leave_minutes, lateCount: t.late_count,
  adjustments: (t.adjustments ?? []) as unknown[], generatedAt: new Date(t.generated_at).toISOString(), approvedAt: t.approved_at ? new Date(t.approved_at).toISOString() : null, lockedAt: t.locked_at ? new Date(t.locked_at).toISOString() : null, payrollRunId: t.payroll_run_id,
});

export const timesheetRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const query = () => app.db.selectFrom('timesheets as t').innerJoin('employees as e', 'e.id', 't.employee_id').leftJoin('sites as s', 's.id', 't.site_id').leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('departments as d', 'd.id', 't.department_id').selectAll('t').select(['e.employee_no', 'e.full_name_en', 's.name as site_name', 'p.code as project_code', 'd.name as department_name']);

  r.get('/', { preHandler: requirePermission('timesheets:read', 'timesheets:read:team', 'timesheets:read:own'), schema: { tags: ['timesheets'], summary: 'List timesheets for a period (scoped)', querystring: paginationQuery.merge(z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12), status: z.string().optional(), siteId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), employeeId: z.string().uuid().optional() })), response: { 200: paginated(tsOut) } } }, async (req) => {
    const p = requireAuth(req);
    const q = req.query;
    let base = query().where('t.period_year', '=', q.year).where('t.period_month', '=', q.month);
    const scope = resolveScope(p, 'timesheets');
    if (scope === 'own') base = base.where('t.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (scope === 'team') base = base.where('t.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (q.status) base = base.where('t.status', '=', q.status);
    if (q.siteId) base = base.where('t.site_id', '=', q.siteId);
    if (q.projectId) base = base.where('t.project_id', '=', q.projectId);
    if (q.employeeId) base = base.where('t.employee_id', '=', q.employeeId);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('e.employee_no').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(tsMap), meta: pageMeta(q, total) };
  });
  r.get('/:id', { preHandler: requirePermission('timesheets:read', 'timesheets:read:team', 'timesheets:read:own'), schema: { tags: ['timesheets'], summary: 'Timesheet with daily lines', params: idParam, response: { 200: tsOut.extend({ lines: z.array(z.object({ date: z.string(), status: z.string(), dayKind: z.string(), scheduledMinutes: z.number(), workedMinutes: z.number(), normalMinutes: z.number(), overtimeMinutes: z.number(), lateMinutes: z.number(), earlyLeaveMinutes: z.number(), leaveTypeCode: z.string().nullable(), isPaid: z.boolean() })) }), 404: errorSchema } } }, async (req) => {
    const t = await query().where('t.id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Timesheet', req.params.id);
    await assertCanSeeEmployee(app.db, requireAuth(req), 'timesheets', t.employee_id);
    const lines = await app.db.selectFrom('timesheet_lines').selectAll().where('timesheet_id', '=', t.id).orderBy('attendance_date').execute();
    return { ...tsMap(t), lines: lines.map((l) => ({ date: l.attendance_date, status: l.status, dayKind: l.day_kind, scheduledMinutes: l.scheduled_minutes, workedMinutes: l.worked_minutes, normalMinutes: l.normal_minutes, overtimeMinutes: l.overtime_minutes, lateMinutes: l.late_minutes, earlyLeaveMinutes: l.early_leave_minutes, leaveTypeCode: l.leave_type_code, isPaid: l.is_paid })) };
  });
  r.post('/generate', { preHandler: requirePermission('timesheets:generate'), schema: { tags: ['timesheets'], summary: 'Generate/regenerate timesheets for a period from daily attendance (locked ones untouched)', body: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), siteId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), employeeIds: z.array(z.string().uuid()).optional() }), response: { 200: z.object({ generated: z.number(), skippedLocked: z.number() }) } } }, async (req) => {
    const res = await generateTimesheetsForPeriod(app.db, req.body.year, req.body.month, req.body);
    await app.audit(req, { action: 'timesheet.generate', entityType: 'timesheet', metadata: { ...req.body, ...res } });
    return res;
  });
  r.post('/:id/regenerate', { preHandler: requirePermission('timesheets:generate'), schema: { tags: ['timesheets'], summary: 'Regenerate one timesheet', params: idParam, response: { 200: tsOut } } }, async (req) => {
    const t = await app.db.selectFrom('timesheets').select(['employee_id', 'period_year', 'period_month', 'locked_at']).where('id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Timesheet', req.params.id);
    if (t.locked_at) throw badRequest('Timesheet is locked');
    await generateTimesheet(app.db, t.employee_id, t.period_year, t.period_month);
    return tsMap(await query().where('t.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
  r.post('/:id/approve', { preHandler: requirePermission('timesheets:approve'), schema: { tags: ['timesheets'], summary: 'Approve a timesheet (manager/HR)', params: idParam, response: { 200: tsOut } } }, async (req) => {
    const p = requireAuth(req);
    const t = await app.db.selectFrom('timesheets').select(['employee_id', 'status', 'missing_punch_days']).where('id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Timesheet', req.params.id);
    if (t.status === 'LOCKED') throw badRequest('Timesheet is locked');
    await assertCanSeeEmployee(app.db, p, 'timesheets', t.employee_id);
    await app.db.updateTable('timesheets').set({ status: 'APPROVED', approved_by: p.userId, approved_at: new Date() }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'timesheet.approve', entityType: 'timesheet', entityId: req.params.id, metadata: { missingPunchDays: t.missing_punch_days } });
    return tsMap(await query().where('t.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
  r.post('/:id/adjust', { preHandler: requirePermission('timesheets:approve'), schema: { tags: ['timesheets'], summary: 'Add a documented adjustment (minutes/days) to an unlocked timesheet', params: idParam, body: z.object({ code: z.enum(['NORMAL_MINUTES', 'OVERTIME_MINUTES', 'PRESENT_DAYS', 'ABSENT_DAYS', 'UNPAID_LEAVE_DAYS']), delta: z.number(), note: z.string().min(5).max(500) }), response: { 200: tsOut } } }, async (req) => {
    const p = requireAuth(req);
    const t = await app.db.selectFrom('timesheets').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Timesheet', req.params.id);
    if (t.locked_at) throw badRequest('Timesheet is locked; use a payroll adjustment');
    const col = ({ NORMAL_MINUTES: 'normal_minutes', OVERTIME_MINUTES: 'overtime_minutes', PRESENT_DAYS: 'present_days', ABSENT_DAYS: 'absent_days', UNPAID_LEAVE_DAYS: 'unpaid_leave_days' } as const)[req.body.code];
    const adjustments = [...((t.adjustments as unknown[]) ?? []), { code: req.body.code, delta: req.body.delta, note: req.body.note, by: p.userId, at: new Date().toISOString() }];
    await app.db.updateTable('timesheets').set({ [col]: Number((t as any)[col]) + req.body.delta, adjustments: JSON.stringify(adjustments) } as any).where('id', '=', t.id).execute();
    await app.audit(req, { action: 'timesheet.adjust', entityType: 'timesheet', entityId: t.id, newValue: req.body, reason: req.body.note });
    return tsMap(await query().where('t.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
  r.post('/:id/lock', { preHandler: requirePermission('timesheets:lock'), schema: { tags: ['timesheets'], summary: 'Lock a timesheet (freezes its attendance days)', params: idParam, response: { 200: tsOut } } }, async (req) => {
    const t = await app.db.selectFrom('timesheets').select('status').where('id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Timesheet', req.params.id);
    await lockTimesheet(app.db, req.params.id);
    await app.audit(req, { action: 'timesheet.lock', entityType: 'timesheet', entityId: req.params.id, oldValue: { status: t.status }, newValue: { status: 'LOCKED' } });
    return tsMap(await query().where('t.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
};
