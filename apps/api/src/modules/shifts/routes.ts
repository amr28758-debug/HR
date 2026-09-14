import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SHIFT_TYPES } from '@burtplace/types';
import { errorSchema, idParam } from '../../lib/pagination.js';
import { badRequest, notFound } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { loadScheduleContext, resolveFor } from '../attendance/processor.service.js';
import { assertCanSeeEmployee } from '../employees/service.js';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shiftOut = z.object({
  id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), shiftType: z.string(), startTime: z.string(), endTime: z.string(), crossesMidnight: z.boolean(), requiredMinutes: z.number(), breakMinutes: z.number(), breakIsPaid: z.boolean(),
  graceInMinutes: z.number(), graceOutMinutes: z.number(), earlyInWindowMinutes: z.number(), lateOutWindowMinutes: z.number(), halfDayThresholdMinutes: z.number().nullable(), absentThresholdMinutes: z.number(),
  otEnabled: z.boolean(), otAfterMinutes: z.number().nullable(), otMinBlockMinutes: z.number(), otMaxMinutesPerDay: z.number().nullable(), otRoundingMinutes: z.number(), otRequiresApproval: z.boolean(), countEarlyInAsOt: z.boolean(), timezone: z.string(), isActive: z.boolean(),
});
const shiftIn = z.object({
  code: z.string().min(1).max(30), name: z.string().min(1), nameAr: z.string().nullable().optional(), shiftType: z.enum(SHIFT_TYPES).default('FIXED'), startTime: hhmm, endTime: hhmm, requiredMinutes: z.number().int().min(60).max(1440),
  breakMinutes: z.number().int().min(0).max(480).default(60), breakIsPaid: z.boolean().default(false), graceInMinutes: z.number().int().min(0).max(240).default(15), graceOutMinutes: z.number().int().min(0).max(240).default(0),
  earlyInWindowMinutes: z.number().int().min(0).max(720).default(120), lateOutWindowMinutes: z.number().int().min(0).max(720).default(360), halfDayThresholdMinutes: z.number().int().min(0).nullable().default(null), absentThresholdMinutes: z.number().int().min(0).default(0),
  otEnabled: z.boolean().default(true), otAfterMinutes: z.number().int().min(0).nullable().default(null), otMinBlockMinutes: z.number().int().min(0).default(30), otMaxMinutesPerDay: z.number().int().min(0).nullable().default(240), otRoundingMinutes: z.number().int().min(1).default(15),
  otRequiresApproval: z.boolean().default(true), countEarlyInAsOt: z.boolean().default(false), timezone: z.string().default('Asia/Dubai'), isActive: z.boolean().default(true),
});
const shiftMap = (s: Record<string, any>) => ({
  id: s.id, code: s.code, name: s.name, nameAr: s.name_ar, shiftType: s.shift_type, startTime: String(s.start_time).slice(0, 5), endTime: String(s.end_time).slice(0, 5), crossesMidnight: s.crosses_midnight, requiredMinutes: s.required_minutes, breakMinutes: s.break_minutes, breakIsPaid: s.break_is_paid,
  graceInMinutes: s.grace_in_minutes, graceOutMinutes: s.grace_out_minutes, earlyInWindowMinutes: s.early_in_window_minutes, lateOutWindowMinutes: s.late_out_window_minutes, halfDayThresholdMinutes: s.half_day_threshold_minutes, absentThresholdMinutes: s.absent_threshold_minutes,
  otEnabled: s.ot_enabled, otAfterMinutes: s.ot_after_minutes, otMinBlockMinutes: s.ot_min_block_minutes, otMaxMinutesPerDay: s.ot_max_minutes_per_day, otRoundingMinutes: s.ot_rounding_minutes, otRequiresApproval: s.ot_requires_approval, countEarlyInAsOt: s.count_early_in_as_ot, timezone: s.timezone, isActive: s.is_active,
});
const toRow = (b: Partial<z.infer<typeof shiftIn>>) => ({
  ...(b.code !== undefined && { code: b.code }), ...(b.name !== undefined && { name: b.name }), ...(b.nameAr !== undefined && { name_ar: b.nameAr }), ...(b.shiftType !== undefined && { shift_type: b.shiftType }), ...(b.startTime !== undefined && { start_time: b.startTime }), ...(b.endTime !== undefined && { end_time: b.endTime }),
  ...(b.requiredMinutes !== undefined && { required_minutes: b.requiredMinutes }), ...(b.breakMinutes !== undefined && { break_minutes: b.breakMinutes }), ...(b.breakIsPaid !== undefined && { break_is_paid: b.breakIsPaid }), ...(b.graceInMinutes !== undefined && { grace_in_minutes: b.graceInMinutes }), ...(b.graceOutMinutes !== undefined && { grace_out_minutes: b.graceOutMinutes }),
  ...(b.earlyInWindowMinutes !== undefined && { early_in_window_minutes: b.earlyInWindowMinutes }), ...(b.lateOutWindowMinutes !== undefined && { late_out_window_minutes: b.lateOutWindowMinutes }), ...(b.halfDayThresholdMinutes !== undefined && { half_day_threshold_minutes: b.halfDayThresholdMinutes }), ...(b.absentThresholdMinutes !== undefined && { absent_threshold_minutes: b.absentThresholdMinutes }),
  ...(b.otEnabled !== undefined && { ot_enabled: b.otEnabled }), ...(b.otAfterMinutes !== undefined && { ot_after_minutes: b.otAfterMinutes }), ...(b.otMinBlockMinutes !== undefined && { ot_min_block_minutes: b.otMinBlockMinutes }), ...(b.otMaxMinutesPerDay !== undefined && { ot_max_minutes_per_day: b.otMaxMinutesPerDay }), ...(b.otRoundingMinutes !== undefined && { ot_rounding_minutes: b.otRoundingMinutes }),
  ...(b.otRequiresApproval !== undefined && { ot_requires_approval: b.otRequiresApproval }), ...(b.countEarlyInAsOt !== undefined && { count_early_in_as_ot: b.countEarlyInAsOt }), ...(b.timezone !== undefined && { timezone: b.timezone }), ...(b.isActive !== undefined && { is_active: b.isActive }),
});

