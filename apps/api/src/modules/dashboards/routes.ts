import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { teamEmployeeIds } from '../employees/service.js';

const WORKING = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED'] as const;
const today = () => new Date().toISOString().slice(0, 10);

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const countWhere = async (status: string, date: string, ids?: string[]) => {
    let q = app.db.selectFrom('attendance_daily').select((eb) => eb.fn.countAll<number>().as('n')).where('attendance_date', '=', date).where('status', '=', status as any);
    if (ids) q = q.where('employee_id', 'in', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    return Number((await q.executeTakeFirstOrThrow()).n);
  };

  r.get('/executive', { preHandler: requirePermission('dashboard:executive'), schema: { tags: ['dashboards'], summary: 'Executive KPIs', querystring: z.object({ date: z.string().optional() }), response: { 200: z.object({ date: z.string(), headcount: z.number(), presentToday: z.number(), absentToday: z.number(), onLeaveToday: z.number(), lateToday: z.number(), overtimeHoursMonth: z.number(), projects: z.number(), sites: z.number(), lastPayroll: z.object({ code: z.string(), status: z.string(), totalNet: z.number(), employeeCount: z.number() }).nullable(), labourCostByProject: z.array(z.object({ projectCode: z.string(), projectName: z.string(), employees: z.number(), normalCost: z.number(), otCost: z.number(), totalCost: z.number() })), headcountByStatus: z.array(z.object({ status: z.string(), count: z.number() })), attendanceTrend: z.array(z.object({ date: z.string(), present: z.number(), absent: z.number(), onLeave: z.number() })) }) } } }, async (req) => {
    const date = req.query.date ?? today();
    const monthStart = `${date.slice(0, 7)}-01`;
    const headcount = Number((await app.db.selectFrom('employees').select((eb) => eb.fn.countAll<number>().as('n')).where('deleted_at', 'is', null).where('status', 'in', WORKING).executeTakeFirstOrThrow()).n);
    const late = Number((await app.db.selectFrom('attendance_daily').select((eb) => eb.fn.countAll<number>().as('n')).where('attendance_date', '=', date).where('late_minutes', '>', 0).executeTakeFirstOrThrow()).n);
    const ot = await app.db.selectFrom('attendance_daily').select((eb) => eb.fn.sum<number>('approved_overtime_minutes').as('m')).where('attendance_date', '>=', monthStart).where('attendance_date', '<=', date).executeTakeFirstOrThrow();
    const lastRun = await app.db.selectFrom('payroll_runs').select(['code', 'status', 'total_net', 'employee_count']).orderBy('period_year', 'desc').orderBy('period_month', 'desc').executeTakeFirst();
    const cost = await sql<{ project_code: string; project_name: string; employees: number; normal_cost: string; ot_cost: string }>`
      SELECT p.code AS project_code, p.name AS project_name, count(pe.id)::int AS employees,
        coalesce(sum((SELECT coalesce(sum(amount),0) FROM payroll_earnings e WHERE e.payroll_employee_id = pe.id AND e.component_code NOT LIKE 'OT%')),0) AS normal_cost,
        coalesce(sum((SELECT coalesce(sum(amount),0) FROM payroll_earnings e WHERE e.payroll_employee_id = pe.id AND e.component_code LIKE 'OT%')),0) AS ot_cost
      FROM payroll_employees pe JOIN payroll_runs r ON r.id = pe.payroll_run_id JOIN projects p ON p.id = pe.project_id
      WHERE r.id = (SELECT id FROM payroll_runs ORDER BY period_year DESC, period_month DESC LIMIT 1)
      GROUP BY p.code, p.name ORDER BY 5 DESC`.execute(app.db);
    const byStatus = await app.db.selectFrom('employees').select(['status', (eb) => eb.fn.countAll<number>().as('n')]).where('deleted_at', 'is', null).groupBy('status').execute();
    const trend = await sql<{ d: string; present: number; absent: number; on_leave: number }>`
      SELECT attendance_date::text AS d, count(*) FILTER (WHERE status IN ('PRESENT','HALF_DAY'))::int AS present, count(*) FILTER (WHERE status='ABSENT')::int AS absent, count(*) FILTER (WHERE status='ON_LEAVE')::int AS on_leave
      FROM attendance_daily WHERE attendance_date > ${date}::date - 14 AND attendance_date <= ${date}::date GROUP BY attendance_date ORDER BY attendance_date`.execute(app.db);
    return {
      date, headcount, presentToday: (await countWhere('PRESENT', date)) + (await countWhere('HALF_DAY', date)), absentToday: await countWhere('ABSENT', date), onLeaveToday: await countWhere('ON_LEAVE', date), lateToday: late, overtimeHoursMonth: Math.round(Number(ot.m ?? 0) / 6) / 10,
      projects: Number((await app.db.selectFrom('projects').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'ACTIVE').where('deleted_at', 'is', null).executeTakeFirstOrThrow()).n),
      sites: Number((await app.db.selectFrom('sites').select((eb) => eb.fn.countAll<number>().as('n')).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirstOrThrow()).n),
      lastPayroll: lastRun ? { code: lastRun.code, status: lastRun.status, totalNet: Number(lastRun.total_net), employeeCount: lastRun.employee_count } : null,
      labourCostByProject: cost.rows.map((c) => ({ projectCode: c.project_code, projectName: c.project_name, employees: c.employees, normalCost: Number(c.normal_cost), otCost: Number(c.ot_cost), totalCost: Number(c.normal_cost) + Number(c.ot_cost) })),
      headcountByStatus: byStatus.map((s) => ({ status: s.status, count: Number(s.n) })),
      attendanceTrend: trend.rows.map((t) => ({ date: t.d, present: t.present, absent: t.absent, onLeave: t.on_leave })),
    };
  });

  r.get('/hr', { preHandler: requirePermission('dashboard:hr'), schema: { tags: ['dashboards'], summary: 'HR KPIs', response: { 200: z.object({ newJoiners30d: z.number(), onProbation: z.number(), probationEnding30d: z.number(), expiringDocuments60d: z.number(), expiredDocuments: z.number(), contractsEnding60d: z.number(), pendingLeave: z.number(), openExceptions: z.number(), exceptionsByType: z.array(z.object({ type: z.string(), count: z.number() })), movements30d: z.array(z.object({ changeType: z.string(), count: z.number() })), leavers30d: z.number(), expiringList: z.array(z.object({ employeeNo: z.string(), name: z.string(), documentType: z.string(), expiryDate: z.string(), daysToExpiry: z.number() })) }) } } }, async () => {
    const c = async (q: any) => Number((await q.executeTakeFirstOrThrow()).n);
    const cnt = () => app.db.selectFrom('employees').select((eb) => eb.fn.countAll<number>().as('n')).where('deleted_at', 'is', null);
    const exByType = await app.db.selectFrom('attendance_exceptions').select(['exception_type', (eb) => eb.fn.countAll<number>().as('n')]).where('status', '=', 'OPEN').groupBy('exception_type').execute();
    const mov = await app.db.selectFrom('employment_history').select(['change_type', (eb) => eb.fn.countAll<number>().as('n')]).where('created_at', '>=', sql<Date>`now() - interval '30 days'`).where('change_type', '<>', 'JOIN').groupBy('change_type').execute();
    const expiring = await app.db.selectFrom('v_document_expiry').selectAll().where('days_to_expiry', '<=', 60).orderBy('days_to_expiry').limit(25).execute();
    return {
      newJoiners30d: await c(cnt().where('joining_date', '>=', sql<string>`current_date - 30`)), onProbation: await c(cnt().where('probation_status', '=', 'ON_PROBATION')),
      probationEnding30d: await c(cnt().where('probation_status', '=', 'ON_PROBATION').where('probation_end_date', '<=', sql<string>`current_date + 30`)),
      expiringDocuments60d: await c(app.db.selectFrom('v_document_expiry').select((eb) => eb.fn.countAll<number>().as('n')).where('days_to_expiry', '<=', 60).where('days_to_expiry', '>=', 0)),
      expiredDocuments: await c(app.db.selectFrom('v_document_expiry').select((eb) => eb.fn.countAll<number>().as('n')).where('days_to_expiry', '<', 0)),
      contractsEnding60d: await c(cnt().where('status', 'in', WORKING).where('contract_end_date', '<=', sql<string>`current_date + 60`).where('contract_end_date', '>=', sql<string>`current_date`)),
      pendingLeave: await c(app.db.selectFrom('leave_requests').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'PENDING')),
      openExceptions: exByType.reduce((s, e) => s + Number(e.n), 0), exceptionsByType: exByType.map((e) => ({ type: e.exception_type, count: Number(e.n) })), movements30d: mov.map((m) => ({ changeType: m.change_type, count: Number(m.n) })),
      leavers30d: await c(app.db.selectFrom('employee_status_history').select((eb) => eb.fn.countAll<number>().as('n')).where('to_status', 'in', ['RESIGNED', 'TERMINATED']).where('created_at', '>=', sql<Date>`now() - interval '30 days'`)),
      expiringList: expiring.map((d) => ({ employeeNo: d.employee_no, name: d.full_name_en, documentType: d.document_type, expiryDate: d.expiry_date, daysToExpiry: Number(d.days_to_expiry) })),
    };
  });

  r.get('/manager', { preHandler: requirePermission('dashboard:manager'), schema: { tags: ['dashboards'], summary: 'My team today', querystring: z.object({ date: z.string().optional() }), response: { 200: z.object({ date: z.string(), teamSize: z.number(), present: z.number(), absent: z.number(), late: z.number(), onLeave: z.number(), missingPunch: z.number(), overtimeMinutes: z.number(), pendingApprovals: z.number(), team: z.array(z.object({ employeeId: z.string(), employeeNo: z.string(), name: z.string(), status: z.string().nullable(), firstInAt: z.string().nullable(), lastOutAt: z.string().nullable(), lateMinutes: z.number(), overtimeMinutes: z.number() })) }) } } }, async (req) => {
    const p = requireAuth(req);
    const date = req.query.date ?? today();
    const ids = await teamEmployeeIds(app.db, p);
    const rows = ids.length ? await app.db.selectFrom('employees as e').leftJoin('attendance_daily as d', (j) => j.onRef('d.employee_id', '=', 'e.id').on('d.attendance_date', '=', date)).select(['e.id', 'e.employee_no', 'e.full_name_en', 'd.status', 'd.first_in_at', 'd.last_out_at', 'd.late_minutes', 'd.overtime_minutes']).where('e.id', 'in', ids).orderBy('e.employee_no').execute() : [];
    const pending = await app.db.selectFrom('workflow_tasks').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'PENDING').where((eb) => eb.or([eb('assignee_user_id', '=', p.userId), ...(p.roles.length ? [eb('assignee_role_code', 'in', p.roles)] : [])])).executeTakeFirstOrThrow();
    const cnt = (s: string) => rows.filter((x) => x.status === s).length;
    return { date, teamSize: rows.length, present: cnt('PRESENT') + cnt('HALF_DAY'), absent: cnt('ABSENT'), late: rows.filter((x) => (x.late_minutes ?? 0) > 0).length, onLeave: cnt('ON_LEAVE'), missingPunch: cnt('MISSING_PUNCH'), overtimeMinutes: rows.reduce((s, x) => s + (x.overtime_minutes ?? 0), 0), pendingApprovals: Number(pending.n),
      team: rows.map((x) => ({ employeeId: x.id, employeeNo: x.employee_no, name: x.full_name_en, status: x.status ?? null, firstInAt: x.first_in_at ? new Date(x.first_in_at).toISOString() : null, lastOutAt: x.last_out_at ? new Date(x.last_out_at).toISOString() : null, lateMinutes: x.late_minutes ?? 0, overtimeMinutes: x.overtime_minutes ?? 0 })) };
  });

  r.get('/payroll', { preHandler: requirePermission('dashboard:payroll'), schema: { tags: ['dashboards'], summary: 'Payroll KPIs for the latest run', response: { 200: z.object({ run: z.object({ id: z.string(), code: z.string(), status: z.string(), employeeCount: z.number(), totalGross: z.number(), totalEarnings: z.number(), totalDeductions: z.number(), totalNet: z.number() }).nullable(), otCost: z.number(), exceptions: z.number(), pendingAdjustments: z.number(), byDepartment: z.array(z.object({ department: z.string(), employees: z.number(), net: z.number() })), history: z.array(z.object({ code: z.string(), totalNet: z.number(), employeeCount: z.number() })) }) } } }, async () => {
    const run = await app.db.selectFrom('payroll_runs').selectAll().orderBy('period_year', 'desc').orderBy('period_month', 'desc').executeTakeFirst();
    const otCost = run ? Number((await app.db.selectFrom('payroll_earnings as e').innerJoin('payroll_employees as pe', 'pe.id', 'e.payroll_employee_id').select((eb) => eb.fn.sum<number>('e.amount').as('s')).where('pe.payroll_run_id', '=', run.id).where('e.component_code', 'like', 'OT%').executeTakeFirstOrThrow()).s ?? 0) : 0;
    const exceptions = run ? Number((await app.db.selectFrom('payroll_employees').select((eb) => eb.fn.countAll<number>().as('n')).where('payroll_run_id', '=', run.id).where('has_exceptions', '=', true).executeTakeFirstOrThrow()).n) : 0;
    const pendingAdj = Number((await app.db.selectFrom('payroll_adjustments').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'PENDING').executeTakeFirstOrThrow()).n);
    const byDept = run ? await app.db.selectFrom('payroll_employees as pe').leftJoin('departments as d', 'd.id', 'pe.department_id').select(['d.name', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.sum<number>('pe.net_salary').as('net')]).where('pe.payroll_run_id', '=', run.id).groupBy('d.name').orderBy('net', 'desc').execute() : [];
    const history = await app.db.selectFrom('payroll_runs').select(['code', 'total_net', 'employee_count']).orderBy('period_year', 'desc').orderBy('period_month', 'desc').limit(12).execute();
    return { run: run ? { id: run.id, code: run.code, status: run.status, employeeCount: run.employee_count, totalGross: Number(run.total_gross), totalEarnings: Number(run.total_earnings), totalDeductions: Number(run.total_deductions), totalNet: Number(run.total_net) } : null, otCost, exceptions, pendingAdjustments: pendingAdj, byDepartment: byDept.map((d) => ({ department: d.name ?? 'Unassigned', employees: Number(d.n), net: Number(d.net ?? 0) })), history: history.reverse().map((h) => ({ code: h.code, totalNet: Number(h.total_net), employeeCount: h.employee_count })) };
  });

  r.get('/me', { preHandler: requirePermission('employees:read:own'), schema: { tags: ['dashboards'], summary: 'Employee self-service summary', response: { 200: z.object({ employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), status: z.string() }).nullable(), today: z.object({ status: z.string().nullable(), firstInAt: z.string().nullable(), lastOutAt: z.string().nullable() }), monthSummary: z.object({ present: z.number(), absent: z.number(), late: z.number(), overtimeMinutes: z.number() }), leaveBalances: z.array(z.object({ code: z.string(), available: z.number() })), pendingRequests: z.number(), unreadNotifications: z.number() }) } } }, async (req) => {
    const p = requireAuth(req);
    const emp = p.employeeId ? await app.db.selectFrom('employees').select(['id', 'employee_no', 'full_name_en', 'status']).where('id', '=', p.employeeId).executeTakeFirst() : null;
    const d = today();
    const td = emp ? await app.db.selectFrom('attendance_daily').select(['status', 'first_in_at', 'last_out_at']).where('employee_id', '=', emp.id).where('attendance_date', '=', d).executeTakeFirst() : null;
    const ms = emp ? await app.db.selectFrom('attendance_daily').select([(eb) => eb.fn.count<number>('id').filterWhere('status', 'in', ['PRESENT', 'HALF_DAY']).as('present'), (eb) => eb.fn.count<number>('id').filterWhere('status', '=', 'ABSENT').as('absent'), (eb) => eb.fn.count<number>('id').filterWhere('late_minutes', '>', 0).as('late'), (eb) => eb.fn.sum<number>('approved_overtime_minutes').as('ot')]).where('employee_id', '=', emp.id).where('attendance_date', '>=', `${d.slice(0, 7)}-01`).executeTakeFirst() : null;
    const bals = emp ? await app.db.selectFrom('leave_balances as b').innerJoin('leave_types as t', 't.id', 'b.leave_type_id').select(['t.code', 'b.balance_days', 'b.pending_days']).where('b.employee_id', '=', emp.id).where('b.period_year', '=', new Date().getFullYear()).execute() : [];
    const pending = emp ? Number((await app.db.selectFrom('leave_requests').select((eb) => eb.fn.countAll<number>().as('n')).where('employee_id', '=', emp.id).where('status', '=', 'PENDING').executeTakeFirstOrThrow()).n) : 0;
    const unread = Number((await app.db.selectFrom('notifications').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', p.userId).where('read_at', 'is', null).executeTakeFirstOrThrow()).n);
    return { employee: emp ? { id: emp.id, employeeNo: emp.employee_no, name: emp.full_name_en, status: emp.status } : null, today: { status: td?.status ?? null, firstInAt: td?.first_in_at ? new Date(td.first_in_at).toISOString() : null, lastOutAt: td?.last_out_at ? new Date(td.last_out_at).toISOString() : null }, monthSummary: { present: Number(ms?.present ?? 0), absent: Number(ms?.absent ?? 0), late: Number(ms?.late ?? 0), overtimeMinutes: Number(ms?.ot ?? 0) }, leaveBalances: bals.map((b) => ({ code: b.code, available: Number(b.balance_days) - Number(b.pending_days) })), pendingRequests: pending, unreadNotifications: unread };
  });
};
