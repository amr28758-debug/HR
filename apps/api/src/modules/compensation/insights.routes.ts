import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { round2, salaryStats } from '@burtplace/core';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { forbidden, notFound } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { toCsv } from '../reports/routes.js';
import { compressionFindings, scanAlerts } from './alerts.js';
import { LIVE_STATUSES, loadProfiles, PENDING_STATUSES, type Profile } from './data.js';
import { loadPolicy } from './policy.js';
import { loadCostLines, usageOf } from './service.js';

/** Management dashboard, department analysis, alerts, compression, exportable reports and the compensation audit trail. */
const fmt = z.enum(['json', 'csv']).default('json');
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const COMP_AUDIT = sql`(a.action LIKE 'compensation.%' OR a.action LIKE 'employee.salary.%' OR a.action IN ('hr_request.increment.applied', 'hr_request.salary_change.applied', 'hr_request.promotion.applied', 'hr_request.grade_change.applied') OR (a.action LIKE 'workflow.definition.%' AND a.new_value->>'code' LIKE 'COMP_%'))`;

export const insightRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const T = ['compensation'];
  const defaultYear = async () => (await app.db.selectFrom('compensation_budgets').select((eb) => eb.fn.max('fiscal_year').as('y')).where('deleted_at', 'is', null).where('fiscal_year', '>=', new Date().getFullYear()).executeTakeFirst())?.y ?? new Date().getFullYear();

  // ── Dashboard ──
  r.get('/dashboard', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Management compensation dashboard. Amounts and employee lists need salary:read (counts only otherwise).', querystring: z.object({ year: z.coerce.number().int().optional(), departmentId: z.string().uuid().optional(), siteId: z.string().uuid().optional() }), response: { 200: z.record(z.unknown()) } } }, async (req) => {
    const p = requireAuth(req);
    const money = hasPermission(p, 'salary:read');
    const m = <T>(v: T): T | null => (money ? v : null);
    const year = req.query.year ?? await defaultYear();
    const policy = await loadPolicy(app.db);
    const profiles = await loadProfiles(app.db, policy, { departmentIds: req.query.departmentId ? [req.query.departmentId] : undefined, siteIds: req.query.siteId ? [req.query.siteId] : undefined });
    const paid = profiles.filter((x) => x.currentSalary !== null);
    const st = salaryStats(paid.map((x) => x.currentSalary!));
    const payroll = round2(paid.reduce((s, x) => s + (x.grossSalary ?? 0), 0));
    const lines = await loadCostLines(app.db, year, policy.annualizationMonths);
    const budgets = await app.db.selectFrom('compensation_budgets').selectAll().where('fiscal_year', '=', year).where('scope_type', '=', 'COMPANY').where('status', '=', 'ACTIVE').where('deleted_at', 'is', null).execute();
    const budget = (t: string) => { const b = budgets.find((x) => x.budget_type === t); return b ? { amount: Number(b.amount), ...usageOf(b as any, lines) } : null; };
    const pendingChanges = Number((await app.db.selectFrom('salary_changes').select((eb) => eb.fn.countAll<number>().as('n')).where('status', 'in', [...PENDING_STATUSES]).executeTakeFirstOrThrow()).n);
    const pendingReviews = Number((await app.db.selectFrom('salary_reviews').select((eb) => eb.fn.countAll<number>().as('n')).where('status', 'in', [...PENDING_STATUSES]).where('deleted_at', 'is', null).executeTakeFirstOrThrow()).n);
    const statusCounts = new Map<string, { code: string; label: string; color: string; count: number }>();
    for (const x of profiles) { const s = x.bandStatus; statusCounts.set(s.code, { ...s, count: (statusCounts.get(s.code)?.count ?? 0) + 1 }); }
    const group = (key: (x: Profile) => string | null) => {
      const g = new Map<string, Profile[]>();
      for (const x of paid) { const k = key(x) ?? 'Unassigned'; g.set(k, [...(g.get(k) ?? []), x]); }
      return [...g.entries()].map(([name, xs]) => { const s = salaryStats(xs.map((x) => x.currentSalary!)); const cr = xs.filter((x) => x.compaRatio !== null); return { name, employees: xs.length, total: m(round2(xs.reduce((a, x) => a + (x.grossSalary ?? 0), 0))), average: m(s.average), min: m(s.min), max: m(s.max), avgCompaRatio: cr.length ? round2(cr.reduce((a, x) => a + x.compaRatio!, 0) / cr.length) : null }; }).sort((a, b) => b.employees - a.employees);
    };
    // salary distribution histogram (10 buckets)
    const buckets: { range: string; from: number; to: number; employees: number }[] = [];
    if (paid.length && money) {
      const lo = Math.floor(st.min / 500) * 500, hi = Math.ceil((st.max + 1) / 500) * 500, w = Math.max(500, Math.ceil((hi - lo) / 10 / 500) * 500);
      for (let a = lo; a < hi; a += w) buckets.push({ range: `${Math.round(a / 1000 * 10) / 10}k–${Math.round((a + w) / 1000 * 10) / 10}k`, from: a, to: a + w, employees: paid.filter((x) => x.currentSalary! >= a && x.currentSalary! < a + w).length });
    }
    const growth = money ? (await sql<{ month: string; total: number; employees: number }>`
      SELECT to_char(m, 'YYYY-MM') AS month, coalesce(sum(s.gross_salary), 0)::numeric AS total, count(s.id)::int AS employees
      FROM generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month') m
      LEFT JOIN LATERAL (SELECT DISTINCT ON (x.employee_id) x.id, x.gross_salary FROM employee_salary_structures x JOIN employees e ON e.id = x.employee_id
        WHERE x.effective_from <= (m + interval '1 month' - interval '1 day')::date AND e.deleted_at IS NULL AND (e.joining_date IS NULL OR e.joining_date <= (m + interval '1 month' - interval '1 day')::date) AND (e.last_working_date IS NULL OR e.last_working_date >= m::date)
        ORDER BY x.employee_id, x.version DESC) s ON true
      GROUP BY m ORDER BY m`.execute(app.db)).rows.map((x) => ({ month: x.month, total: Number(x.total), employees: x.employees })) : [];
    const brief = (x: Profile) => ({ employeeId: x.employeeId, employeeNo: x.employeeNo, name: x.name, department: x.department, grade: x.gradeCode, salary: m(x.currentSalary), max: m(x.band?.max ?? null), rangePenetration: x.rangePenetration, compaRatio: x.compaRatio, aboveMaxBy: m(x.aboveMaxBy), status: x.bandStatus });
    const t = policy.statusThresholds;
    const near = profiles.filter((x) => x.bandStatus.color === 'ORANGE' || x.bandStatus.color === 'YELLOW' || x.bandStatus.code === t.atMax.code);
    const above = profiles.filter((x) => x.bandStatus.code === t.aboveMax.code);
    return {
      year, salaryBasis: policy.bandBasis, currency: paid[0]?.currency ?? 'AED', amountsVisible: money,
      cards: { totalEmployees: profiles.length, totalPayroll: m(payroll), annualPayroll: m(round2(payroll * policy.annualizationMonths)), averageSalary: m(st.average), medianSalary: m(st.median), incrementBudget: m(budget('INCREMENT')), promotionBudget: m(budget('PROMOTION')), annualBudget: m(budget('ANNUAL')), approvedIncreaseCost: m(round2(lines.filter((l) => l.approved).reduce((s, l) => s + l.annualCost, 0))), proposedIncreaseCost: m(round2(lines.reduce((s, l) => s + l.annualCost, 0))), pendingApprovals: pendingChanges + pendingReviews },
      alerts: { aboveMax: above.length, nearMax: near.length, belowMin: profiles.filter((x) => x.bandStatus.code === t.belowMin.code).length, noBand: profiles.filter((x) => x.bandStatus.code === t.noBand.code).length, pendingApproval: pendingChanges + pendingReviews, eligibleForReview: profiles.filter((x) => x.dueForReview).length },
      statusCounts: [...statusCounts.values()],
      distribution: buckets,
      byDepartment: group((x) => x.department), bySite: group((x) => x.site), byGrade: group((x) => x.gradeCode).map((g) => { const band = paid.find((x) => x.gradeCode === g.name)?.band; return { ...g, bandMin: m(band?.min ?? null), bandMid: m(band?.mid ?? null), bandMax: m(band?.max ?? null) }; }).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
      nearCeiling: money ? near.sort((a, b) => (b.rangePenetration ?? 0) - (a.rangePenetration ?? 0)).slice(0, 10).map(brief) : [],
      aboveMaximum: money ? above.sort((a, b) => b.aboveMaxBy - a.aboveMaxBy).slice(0, 10).map(brief) : [],
      payrollGrowth: growth,
    };
  });

  // ── Department / site / grade analysis ──
  const groupBy = z.enum(['department', 'site', 'grade', 'designation', 'employmentType', 'gender', 'status']);
  const analysisQ = z.object({ groupBy: groupBy.default('department'), year: z.coerce.number().int().optional(), departmentId: z.string().uuid().optional(), siteId: z.string().uuid().optional(), gradeId: z.string().uuid().optional(), designationId: z.string().uuid().optional(), employmentType: z.string().optional(), gender: z.string().optional(), status: z.string().optional() });
  async function analysis(q: z.infer<typeof analysisQ>) {
    const policy = await loadPolicy(app.db);
    const year = q.year ?? await defaultYear();
    const profiles = (await loadProfiles(app.db, policy, { departmentIds: q.departmentId ? [q.departmentId] : undefined, siteIds: q.siteId ? [q.siteId] : undefined, gradeIds: q.gradeId ? [q.gradeId] : undefined, designationIds: q.designationId ? [q.designationId] : undefined, employmentTypes: q.employmentType ? [q.employmentType] : undefined, genders: q.gender ? [q.gender] : undefined, statuses: q.status ? [q.status] : undefined })).filter((x) => x.currentSalary !== null);
    const costs = await app.db.selectFrom('salary_changes').select(['employee_id', 'change_type', 'annual_cost']).where('effective_year', '=', year).where('change_type', '<>', 'JOINING').where((eb) => eb.or([eb('status', '=', 'COMPLETED'), eb('approved_at', 'is not', null)])).execute();
    const incCost = new Map<string, number>(), promoCost = new Map<string, number>();
    for (const c of costs) { const tgt = c.change_type === 'PROMOTION' || c.change_type === 'GRADE_CHANGE' ? promoCost : incCost; tgt.set(c.employee_id, (tgt.get(c.employee_id) ?? 0) + Number(c.annual_cost)); }
    const key = (x: Profile): string => ({ department: x.department, site: x.site, grade: x.gradeCode, designation: x.designation, employmentType: x.employmentType, gender: x.gender, status: x.status }[q.groupBy] ?? null) ?? 'Unassigned';
    const g = new Map<string, Profile[]>();
    for (const x of profiles) g.set(key(x), [...(g.get(key(x)) ?? []), x]);
    return [...g.entries()].map(([group, xs]) => {
      const s = salaryStats(xs.map((x) => x.currentSalary!)); const cr = xs.filter((x) => x.compaRatio !== null), rp = xs.filter((x) => x.rangePenetration !== null);
      return { group, employees: xs.length, totalPayroll: round2(xs.reduce((a, x) => a + (x.grossSalary ?? 0), 0)), averageSalary: s.average, medianSalary: s.median, minSalary: s.min, maxSalary: s.max,
        averageCompaRatio: cr.length ? round2(cr.reduce((a, x) => a + x.compaRatio!, 0) / cr.length) : null, averageRangePenetration: rp.length ? round2(rp.reduce((a, x) => a + x.rangePenetration!, 0) / rp.length) : null,
        aboveMax: xs.filter((x) => x.aboveMaxBy > 0).length, belowMin: xs.filter((x) => x.belowMinBy > 0).length,
        annualIncreaseCost: round2(xs.reduce((a, x) => a + (incCost.get(x.employeeId) ?? 0), 0)), promotionCost: round2(xs.reduce((a, x) => a + (promoCost.get(x.employeeId) ?? 0), 0)) };
    }).sort((a, b) => b.totalPayroll - a.totalPayroll);
  }
  r.get('/analysis', { preHandler: [requirePermission('compensation:read'), requirePermission('salary:read')], schema: { tags: T, summary: 'Salary analysis grouped by department / site / grade / job title / employment type / gender / status (restricted: salary:read)', querystring: analysisQ, response: { 200: z.array(z.record(z.unknown())) } } }, async (req) => analysis(req.query));

  // ── Alerts ──
  const alertOut = z.object({ id: z.string(), type: z.string(), severity: z.string(), status: z.string(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string() }).nullable(), message: z.string(), details: z.record(z.unknown()), firstDetectedAt: z.string(), lastDetectedAt: z.string(), acknowledgedBy: z.string().nullable(), acknowledgedAt: z.string().nullable() });
  r.get('/alerts', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Compensation alerts (above/near/at maximum, below minimum, missing band/grade/structure, due for review, compression…). Amount details need salary:read.', querystring: paginationQuery.merge(z.object({ type: z.string().optional(), severity: z.string().optional(), status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'LIVE']).default('LIVE'), employeeId: z.string().uuid().optional() })), response: { 200: paginated(alertOut).extend({ counts: z.record(z.number()) }) } } }, async (req) => {
    const q = req.query; const money = hasPermission(requireAuth(req), 'salary:read');
    let b = app.db.selectFrom('salary_alerts as a').leftJoin('employees as e', 'e.id', 'a.employee_id').leftJoin('users as u', 'u.id', 'a.acknowledged_by').selectAll('a').select(['e.employee_no', 'e.full_name_en', 'u.display_name as ack_name']);
    b = q.status === 'LIVE' ? b.where('a.status', '<>', 'RESOLVED') : b.where('a.status', '=', q.status);
    const counts = Object.fromEntries((await b.clearSelect().select(['a.alert_type', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('a.alert_type').execute()).map((x) => [x.alert_type, Number(x.n)]));
    if (q.type) b = b.where('a.alert_type', '=', q.type);
    if (q.severity) b = b.where('a.severity', '=', q.severity);
    if (q.employeeId) b = b.where('a.employee_id', '=', q.employeeId);
    const total = Number((await b.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await b.orderBy(sql`CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END`).orderBy('a.last_detected_at', 'desc').limit(q.pageSize).offset(offset(q)).execute();
    return { counts, meta: pageMeta(q, total), data: rows.map((a) => ({ id: a.id, type: a.alert_type, severity: a.severity, status: a.status, employee: a.employee_id ? { id: a.employee_id, employeeNo: a.employee_no!, name: a.full_name_en! } : null, message: money ? a.message : a.message.replace(/[A-Z]{3} [\d,.]+/g, '•••'), details: money ? (a.details as Record<string, unknown>) : {}, firstDetectedAt: iso(a.first_detected_at)!, lastDetectedAt: iso(a.last_detected_at)!, acknowledgedBy: a.ack_name ?? null, acknowledgedAt: iso(a.acknowledged_at) })) };
  });
  r.post('/alerts/scan', { preHandler: requirePermission('compensation:propose', 'compensation:config'), schema: { tags: T, summary: 'Re-scan every alert condition now (also runs daily)', response: { 200: z.object({ open: z.number(), created: z.number(), resolved: z.number() }) } } }, async (req) => { const res = await scanAlerts(app.db); await app.audit(req, { action: 'compensation.alerts.scan', entityType: 'salary_alerts', newValue: res }); return res; });
  r.post('/alerts/:id/acknowledge', { preHandler: requirePermission('compensation:propose', 'compensation:config'), schema: { tags: T, summary: 'Acknowledge an alert (it stays visible until the condition disappears)', params: idParam, body: z.object({ note: z.string().max(500).optional() }).default({}), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const a = await app.db.selectFrom('salary_alerts').select(['id', 'status']).where('id', '=', req.params.id).executeTakeFirst();
    if (!a) throw notFound('Alert', req.params.id);
    await app.db.updateTable('salary_alerts').set({ status: 'ACKNOWLEDGED', acknowledged_by: requireAuth(req).userId, acknowledged_at: new Date(), resolution_note: req.body.note ?? null }).where('id', '=', a.id).where('status', '=', 'OPEN').execute();
    await app.audit(req, { action: 'compensation.alert.acknowledge', entityType: 'salary_alert', entityId: a.id, reason: req.body.note });
    return { ok: true };
  });
  r.get('/compression', { preHandler: [requirePermission('compensation:read'), requirePermission('salary:read')], schema: { tags: T, summary: 'Potential salary compression between hierarchical levels (live; salaries are never changed automatically)', response: { 200: z.array(z.unknown()) } } }, async () => compressionFindings(app.db, await loadProfiles(app.db, await loadPolicy(app.db))));

  // ── Reports ──
  const REPORTS = [
    ['salary-register', 'Salary register'], ['annual-increments', 'Annual increment report'], ['promotions', 'Promotion report'], ['salary-bands', 'Salary band report'], ['above-maximum', 'Employees above maximum'], ['below-minimum', 'Employees below minimum'],
    ['salary-ceiling', 'Salary ceiling report'], ['budgets', 'Compensation budget report'], ['department-analysis', 'Department salary analysis'], ['salary-history', 'Salary history'], ['pending-approvals', 'Pending approvals'], ['change-audit', 'Compensation change audit report'],
  ] as const;
  const send = (reply: FastifyReply, format: string, name: string, rows: Record<string, unknown>[]) => format === 'csv' ? reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="compensation-${name}.csv"`).send(`﻿${toCsv(rows)}`) : { data: rows, count: rows.length };
  r.get('/reports', { preHandler: requirePermission('reports:compensation'), schema: { tags: T, summary: 'Available compensation reports (JSON or CSV — CSV opens in Excel)', response: { 200: z.array(z.object({ key: z.string(), name: z.string() })) } } }, async () => REPORTS.map(([key, name]) => ({ key, name })));
  const reportQ = z.object({ format: fmt, year: z.coerce.number().int().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), employeeId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), groupBy: groupBy.optional() });
  r.get('/reports/:key', { preHandler: requirePermission('reports:compensation'), schema: { tags: T, summary: 'Run a compensation report. Salary-level reports need salary:read; the audit report needs audit:read or salary:read.', params: z.object({ key: z.enum(REPORTS.map((x) => x[0]) as [string, ...string[]]) }), querystring: reportQ } }, async (req, reply) => {
    const p = requireAuth(req); const q = req.query; const key = req.params.key;
    if (key !== 'change-audit' && key !== 'salary-bands' && key !== 'budgets' && !hasPermission(p, 'salary:read')) throw forbidden('This report contains individual salaries (salary:read required)');
    if (key === 'change-audit' && !hasPermission(p, 'audit:read') && !hasPermission(p, 'salary:read')) throw forbidden();
    const policy = await loadPolicy(app.db);
    const year = q.year ?? await defaultYear();
    const prof = async () => loadProfiles(app.db, policy, { departmentIds: q.departmentId ? [q.departmentId] : undefined });
    const pRow = (x: Profile) => ({ employee_no: x.employeeNo, name: x.name, department: x.department, site: x.site, job_title: x.designation, grade: x.gradeCode, status: x.status, joining_date: x.joiningDate, currency: x.currency, basic: x.basicSalary, gross: x.grossSalary, band_basis: x.salaryBasis, salary: x.currentSalary, band_min: x.band?.min ?? null, band_mid: x.band?.mid ?? null, band_max: x.band?.max ?? null, compa_ratio_pct: x.compaRatio, range_penetration_pct: x.rangePenetration, remaining_to_max: x.remainingToMax, max_possible_increase_pct: x.maxPossibleIncreasePct, band_status: x.bandStatus.label, rating: x.ratingLabel, last_increase: x.lastIncreaseDate, last_promotion: x.lastPromotionDate, last_review: x.lastReviewDate });
    const changes = (types: string[] | null) => {
      let b = app.db.selectFrom('salary_changes as c').innerJoin('employees as e', 'e.id', 'c.employee_id').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('users as rq', 'rq.id', 'c.requested_by').leftJoin('users as ap', 'ap.id', 'c.approved_by').leftJoin('salary_reviews as rv', 'rv.id', 'c.review_id')
        .select(['c.change_no', 'e.employee_no', 'e.full_name_en', 'd.name as department', 'c.change_type', 'c.status', 'c.source', 'c.currency', 'c.old_salary', 'c.increase_amount', 'c.increase_pct', 'c.new_salary', 'c.annual_cost', 'c.effective_date', 'c.reason', 'c.comments', 'c.justification', 'c.exceeds_max_by', 'c.ceiling_action', 'c.is_override', 'c.duplicate_override', 'c.budget_override', 'c.outside_workflow', 'rv.name as review', 'rq.display_name as requested_by', 'ap.display_name as approved_by', 'c.approved_at', 'c.completed_at']);
      if (types) b = b.where('c.change_type', 'in', types);
      return b;
    };
    const cRow = (c: any) => ({ ...c, full_name_en: undefined, name: c.full_name_en, approved_at: iso(c.approved_at), completed_at: iso(c.completed_at) });
    let rows: Record<string, unknown>[] = [];
    switch (key) {
      case 'salary-register': rows = (await prof()).map(pRow); break;
      case 'above-maximum': rows = (await prof()).filter((x) => x.aboveMaxBy > 0).sort((a, b) => b.aboveMaxBy - a.aboveMaxBy).map((x) => ({ ...pRow(x), above_max_by: x.aboveMaxBy })); break;
      case 'below-minimum': rows = (await prof()).filter((x) => x.belowMinBy > 0).sort((a, b) => b.belowMinBy - a.belowMinBy).map((x) => ({ ...pRow(x), below_min_by: x.belowMinBy })); break;
      case 'salary-ceiling': rows = (await prof()).filter((x) => x.band && (x.rangePenetration ?? 0) >= (policy.statusThresholds.ranges[1]?.fromPct ?? 80)).sort((a, b) => (b.rangePenetration ?? 0) - (a.rangePenetration ?? 0)).map(pRow); break;
      case 'annual-increments': rows = (await changes(['ANNUAL_INCREMENT', 'MERIT_INCREASE']).where('c.effective_year', '=', year).orderBy('e.employee_no').execute()).map(cRow); break;
      case 'salary-history': { let b = changes(null); if (q.employeeId) b = b.where('c.employee_id', '=', q.employeeId); else b = b.where('c.effective_year', '=', year); rows = (await b.orderBy('e.employee_no').orderBy('c.effective_date').execute()).map(cRow); break; }
      case 'promotions': rows = (await app.db.selectFrom('promotion_requests as x').innerJoin('employees as e', 'e.id', 'x.employee_id').leftJoin('designations as ct', 'ct.id', 'x.current_designation_id').leftJoin('grades as cg', 'cg.id', 'x.current_grade_id').leftJoin('designations as nt', 'nt.id', 'x.new_designation_id').innerJoin('grades as ng', 'ng.id', 'x.new_grade_id')
        .select(['x.promotion_no', 'e.employee_no', 'e.full_name_en as name', 'ct.title as current_title', 'cg.code as current_grade', 'x.current_salary', 'nt.title as new_title', 'ng.code as new_grade', 'x.recommended_salary', 'x.new_salary', 'x.effective_date', 'x.promotion_reason', 'x.performance_rating_code as rating', 'x.status', 'x.rule_explanation'])
        .where('x.effective_date', '>=', `${year}-01-01`).where('x.effective_date', '<=', `${year}-12-31`).orderBy('x.effective_date').execute()) as any[]; break;
      case 'salary-bands': rows = (await sql<any>`SELECT g.code AS grade, g.name, b.min_salary, b.mid_salary, b.max_salary, b.currency, b.effective_from, b.effective_to, b.status,
          (SELECT count(*) FROM employees e WHERE e.grade_id = g.id AND e.deleted_at IS NULL AND e.status IN ('ACTIVE','PROBATION','CONFIRMED','TRANSFERRED','PROMOTED'))::int AS employees
        FROM grades g LEFT JOIN salary_bands b ON b.grade_id = g.id AND b.deleted_at IS NULL WHERE g.deleted_at IS NULL ORDER BY g.sort_order, b.effective_from DESC`.execute(app.db)).rows; break;
      case 'budgets': { const lines = await loadCostLines(app.db, year, policy.annualizationMonths); rows = (await app.db.selectFrom('compensation_budgets').selectAll().where('fiscal_year', '=', year).where('deleted_at', 'is', null).execute()).map((b) => { const u = usageOf(b as any, lines); return { name: b.name, fiscal_year: b.fiscal_year, type: b.budget_type, scope: b.scope_type, currency: b.currency, allocated: u.allocated, proposed_cost: u.proposedCost, approved_cost: u.approvedCost, remaining: u.remaining, utilization_pct: u.utilizationPct, status: b.status }; }); break; }
      case 'department-analysis': rows = await analysis({ groupBy: q.groupBy ?? 'department', year, departmentId: q.departmentId }); break;
      case 'pending-approvals': rows = [
        ...(await app.db.selectFrom('salary_changes as c').innerJoin('employees as e', 'e.id', 'c.employee_id').leftJoin('hr_requests as h', 'h.id', 'c.hr_request_id').leftJoin('workflow_tasks as t', (j) => j.onRef('t.instance_id', '=', 'h.workflow_instance_id').on('t.status', '=', 'PENDING'))
          .select(['c.change_no as reference', 'c.change_type as type', 'e.employee_no', 'e.full_name_en as name', 'c.status', 't.step_key as waiting_on', 't.assignee_role_code as role', 'c.increase_amount', 'c.increase_pct', 'c.submitted_at']).where('c.status', 'in', [...PENDING_STATUSES]).execute()).map((x) => ({ ...x, submitted_at: iso(x.submitted_at), days_waiting: x.submitted_at ? Math.floor((Date.now() - new Date(x.submitted_at).getTime()) / 864e5) : null })),
        ...(await app.db.selectFrom('salary_reviews as r').leftJoin('workflow_tasks as t', (j) => j.onRef('t.instance_id', '=', 'r.workflow_instance_id').on('t.status', '=', 'PENDING')).select(['r.name as reference', 'r.status', 't.step_key as waiting_on', 't.assignee_role_code as role', 'r.submitted_at']).where('r.status', 'in', [...PENDING_STATUSES]).execute()).map((x) => ({ ...x, type: 'SALARY_REVIEW', submitted_at: iso(x.submitted_at), days_waiting: x.submitted_at ? Math.floor((Date.now() - new Date(x.submitted_at).getTime()) / 864e5) : null })),
      ]; break;
      case 'change-audit': {
        const from = q.from ?? `${year}-01-01`, to = q.to ?? `${year}-12-31`;
        rows = (await sql<any>`SELECT a.occurred_at, a.actor_label AS user_name, a.action, a.entity_type, a.entity_id, a.old_value, a.new_value, a.reason, host(a.ip_address) AS ip, a.approval_ref FROM audit_logs a WHERE ${COMP_AUDIT} AND a.occurred_at >= ${from}::date AND a.occurred_at < (${to}::date + 1) ORDER BY a.occurred_at DESC LIMIT 20000`.execute(app.db)).rows
          .map((a) => ({ ...a, occurred_at: iso(a.occurred_at), old_value: a.old_value ? JSON.stringify(a.old_value) : null, new_value: a.new_value ? JSON.stringify(a.new_value) : null }));
        break;
      }
    }
    await app.audit(req, { action: 'compensation.report.run', entityType: 'report', entityId: key, newValue: { format: q.format, rows: rows.length } });
    return send(reply, q.format, key, rows);
  });

  // ── Audit trail ──
  r.get('/audit', { preHandler: requirePermission('audit:read', 'reports:compensation'), schema: { tags: T, summary: 'Compensation audit trail: salary / grade / band / budget / workflow changes, approvals and rejections (user, timestamp, action, record, old → new, IP)', querystring: paginationQuery.merge(z.object({ entityType: z.string().optional(), entityId: z.string().optional(), action: z.string().optional() })), response: { 200: paginated(z.object({ id: z.number(), at: z.string(), user: z.string().nullable(), action: z.string(), entityType: z.string(), entityId: z.string().nullable(), oldValue: z.unknown(), newValue: z.unknown(), reason: z.string().nullable(), ip: z.string().nullable() })) } } }, async (req) => {
    const p = requireAuth(req); const q = req.query;
    const conds = [COMP_AUDIT];
    if (q.entityType) conds.push(sql`a.entity_type = ${q.entityType}`);
    if (q.entityId) conds.push(sql`a.entity_id = ${q.entityId}`);
    if (q.action) conds.push(sql`a.action LIKE ${`${q.action}%`}`);
    const where = sql.join(conds, sql` AND `);
    const total = Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_logs a WHERE ${where}`.execute(app.db)).rows[0]!.n);
    const rows = (await sql<any>`SELECT a.id, a.occurred_at, a.actor_label, a.action, a.entity_type, a.entity_id, a.old_value, a.new_value, a.reason, host(a.ip_address) AS ip FROM audit_logs a WHERE ${where} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${q.pageSize} OFFSET ${offset(q)}`.execute(app.db)).rows;
    const money = hasPermission(p, 'salary:read');
    return { data: rows.map((a) => ({ id: Number(a.id), at: iso(a.occurred_at)!, user: a.actor_label, action: a.action, entityType: a.entity_type, entityId: a.entity_id, oldValue: money ? a.old_value : a.old_value ? '•••' : null, newValue: money ? a.new_value : a.new_value ? '•••' : null, reason: a.reason, ip: a.ip })), meta: pageMeta(q, total) };
  });
  void LIVE_STATUSES;
};