export const shiftRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/', { preHandler: requirePermission('shifts:read'), schema: { tags: ['shifts'], summary: 'List shifts', response: { 200: z.array(shiftOut) } } }, async () => (await app.db.selectFrom('shifts').selectAll().where('deleted_at', 'is', null).orderBy('code').execute()).map(shiftMap));
  r.post('/', { preHandler: requirePermission('shifts:write'), schema: { tags: ['shifts'], summary: 'Create shift (rules are configuration, not code)', body: shiftIn, response: { 201: shiftOut } } }, async (req, reply) => {
    const s = await app.db.insertInto('shifts').values(toRow(req.body) as any).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'shift.create', entityType: 'shift', entityId: s.id, newValue: req.body });
    return reply.status(201).send(shiftMap(s));
  });
  r.patch('/:id', { preHandler: requirePermission('shifts:write'), schema: { tags: ['shifts'], summary: 'Update shift (affects future recalculations; locked days are never changed)', params: idParam, body: shiftIn.partial(), response: { 200: shiftOut, 404: errorSchema } } }, async (req) => {
    const before = await app.db.selectFrom('shifts').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!before) throw notFound('Shift', req.params.id);
    const s = await app.db.updateTable('shifts').set(toRow(req.body) as any).where('id', '=', req.params.id).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'shift.update', entityType: 'shift', entityId: s.id, oldValue: shiftMap(before), newValue: req.body });
    return shiftMap(s);
  });

  // Work patterns
  const wpOut = z.object({ id: z.string(), code: z.string(), name: z.string(), weekOffs: z.array(z.number()), defaultShiftId: z.string().nullable(), weekdayShifts: z.record(z.string()), isActive: z.boolean() });
  const wpIn = z.object({ code: z.string().min(1), name: z.string().min(1), weekOffs: z.array(z.number().int().min(0).max(6)).default([5]), defaultShiftId: z.string().uuid().nullable().optional(), weekdayShifts: z.record(z.string().uuid()).default({}), isActive: z.boolean().optional() });
  const wpMap = (w: Record<string, any>) => ({ id: w.id, code: w.code, name: w.name, weekOffs: w.week_offs, defaultShiftId: w.default_shift_id, weekdayShifts: w.weekday_shifts ?? {}, isActive: w.is_active });
  r.get('/work-patterns', { preHandler: requirePermission('shifts:read'), schema: { tags: ['shifts'], summary: 'List work patterns', response: { 200: z.array(wpOut) } } }, async () => (await app.db.selectFrom('work_patterns').selectAll().orderBy('code').execute()).map(wpMap));
  r.post('/work-patterns', { preHandler: requirePermission('shifts:write'), schema: { tags: ['shifts'], summary: 'Create work pattern', body: wpIn, response: { 201: wpOut } } }, async (req, reply) => {
    const b = req.body;
    const w = await app.db.insertInto('work_patterns').values({ code: b.code, name: b.name, week_offs: b.weekOffs, default_shift_id: b.defaultShiftId ?? null, weekday_shifts: JSON.stringify(b.weekdayShifts) }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'work_pattern.create', entityType: 'work_pattern', entityId: w.id, newValue: b });
    return reply.status(201).send(wpMap(w));
  });

  // Assignments
  const asgOut = z.object({ id: z.string(), scope: z.string(), employeeId: z.string().nullable(), siteId: z.string().nullable(), projectId: z.string().nullable(), workPatternId: z.string().nullable(), shiftId: z.string().nullable(), effectiveFrom: z.string(), effectiveTo: z.string().nullable(), priority: z.number(), createdAt: z.string() });
  const asgMap = (a: Record<string, any>) => ({ id: a.id, scope: a.employee_id ? 'EMPLOYEE' : a.project_id ? 'PROJECT' : 'SITE', employeeId: a.employee_id, siteId: a.site_id, projectId: a.project_id, workPatternId: a.work_pattern_id, shiftId: a.shift_id, effectiveFrom: a.effective_from, effectiveTo: a.effective_to, priority: a.priority, createdAt: new Date(a.created_at).toISOString() });
  r.get('/assignments', { preHandler: requirePermission('shifts:read'), schema: { tags: ['shifts'], summary: 'List shift assignments', querystring: z.object({ employeeId: z.string().uuid().optional(), siteId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }), response: { 200: z.array(asgOut) } } }, async (req) => {
    let q = app.db.selectFrom('shift_assignments').selectAll();
    if (req.query.employeeId) q = q.where('employee_id', '=', req.query.employeeId);
    if (req.query.siteId) q = q.where('site_id', '=', req.query.siteId);
    if (req.query.projectId) q = q.where('project_id', '=', req.query.projectId);
    return (await q.orderBy('effective_from', 'desc').limit(500).execute()).map(asgMap);
  });
  r.post('/assignments', { preHandler: requirePermission('shifts:assign'), schema: { tags: ['shifts'], summary: 'Assign a work pattern / shift to an employee, site or project (exactly one target)', body: z.object({ employeeId: z.string().uuid().optional(), siteId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), workPatternId: z.string().uuid().optional(), shiftId: z.string().uuid().optional(), effectiveFrom: isoDate, effectiveTo: isoDate.nullable().optional(), priority: z.number().int().default(0), recalculate: z.boolean().default(true) }), response: { 201: asgOut, 400: errorSchema } } }, async (req, reply) => {
    const b = req.body;
    const p = requireAuth(req);
    if ([b.employeeId, b.siteId, b.projectId].filter(Boolean).length !== 1) throw badRequest('Exactly one of employeeId, siteId, projectId is required');
    if (!b.workPatternId && !b.shiftId) throw badRequest('workPatternId or shiftId is required');
    const a = await app.db.insertInto('shift_assignments').values({ employee_id: b.employeeId ?? null, site_id: b.siteId ?? null, project_id: b.projectId ?? null, work_pattern_id: b.workPatternId ?? null, shift_id: b.shiftId ?? null, effective_from: b.effectiveFrom, effective_to: b.effectiveTo ?? null, priority: b.priority, created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'shift.assign', entityType: 'shift_assignment', entityId: a.id, newValue: b });
    if (b.recalculate && b.employeeId) {
      const today = new Date().toISOString().slice(0, 10);
      if (b.effectiveFrom <= today) await app.queues.enqueueProcessRange(b.effectiveFrom, today, [b.employeeId]);
    }
    return reply.status(201).send(asgMap(a));
  });
  r.delete('/assignments/:id', { preHandler: requirePermission('shifts:assign'), schema: { tags: ['shifts'], summary: 'End an assignment (sets effective_to to today if still open, else deletes future one)', params: idParam, response: { 204: z.null() } } }, async (req, reply) => {
    const a = await app.db.selectFrom('shift_assignments').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!a) throw notFound('Assignment', req.params.id);
    const today = new Date().toISOString().slice(0, 10);
    if (a.effective_from > today) await app.db.deleteFrom('shift_assignments').where('id', '=', a.id).execute();
    else await app.db.updateTable('shift_assignments').set({ effective_to: today }).where('id', '=', a.id).execute();
    await app.audit(req, { action: 'shift.unassign', entityType: 'shift_assignment', entityId: a.id, oldValue: asgMap(a) });
    return reply.status(204).send(null);
  });

  // Resolve schedule preview
  r.get('/resolve/:employeeId', { preHandler: requirePermission('shifts:read', 'attendance:read:own'), schema: { tags: ['shifts'], summary: 'Resolve the effective schedule for an employee over a date range', params: z.object({ employeeId: z.string().uuid() }), querystring: z.object({ from: isoDate, to: isoDate }), response: { 200: z.array(z.object({ date: z.string(), isWorkingDay: z.boolean(), isWeekOff: z.boolean(), isHoliday: z.boolean(), shiftCode: z.string().nullable(), scheduledStart: z.string().nullable(), scheduledEnd: z.string().nullable() })) } } }, async (req) => {
    await assertCanSeeEmployee(app.db, requireAuth(req), 'attendance', req.params.employeeId);
    const ctx = await loadScheduleContext(app.db, req.params.employeeId, req.query.from, req.query.to);
    if (!ctx) throw notFound('Employee', req.params.employeeId);
    const { eachDate } = await import('@burtplace/core');
    return eachDate(req.query.from, req.query.to).map((d) => { const s = resolveFor(ctx, d); return { date: d, isWorkingDay: s.isWorkingDay, isWeekOff: s.isWeekOff, isHoliday: s.isHoliday, shiftCode: s.shift?.code ?? null, scheduledStart: s.scheduledStart?.toISOString() ?? null, scheduledEnd: s.scheduledEnd?.toISOString() ?? null }; });
  });
};
