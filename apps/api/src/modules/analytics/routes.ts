import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { requireAuth, requirePermission, hasPermission } from '../../plugins/rbac.js';

/**
 * HR analytics, the HR control center ("needs attention"), the HR calendar and workforce cost.
 * Everything is computed from operational tables — no fabricated figures. Cost = latest gross salary per employee.
 */
const WORKING = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED'] as const;
const num = (v: unknown) => Number(v ?? 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── HR control center ──
  const attentionItem = z.object({ key: z.string(), label: z.string(), count: z.number(), level: z.enum(['info', 'warning', 'critical']), link: z.string() });
  r.get('/control-center', { preHandler: requirePermission('analytics:read', 'employees:read'), schema: { tags: ['analytics'], summary: 'HR control center: headcount pulse + NEEDS ATTENTION queue', response: { 200: z.object({ headcount: z.object({ total: z.number(), working: z.number(), probation: z.number(), clearance: z.number(), joinedThisMonth: z.number(), leftThisMonth: z.number() }), attention: z.array(attentionItem), byStatus: z.array(z.object({ status: z.string(), count: z.number() })), byDepartment: z.array(z.object({ department: z.string(), count: z.number() })), byNationality: z.array(z.object({ nationality: z.string(), count: z.number() })) }) } } }, async (req) => {
    const p = requireAuth(req);
    const today = new Date().toISOString().slice(0, 10), monthStart = `${today.slice(0, 7)}-01`;
    const emps = app.db.selectFrom('employees').where('deleted_at', 'is', null);
    const byStatus = await emps.select(['status', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('status').execute();
    const s = (k: string) => num(byStatus.find((x) => x.status === k)?.n);
    const c = async (q: any) => num((await q.executeTakeFirstOrThrow()).n);
    const cnt = (eb: any) => eb.fn.countAll().as('n');
    const headcount = {
      total: byStatus.reduce((a, x) => a + num(x.n), 0), working: WORKING.reduce((a, k) => a + s(k), 0), probation: s('PROBATION'), clearance: s('CLEARANCE'),
      joinedThisMonth: await c(emps.select(cnt).where('joining_date', '>=', monthStart)), leftThisMonth: await c(emps.select(cnt).where('last_working_date', '>=', monthStart).where('last_working_date', '<=', today)),
    };
    const attention: z.infer<typeof attentionItem>[] = [];
    const push = async (key: string, label: string, level: 'info' | 'warning' | 'critical', link: string, q: any) => { const n = await c(q); if (n > 0) attention.push({ key, label, count: n, level, link }); };
    const docs = app.db.selectFrom('employee_documents as d').innerJoin('employees as e', 'e.id', 'd.employee_id').where('d.deleted_at', 'is', null).where('e.status', 'in', [...WORKING]);
    await push('docs_expired', 'Expired documents', 'critical', '/documents?status=EXPIRED', docs.select(cnt).where('d.expiry_date', '<', today));
    await push('docs_expiring', 'Documents expiring within 60 days', 'warning', '/documents?status=EXPIRING', docs.select(cnt).where('d.expiry_date', '>=', today).where('d.expiry_date', '<=', sql<string>`(CURRENT_DATE + interval '60 days')::date`));
    await push('probation_due', 'Probation ending within 14 days', 'warning', '/people?probation=due', emps.select(cnt).where('probation_status', '=', 'ON_PROBATION').where('probation_end_date', '<=', sql<string>`(CURRENT_DATE + interval '14 days')::date`));
    await push('probation_overdue', 'Probation end date passed without confirmation', 'critical', '/people?probation=overdue', emps.select(cnt).where('probation_status', '=', 'ON_PROBATION').where('probation_end_date', '<', today));
    await push('contracts_expiring', 'Contracts ending within 90 days', 'warning', '/people?contract=expiring', emps.select(cnt).where('status', 'in', [...WORKING]).where('contract_end_date', '<=', sql<string>`(CURRENT_DATE + interval '90 days')::date`));
    await push('missing_iban', 'Working employees without IBAN', 'warning', '/people?missing=iban', emps.select(cnt).where('status', 'in', [...WORKING]).where('bank_iban', 'is', null));
    await push('missing_biometric', 'Working employees without biometric mapping', 'info', '/people?missing=biometric', emps.select(cnt).where('status', 'in', [...WORKING]).where('matrix_user_id', 'is', null));
    await push('no_salary', 'Working employees without a salary structure', 'critical', '/compensation?missing=salary', emps.select(cnt).where('status', 'in', [...WORKING]).where('id', 'not in', (eb) => eb.selectFrom('employee_salary_structures').select('employee_id')));
    await push('pending_requests', 'HR requests awaiting approval', 'info', '/requests?status=PENDING', app.db.selectFrom('hr_requests').select(cnt).where('status', '=', 'PENDING'));
    await push('failed_requests', 'HR requests that failed to apply', 'critical', '/requests?status=FAILED', app.db.selectFrom('hr_requests').select(cnt).where('status', '=', 'FAILED'));
    await push('overdue_tasks', 'Approval tasks overdue', 'warning', '/approvals', app.db.selectFrom('workflow_tasks').select(cnt).where('status', '=', 'PENDING').where('due_at', '<', new Date()));
    await push('clearance_open', 'Clearance checklists open', 'info', '/people?status=CLEARANCE', app.db.selectFrom('checklist_instances as i').innerJoin('checklist_templates as t', 't.id', 'i.template_id').select(cnt).where('t.code', '=', 'CLEARANCE').where('i.status', '=', 'OPEN'));
    await push('onboarding_open', 'Onboarding checklists open', 'info', '/people?onboarding=open', app.db.selectFrom('checklist_instances as i').innerJoin('checklist_templates as t', 't.id', 'i.template_id').select(cnt).where('t.code', '=', 'ONBOARDING').where('i.status', '=', 'OPEN'));
    await push('certs_expiring', 'Training certificates expiring within 60 days', 'warning', '/talent/training?expiring=1', app.db.selectFrom('training_records').select(cnt).where('certificate_expiry', '<=', sql<string>`(CURRENT_DATE + interval '60 days')::date`));
    await push('missing_punch', 'Missing-punch days this month', 'info', '/time/exceptions', app.db.selectFrom('attendance_daily').select(cnt).where('status', '=', 'MISSING_PUNCH').where('attendance_date', '>=', monthStart));
    if (hasPermission(p, 'disciplinary:read')) await push('open_cases', 'Open disciplinary cases', 'warning', '/talent/disciplinary', app.db.selectFrom('disciplinary_cases').select(cnt).where('status', 'in', ['OPEN', 'UNDER_INVESTIGATION']));
    const byDepartment = (await app.db.selectFrom('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id').select([sql<string>`coalesce(d.name, 'Unassigned')`.as('department'), (eb) => eb.fn.countAll<number>().as('n')]).where('e.deleted_at', 'is', null).where('e.status', 'in', [...WORKING]).groupBy('d.name').orderBy('n', 'desc').execute()).map((x) => ({ department: x.department, count: num(x.n) }));
    const byNationality = (await app.db.selectFrom('employees').select([sql<string>`coalesce(nationality, '??')`.as('nationality'), (eb) => eb.fn.countAll<number>().as('n')]).where('deleted_at', 'is', null).where('status', 'in', [...WORKING]).groupBy('nationality').orderBy('n', 'desc').limit(12).execute()).map((x) => ({ nationality: x.nationality, count: num(x.n) }));
    return { headcount, attention, byStatus: byStatus.map((x) => ({ status: x.status, count: num(x.n) })), byDepartment, byNationality };
  });

  // ── HR analytics ──
  r.get('/hr', { preHandler: requirePermission('analytics:read'), schema: { tags: ['analytics'], summary: 'HR analytics: headcount trend, attrition, probation, tenure, grade distribution, requests throughput', querystring: z.object({ months: z.coerce.number().int().min(3).max(36).default(12) }), response: { 200: z.object({ headcountTrend: z.array(z.object({ month: z.string(), joined: z.number(), left: z.number(), headcount: z.number() })), attrition: z.object({ last12mLeavers: z.number(), avgHeadcount: z.number(), ratePct: z.number() }), tenure: z.array(z.object({ band: z.string(), count: z.number() })), grades: z.array(z.object({ grade: z.string(), count: z.number(), avgBasic: z.number().nullable() })), requests: z.array(z.object({ type: z.string(), pending: z.number(), approved: z.number(), rejected: z.number(), applied: z.number(), avgDecisionDays: z.number().nullable() })), training: z.object({ completedThisYear: z.number(), planned: z.number(), certificatesExpiring: z.number() }), performance: z.object({ cycle: z.string().nullable(), reviews: z.number(), finalized: z.number(), avgRating: z.number().nullable() }) }) } } }, async (req) => {
    const p = requireAuth(req);
    const months: string[] = []; const now = new Date();
    for (let i = req.query.months - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
    const joins = await app.db.selectFrom('employees').select([sql<string>`to_char(joining_date, 'YYYY-MM')`.as('m'), (eb) => eb.fn.countAll<number>().as('n')]).where('deleted_at', 'is', null).where('joining_date', 'is not', null).groupBy('m').execute();
    const leaves = await app.db.selectFrom('employees').select([sql<string>`to_char(last_working_date, 'YYYY-MM')`.as('m'), (eb) => eb.fn.countAll<number>().as('n')]).where('deleted_at', 'is', null).where('last_working_date', 'is not', null).groupBy('m').execute();
    const jm = new Map(joins.map((x) => [x.m, num(x.n)])), lm = new Map(leaves.map((x) => [x.m, num(x.n)]));
    const headcountTrend = [] as { month: string; joined: number; left: number; headcount: number }[];
    for (const m of months) {
      const end = `${m}-01`;
      const hc = num((await app.db.selectFrom('employees').select((eb) => eb.fn.countAll<number>().as('n')).where('deleted_at', 'is', null).where('joining_date', '<=', sql<string>`(${end}::date + interval '1 month' - interval '1 day')::date`).where((eb) => eb.or([eb('last_working_date', 'is', null), eb('last_working_date', '>=', end)])).executeTakeFirstOrThrow()).n);
      headcountTrend.push({ month: m, joined: jm.get(m) ?? 0, left: lm.get(m) ?? 0, headcount: hc });
    }
    const last12 = headcountTrend.slice(-12);
    const leavers = last12.reduce((a, x) => a + x.left, 0), avgHc = last12.length ? last12.reduce((a, x) => a + x.headcount, 0) / last12.length : 0;
    const tenureRows = await app.db.selectFrom('employees').select([sql<string>`CASE WHEN joining_date IS NULL THEN 'Unknown' WHEN joining_date > CURRENT_DATE - interval '1 year' THEN '< 1y' WHEN joining_date > CURRENT_DATE - interval '3 years' THEN '1–3y' WHEN joining_date > CURRENT_DATE - interval '5 years' THEN '3–5y' WHEN joining_date > CURRENT_DATE - interval '10 years' THEN '5–10y' ELSE '10y+' END`.as('band'), (eb) => eb.fn.countAll<number>().as('n')]).where('deleted_at', 'is', null).where('status', 'in', [...WORKING]).groupBy('band').execute();
    const order = ['< 1y', '1–3y', '3–5y', '5–10y', '10y+', 'Unknown'];
    const tenure = order.map((b) => ({ band: b, count: num(tenureRows.find((x) => x.band === b)?.n) })).filter((x) => x.count > 0);
    const canSalary = hasPermission(p, 'salary:read');
    const gradeRows = await sql<{ code: string; n: number; avg_basic: number | null }>`
      SELECT g.code, count(e.id)::int AS n, avg(ss.basic_salary) AS avg_basic
      FROM grades g
      LEFT JOIN employees e ON e.grade_id = g.id AND e.deleted_at IS NULL AND e.status IN ('ACTIVE','PROBATION','CONFIRMED','TRANSFERRED','PROMOTED')
      LEFT JOIN LATERAL (SELECT basic_salary FROM employee_salary_structures x WHERE x.employee_id = e.id ORDER BY version DESC LIMIT 1) ss ON true
      WHERE g.is_active GROUP BY g.code, g.sort_order ORDER BY g.sort_order`.execute(app.db);
    const gradesOut = gradeRows.rows.map((g) => ({ grade: g.code, count: num(g.n), avgBasic: canSalary && g.avg_basic !== null ? r2(Number(g.avg_basic)) : null }));
    const reqRows = await app.db.selectFrom('hr_requests').select(['request_type', 'status', (eb) => eb.fn.countAll<number>().as('n'), sql<number | null>`avg(extract(epoch from (decided_at - created_at)) / 86400)`.as('days')]).groupBy(['request_type', 'status']).execute();
    const reqMap = new Map<string, { pending: number; approved: number; rejected: number; applied: number; days: number[] }>();
    for (const x of reqRows) { const a = reqMap.get(x.request_type) ?? { pending: 0, approved: 0, rejected: 0, applied: 0, days: [] }; const k = x.status.toLowerCase() as 'pending' | 'approved' | 'rejected' | 'applied'; if (k in a) (a as any)[k] += num(x.n); if (x.days !== null) a.days.push(Number(x.days)); reqMap.set(x.request_type, a); }
    const requests = [...reqMap.entries()].map(([type, a]) => ({ type, pending: a.pending, approved: a.approved, rejected: a.rejected, applied: a.applied, avgDecisionDays: a.days.length ? r2(a.days.reduce((s, d) => s + d, 0) / a.days.length) : null }));
    const year = now.getFullYear();
    const tr = await app.db.selectFrom('training_records').select((eb) => [eb.fn.count<number>('id').filterWhere('status', '=', 'COMPLETED').filterWhere('completed_at', '>=', `${year}-01-01`).as('done'), eb.fn.count<number>('id').filterWhere('status', 'in', ['PLANNED', 'ASSIGNED', 'IN_PROGRESS']).as('planned'), eb.fn.count<number>('id').filterWhere('certificate_expiry', '<=', sql<string>`(CURRENT_DATE + interval '60 days')::date`).as('exp')]).executeTakeFirstOrThrow();
    const cycle = await app.db.selectFrom('performance_cycles').select(['id', 'name']).where('cycle_year', '=', year).orderBy('created_at', 'desc').executeTakeFirst();
    const pr = cycle ? await app.db.selectFrom('performance_reviews').select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.count<number>('id').filterWhere('status', '=', 'FINAL').as('f'), eb.fn.avg<number>('final_rating').as('avg')]).where('cycle_id', '=', cycle.id).executeTakeFirstOrThrow() : { n: 0, f: 0, avg: null };
    return { headcountTrend, attrition: { last12mLeavers: leavers, avgHeadcount: r2(avgHc), ratePct: avgHc ? r2((leavers / avgHc) * 100) : 0 }, tenure, grades: gradesOut, requests, training: { completedThisYear: num(tr.done), planned: num(tr.planned), certificatesExpiring: num(tr.exp) }, performance: { cycle: cycle?.name ?? null, reviews: num(pr.n), finalized: num(pr.f), avgRating: pr.avg === null ? null : r2(Number(pr.avg)) } };
  });

  // ── Workforce cost ──
  r.get('/workforce-cost', { preHandler: requirePermission('analytics:read', 'salary:read'), schema: { tags: ['analytics'], summary: 'Monthly workforce cost (latest gross salary) grouped by project / site / department / cost center / grade / employee. Restricted: salary:read.', querystring: z.object({ groupBy: z.enum(['project', 'site', 'department', 'cost_center', 'grade', 'employee']).default('project') }), response: { 200: z.object({ groupBy: z.string(), currency: z.string(), total: z.number(), headcount: z.number(), rows: z.array(z.object({ key: z.string().nullable(), label: z.string(), headcount: z.number(), basic: z.number(), gross: z.number(), avgGross: z.number(), sharePct: z.number() })) }) } } }, async (req) => {
    const p = requireAuth(req);
    if (!hasPermission(p, 'salary:read')) throw app.httpErrors.forbidden('salary:read is required for workforce cost');
    const g = req.query.groupBy;
    const col = { project: ['pr.id', 'pr.name'], site: ['s.id', 's.name'], department: ['d.id', 'd.name'], cost_center: ['cc.id', 'cc.code'], grade: ['gr.id', 'gr.code'], employee: ['e.id', "e.employee_no || ' · ' || e.full_name_en"] }[g] as [string, string];
    const rows = await sql<{ key: string | null; label: string | null; n: number; basic: number; gross: number }>`
      SELECT ${sql.raw(col[0])} AS key, ${sql.raw(col[1])} AS label, count(*)::int AS n, coalesce(sum(ss.basic_salary),0) AS basic, coalesce(sum(ss.gross_salary),0) AS gross
      FROM employees e
      LEFT JOIN LATERAL (SELECT basic_salary, gross_salary FROM employee_salary_structures x WHERE x.employee_id = e.id ORDER BY version DESC LIMIT 1) ss ON true
      LEFT JOIN projects pr ON pr.id = e.project_id LEFT JOIN sites s ON s.id = e.site_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN cost_centers cc ON cc.id = e.cost_center_id LEFT JOIN grades gr ON gr.id = e.grade_id
      WHERE e.deleted_at IS NULL AND e.status IN ('ACTIVE','PROBATION','CONFIRMED','TRANSFERRED','PROMOTED')
      GROUP BY 1, 2 ORDER BY gross DESC`.execute(app.db);
    const total = rows.rows.reduce((a, x) => a + Number(x.gross), 0), headcount = rows.rows.reduce((a, x) => a + num(x.n), 0);
    return { groupBy: g, currency: 'AED', total: r2(total), headcount, rows: rows.rows.map((x) => ({ key: x.key, label: x.label ?? 'Unassigned', headcount: num(x.n), basic: r2(Number(x.basic)), gross: r2(Number(x.gross)), avgGross: num(x.n) ? r2(Number(x.gross) / num(x.n)) : 0, sharePct: total ? r2((Number(x.gross) / total) * 100) : 0 })) };
  });

  // ── HR calendar ──
  const evt = z.object({ date: z.string(), endDate: z.string().nullable(), kind: z.string(), title: z.string(), employeeId: z.string().nullable(), employeeName: z.string().nullable(), link: z.string().nullable() });
  r.get('/calendar', { preHandler: requirePermission('employees:read', 'employees:read:team'), schema: { tags: ['analytics'], summary: 'HR calendar: holidays, approved leave, probation ends, contract & document expiries, training, payroll cut-offs', querystring: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), response: { 200: z.array(evt) } } }, async (req) => {
    const p = requireAuth(req);
    const { from, to } = req.query;
    const out: z.infer<typeof evt>[] = [];
    const team = hasPermission(p, 'employees:read') ? null : await (await import('../employees/service.js')).teamEmployeeIds(app.db, p);
    const scopeIds = team ? [...team, p.employeeId ?? ''] : null;
    for (const h of await app.db.selectFrom('holidays').select(['name', 'holiday_date', 'end_date']).where('holiday_date', '<=', to).where((eb) => eb.or([eb('end_date', '>=', from), eb('holiday_date', '>=', from)])).execute()) out.push({ date: String(h.holiday_date), endDate: h.end_date ? String(h.end_date) : null, kind: 'HOLIDAY', title: h.name, employeeId: null, employeeName: null, link: null });
    let lv = app.db.selectFrom('leave_requests as l').innerJoin('employees as e', 'e.id', 'l.employee_id').innerJoin('leave_types as t', 't.id', 'l.leave_type_id').select(['l.start_date', 'l.end_date', 't.name', 'e.id', 'e.full_name_en']).where('l.status', '=', 'APPROVED').where('l.start_date', '<=', to).where('l.end_date', '>=', from);
    if (scopeIds) lv = lv.where('e.id', 'in', scopeIds);
    for (const l of await lv.execute()) out.push({ date: String(l.start_date), endDate: String(l.end_date), kind: 'LEAVE', title: `${l.full_name_en} · ${l.name}`, employeeId: l.id, employeeName: l.full_name_en, link: `/employees/${l.id}?tab=leave` });
    let emps = app.db.selectFrom('employees').select(['id', 'full_name_en', 'probation_end_date', 'contract_end_date', 'joining_date', 'date_of_birth']).where('deleted_at', 'is', null).where('status', 'in', [...WORKING]);
    if (scopeIds) emps = emps.where('id', 'in', scopeIds);
    for (const e of await emps.execute()) {
      if (e.probation_end_date && e.probation_end_date >= from && e.probation_end_date <= to) out.push({ date: e.probation_end_date, endDate: null, kind: 'PROBATION_END', title: `${e.full_name_en} · probation ends`, employeeId: e.id, employeeName: e.full_name_en, link: `/employees/${e.id}` });
      if (e.contract_end_date && e.contract_end_date >= from && e.contract_end_date <= to) out.push({ date: e.contract_end_date, endDate: null, kind: 'CONTRACT_END', title: `${e.full_name_en} · contract ends`, employeeId: e.id, employeeName: e.full_name_en, link: `/employees/${e.id}?tab=employment` });
      if (e.joining_date) { const a = `${from.slice(0, 4)}${e.joining_date.slice(4)}`; if (a >= from && a <= to && a !== e.joining_date) out.push({ date: a, endDate: null, kind: 'ANNIVERSARY', title: `${e.full_name_en} · ${Number(from.slice(0, 4)) - Number(e.joining_date.slice(0, 4))}y anniversary`, employeeId: e.id, employeeName: e.full_name_en, link: `/employees/${e.id}` }); }
    }
    if (hasPermission(p, 'employees:documents:read')) for (const d of await app.db.selectFrom('employee_documents as d').innerJoin('employees as e', 'e.id', 'd.employee_id').select(['d.document_type', 'd.expiry_date', 'e.id', 'e.full_name_en']).where('d.deleted_at', 'is', null).where('d.expiry_date', '>=', from).where('d.expiry_date', '<=', to).where('e.status', 'in', [...WORKING]).execute()) out.push({ date: String(d.expiry_date), endDate: null, kind: 'DOCUMENT_EXPIRY', title: `${d.full_name_en} · ${d.document_type.replace('_', ' ')} expires`, employeeId: d.id, employeeName: d.full_name_en, link: `/employees/${d.id}?tab=documents` });
    for (const t of await app.db.selectFrom('training_records as t').innerJoin('training_catalog as k', 'k.id', 't.training_id').innerJoin('employees as e', 'e.id', 't.employee_id').select(['t.scheduled_date', 'k.title', 'e.id', 'e.full_name_en']).where('t.scheduled_date', '>=', from).where('t.scheduled_date', '<=', to).where('t.status', 'in', ['PLANNED', 'ASSIGNED', 'IN_PROGRESS']).execute()) out.push({ date: String(t.scheduled_date), endDate: null, kind: 'TRAINING', title: `${t.full_name_en} · ${t.title}`, employeeId: t.id, employeeName: t.full_name_en, link: `/employees/${t.id}?tab=training` });
    for (const run of await app.db.selectFrom('payroll_runs').select(['id', 'code', 'status', 'period_end']).where('period_end', '>=', from).where('period_end', '<=', to).execute()) out.push({ date: String(run.period_end), endDate: null, kind: 'PAYROLL', title: `${run.code} · ${run.status}`, employeeId: null, employeeName: null, link: `/payroll/runs/${run.id}` });
    return out.sort((a, b) => a.date.localeCompare(b.date));
  });
};
