import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { badRequest } from '../../plugins/errors.js';
import { requirePermission } from '../../plugins/rbac.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fmt = z.enum(['json', 'csv']).default('json');

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

/**
 * Reports are SQL-backed, filterable and exportable as JSON or CSV (Excel opens CSV; XLSX/PDF rendering is a web-side concern via the same JSON).
 * Every report is registered in REPORTS so the UI can list them.
 */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const send = (reply: any, format: string, name: string, rows: Record<string, unknown>[]) => format === 'csv' ? reply.header('content-type', 'text/csv').header('content-disposition', `attachment; filename="${name}.csv"`).send(toCsv(rows)) : { data: rows, count: rows.length };

  const REPORTS = [
    { key: 'hr/headcount', name: 'Headcount by department / site / project', permission: 'reports:hr' }, { key: 'hr/joiners-leavers', name: 'Joiners & leavers (turnover)', permission: 'reports:hr' }, { key: 'hr/employee-list', name: 'Employee list', permission: 'reports:hr' }, { key: 'hr/expiring-documents', name: 'Expiring documents', permission: 'reports:hr' },
    { key: 'attendance/daily', name: 'Daily attendance', permission: 'reports:attendance' }, { key: 'attendance/monthly', name: 'Monthly attendance summary', permission: 'reports:attendance' }, { key: 'attendance/late', name: 'Late arrivals', permission: 'reports:attendance' }, { key: 'attendance/absence', name: 'Absence', permission: 'reports:attendance' }, { key: 'attendance/overtime', name: 'Overtime', permission: 'reports:attendance' }, { key: 'attendance/missing-punch', name: 'Missing punches', permission: 'reports:attendance' }, { key: 'attendance/site', name: 'Site attendance', permission: 'reports:attendance' },
    { key: 'payroll/register', name: 'Payroll register', permission: 'reports:payroll' }, { key: 'payroll/components', name: 'Earnings & deductions by component', permission: 'reports:payroll' }, { key: 'payroll/cost', name: 'Labour cost by project / department / cost center', permission: 'reports:cost' }, { key: 'payroll/variance', name: 'Payroll variance vs previous run', permission: 'reports:payroll' },
  ];
  r.get('/', { preHandler: requirePermission('reports:hr', 'reports:attendance', 'reports:payroll', 'reports:cost'), schema: { tags: ['reports'], summary: 'Available reports', response: { 200: z.array(z.object({ key: z.string(), name: z.string(), permission: z.string() })) } } }, async () => REPORTS);

  r.get('/hr/headcount', { preHandler: requirePermission('reports:hr'), schema: { tags: ['reports'], summary: 'Headcount', querystring: z.object({ groupBy: z.enum(['department', 'site', 'project', 'designation', 'nationality']).default('department'), format: fmt }) } }, async (req, reply) => {
    const col = { department: sql`d.name`, site: sql`s.name`, project: sql`p.code || ' ' || p.name`, designation: sql`g.title`, nationality: sql`e.nationality` }[req.query.groupBy];
    const rows = await sql<Record<string, unknown>>`SELECT coalesce(${col}, 'Unassigned') AS "group", count(*)::int AS headcount, count(*) FILTER (WHERE e.probation_status = 'ON_PROBATION')::int AS on_probation, count(*) FILTER (WHERE e.is_office_staff)::int AS office_staff
      FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN sites s ON s.id = e.site_id LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN designations g ON g.id = e.designation_id
      WHERE e.deleted_at IS NULL AND e.status IN ('ACTIVE','PROBATION','CONFIRMED','TRANSFERRED','PROMOTED') GROUP BY 1 ORDER BY 2 DESC`.execute(app.db);
    return send(reply, req.query.format, 'headcount', rows.rows);
  });
  r.get('/hr/joiners-leavers', { preHandler: requirePermission('reports:hr'), schema: { tags: ['reports'], summary: 'Joiners & leavers per month', querystring: z.object({ from: isoDate, to: isoDate, format: fmt }) } }, async (req, reply) => {
    const rows = await sql<Record<string, unknown>>`WITH m AS (SELECT to_char(d, 'YYYY-MM') AS month FROM generate_series(date_trunc('month', ${req.query.from}::date), ${req.query.to}::date, '1 month') d)
      SELECT m.month, (SELECT count(*) FROM employees e WHERE to_char(e.joining_date,'YYYY-MM') = m.month AND e.deleted_at IS NULL)::int AS joiners,
        (SELECT count(*) FROM employee_status_history h WHERE h.to_status IN ('RESIGNED','TERMINATED') AND to_char(h.effective_date,'YYYY-MM') = m.month)::int AS leavers,
        (SELECT count(*) FROM employees e WHERE e.deleted_at IS NULL AND e.joining_date <= (m.month || '-01')::date + interval '1 month' - interval '1 day' AND (e.last_working_date IS NULL OR e.last_working_date >= (m.month || '-01')::date))::int AS headcount_end
      FROM m ORDER BY m.month`.execute(app.db);
    return send(reply, req.query.format, 'joiners-leavers', rows.rows.map((x: any) => ({ ...x, turnover_pct: x.headcount_end ? Math.round((x.leavers / x.headcount_end) * 1000) / 10 : 0 })));
  });
  r.get('/hr/employee-list', { preHandler: requirePermission('reports:hr'), schema: { tags: ['reports'], summary: 'Employee list', querystring: z.object({ status: z.string().optional(), siteId: z.string().uuid().optional(), format: fmt }) } }, async (req, reply) => {
    let q = app.db.selectFrom('v_employee_directory').select(['employee_no', 'full_name_en', 'status', 'employment_type', 'joining_date', 'department_name', 'designation_title', 'site_name', 'project_code', 'manager_name', 'mobile', 'work_email', 'contract_end_date']);
    if (req.query.status) q = q.where('status', '=', req.query.status as any);
    if (req.query.siteId) q = q.where('site_id', '=', req.query.siteId);
    return send(reply, req.query.format, 'employee-list', await q.orderBy('employee_no').execute());
  });
  r.get('/hr/expiring-documents', { preHandler: requirePermission('reports:hr'), schema: { tags: ['reports'], summary: 'Documents expiring within N days', querystring: z.object({ days: z.coerce.number().int().default(90), format: fmt }) } }, async (req, reply) => {
    const rows = await app.db.selectFrom('v_document_expiry').select(['employee_no', 'full_name_en', 'document_type', 'document_number', 'expiry_date', 'days_to_expiry', 'computed_status']).where('days_to_expiry', '<=', req.query.days).orderBy('days_to_expiry').execute();
    return send(reply, req.query.format, 'expiring-documents', rows);
  });

  const attendanceBase = (from: string, to: string) => app.db.selectFrom('attendance_daily as a').innerJoin('employees as e', 'e.id', 'a.employee_id').leftJoin('sites as s', 's.id', 'a.site_id').leftJoin('projects as p', 'p.id', 'a.project_id').leftJoin('departments as d', 'd.id', 'e.department_id').where('a.attendance_date', '>=', from).where('a.attendance_date', '<=', to);
  const attFilter = <Q extends ReturnType<typeof attendanceBase>>(q: Q, f: { siteId?: string; projectId?: string; departmentId?: string }): Q => { if (f.siteId) q = q.where('a.site_id', '=', f.siteId) as Q; if (f.projectId) q = q.where('a.project_id', '=', f.projectId) as Q; if (f.departmentId) q = q.where('e.department_id', '=', f.departmentId) as Q; return q; };
  const attQ = z.object({ from: isoDate, to: isoDate, siteId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), format: fmt });
  r.get('/attendance/daily', { preHandler: requirePermission('reports:attendance'), schema: { tags: ['reports'], summary: 'Daily attendance detail', querystring: attQ } }, async (req, reply) => send(reply, req.query.format, 'attendance-daily', await attFilter(attendanceBase(req.query.from, req.query.to), req.query).select(['a.attendance_date', 'e.employee_no', 'e.full_name_en', 'd.name as department', 's.name as site', 'p.code as project', 'a.status', 'a.first_in_at', 'a.last_out_at', 'a.worked_minutes', 'a.late_minutes', 'a.early_leave_minutes', 'a.overtime_minutes', 'a.approved_overtime_minutes', 'a.leave_type_code']).orderBy('a.attendance_date').orderBy('e.employee_no').limit(50000).execute()));
  r.get('/attendance/monthly', { preHandler: requirePermission('reports:attendance'), schema: { tags: ['reports'], summary: 'Monthly attendance per employee', querystring: attQ } }, async (req, reply) => send(reply, req.query.format, 'attendance-monthly', await attFilter(attendanceBase(req.query.from, req.query.to), req.query).select(['e.employee_no', 'e.full_name_en', 'd.name as department', 's.name as site', (eb) => eb.fn.count<number>('a.id').filterWhere('a.status', 'in', ['PRESENT', 'HALF_DAY']).as('present_days'), (eb) => eb.fn.count<number>('a.id').filterWhere('a.status', '=', 'ABSENT').as('absent_days'), (eb) => eb.fn.count<number>('a.id').filterWhere('a.status', '=', 'ON_LEAVE').as('leave_days'), (eb) => eb.fn.count<number>('a.id').filterWhere('a.status', '=', 'MISSING_PUNCH').as('missing_punch_days'), (eb) => eb.fn.sum<number>('a.worked_minutes').as('worked_minutes'), (eb) => eb.fn.sum<number>('a.late_minutes').as('late_minutes'), (eb) => eb.fn.sum<number>('a.approved_overtime_minutes').as('approved_ot_minutes')]).groupBy(['e.employee_no', 'e.full_name_en', 'd.name', 's.name']).orderBy('e.employee_no').execute()));
  r.get('/attendance/late', { preHandler: requirePermission('reports:attendance'), schema: { tags: ['reports'], summary: 'Late arrivals', querystring: attQ } }, async (req, reply) => send(reply, req.query.format, 'attendance-late', await attFilter(attendanceBase(req.query.from, req.query.to), req.query).where('a.late_minutes', '>', 0).select(['a.attendance_date', 'e.employee_no', 'e.full_name_en', 's.name as site', 'a.scheduled_start_at', 'a.first_in_at', 'a.late_minutes']).orderBy('a.late_minutes', 'desc').limit(50000).execute()));
  r.get('/attendance/absence', { preHandler: requirePermission('reports:attendance'), schema: { tags: ['reports'], summary: 'Absence', querystring: attQ } }, async (req, reply) => send(reply, req.query.format, 'attendance-absence', await attFilter(attendanceBase(req.query.from, req.query.to), req.query).where('a.status', '=', 'ABSENT').select(['a.attendance_date', 'e.employee_no', 'e.full_name_en', 'd.name as department', 's.name as site']).orderBy('a.attendance_date').limit(50000).execute()));
  r.get('/attendance/overtime', { preHandler: requirePermission('reports:attendance'), schema: { tags: ['reports'], summary: 'Overtime (computed vs approved)', querystring: attQ } }, async (req, reply) => send(reply, req.query.format, 'attendance-overtime', await attFilter(attendanceBase(req.query.from, req.query.to), req.query).where('a.overtime_minutes', '>', 0).select(['a.attendance_date', 'e.employee_no', 'e.full_name_en', 'p.code as project', 's.name as site', 'a.status as day_status', 'a.overtime_minutes', 'a.approved_overtime_minutes']).orderBy('a.attendance_date').limit(50000).execute()));
  r.get('/attendance/missing-punch', { preHandler: requirePermission('reports:attendance'), schema: { tags: ['reports'], summary: 'Missing punches', querystring: attQ } }, async (req, reply) => send(reply, req.query.format, 'attendance-missing-punch', await attFilter(attendanceBase(req.query.from, req.query.to), req.query).where('a.status', '=', 'MISSING_PUNCH').select(['a.attendance_date', 'e.employee_no', 'e.full_name_en', 's.name as site', 'a.first_in_at', 'a.last_out_at', 'a.punch_count']).orderBy('a.attendance_date').limit(50000).execute()));
  r.get('/attendance/site', { preHandler: requirePermission('reports:attendance'), schema: { tags: ['reports'], summary: 'Site attendance summary per day', querystring: attQ } }, async (req, reply) => send(reply, req.query.format, 'attendance-site', await attFilter(attendanceBase(req.query.from, req.query.to), req.query).select(['a.attendance_date', 's.name as site', (eb) => eb.fn.count<number>('a.id').filterWhere('a.status', 'in', ['PRESENT', 'HALF_DAY']).as('present'), (eb) => eb.fn.count<number>('a.id').filterWhere('a.status', '=', 'ABSENT').as('absent'), (eb) => eb.fn.count<number>('a.id').filterWhere('a.status', '=', 'ON_LEAVE').as('on_leave'), (eb) => eb.fn.count<number>('a.id').filterWhere('a.late_minutes', '>', 0).as('late'), (eb) => eb.fn.sum<number>('a.approved_overtime_minutes').as('approved_ot_minutes')]).groupBy(['a.attendance_date', 's.name']).orderBy('a.attendance_date').orderBy('s.name').execute()));

  const runQ = z.object({ runId: z.string().uuid(), format: fmt });
  r.get('/payroll/register', { preHandler: requirePermission('reports:payroll'), schema: { tags: ['reports'], summary: 'Payroll register', querystring: runQ } }, async (req, reply) => send(reply, req.query.format, 'payroll-register', await app.db.selectFrom('payroll_employees as pe').leftJoin('departments as d', 'd.id', 'pe.department_id').leftJoin('sites as s', 's.id', 'pe.site_id').leftJoin('projects as p', 'p.id', 'pe.project_id').select(['pe.employee_no', 'pe.employee_name', 'd.name as department', 's.name as site', 'p.code as project', 'pe.basic_salary', 'pe.gross_salary', 'pe.paid_days', 'pe.absent_days', 'pe.unpaid_leave_days', 'pe.overtime_minutes', 'pe.total_earnings', 'pe.total_deductions', 'pe.net_salary', 'pe.has_exceptions']).where('pe.payroll_run_id', '=', req.query.runId).orderBy('pe.employee_no').execute()));
  r.get('/payroll/components', { preHandler: requirePermission('reports:payroll'), schema: { tags: ['reports'], summary: 'Totals by component', querystring: runQ } }, async (req, reply) => {
    const rows = await sql<Record<string, unknown>>`SELECT 'EARNING' AS kind, component_code, count(*)::int AS employees, sum(amount) AS total FROM payroll_earnings e JOIN payroll_employees pe ON pe.id = e.payroll_employee_id WHERE pe.payroll_run_id = ${req.query.runId} GROUP BY component_code
      UNION ALL SELECT 'DEDUCTION', component_code, count(*)::int, sum(amount) FROM payroll_deductions d JOIN payroll_employees pe ON pe.id = d.payroll_employee_id WHERE pe.payroll_run_id = ${req.query.runId} GROUP BY component_code ORDER BY 1, 4 DESC`.execute(app.db);
    return send(reply, req.query.format, 'payroll-components', rows.rows);
  });
  r.get('/payroll/cost', { preHandler: requirePermission('reports:cost'), schema: { tags: ['reports'], summary: 'Labour cost by project / department / cost center / site / employee', querystring: runQ.extend({ groupBy: z.enum(['project', 'department', 'cost_center', 'site', 'employee']).default('project') }) } }, async (req, reply) => {
    const col = { project: sql`coalesce(p.code || ' ' || p.name, 'Unassigned')`, department: sql`coalesce(d.name, 'Unassigned')`, cost_center: sql`coalesce(cc.code, 'Unassigned')`, site: sql`coalesce(s.name, 'Unassigned')`, employee: sql`pe.employee_no || ' ' || pe.employee_name` }[req.query.groupBy];
    const rows = await sql<Record<string, unknown>>`SELECT ${col} AS "group", count(*)::int AS employees,
        sum((SELECT coalesce(sum(amount),0) FROM payroll_earnings e WHERE e.payroll_employee_id = pe.id AND e.component_code NOT LIKE 'OT%')) AS normal_labour_cost,
        sum((SELECT coalesce(sum(amount),0) FROM payroll_earnings e WHERE e.payroll_employee_id = pe.id AND e.component_code LIKE 'OT%')) AS ot_cost,
        sum(pe.total_deductions) AS deductions, sum(pe.net_salary) AS net_cost, sum(pe.total_earnings) AS total_labour_cost
      FROM payroll_employees pe LEFT JOIN projects p ON p.id = pe.project_id LEFT JOIN departments d ON d.id = pe.department_id LEFT JOIN cost_centers cc ON cc.id = pe.cost_center_id LEFT JOIN sites s ON s.id = pe.site_id
      WHERE pe.payroll_run_id = ${req.query.runId} GROUP BY 1 ORDER BY total_labour_cost DESC`.execute(app.db);
    return send(reply, req.query.format, 'labour-cost', rows.rows);
  });
  r.get('/payroll/variance', { preHandler: requirePermission('reports:payroll'), schema: { tags: ['reports'], summary: 'Per-employee variance vs the previous run', querystring: runQ } }, async (req, reply) => {
    const run = await app.db.selectFrom('payroll_runs').select(['period_year', 'period_month']).where('id', '=', req.query.runId).executeTakeFirst();
    if (!run) throw badRequest('Unknown run');
    const rows = await sql<Record<string, unknown>>`WITH prev AS (SELECT id FROM payroll_runs WHERE (period_year, period_month) < (${run.period_year}, ${run.period_month}) ORDER BY period_year DESC, period_month DESC LIMIT 1)
      SELECT cur.employee_no, cur.employee_name, cur.net_salary AS current_net, pr.net_salary AS previous_net, (cur.net_salary - coalesce(pr.net_salary,0)) AS variance,
        CASE WHEN pr.net_salary IS NULL OR pr.net_salary = 0 THEN NULL ELSE round((cur.net_salary - pr.net_salary) / pr.net_salary * 100, 1) END AS variance_pct
      FROM payroll_employees cur LEFT JOIN payroll_employees pr ON pr.employee_id = cur.employee_id AND pr.payroll_run_id = (SELECT id FROM prev)
      WHERE cur.payroll_run_id = ${req.query.runId} ORDER BY abs(cur.net_salary - coalesce(pr.net_salary,0)) DESC`.execute(app.db);
    return send(reply, req.query.format, 'payroll-variance', rows.rows);
  });
};
