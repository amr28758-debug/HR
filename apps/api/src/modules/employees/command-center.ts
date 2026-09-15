import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { EXAMPLE_SETTLEMENT_POLICY, calculateSettlement, nextStatuses, type SettlementPolicy } from '@burtplace/core';
import { errorSchema, idParam } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission, resolveScope } from '../../plugins/rbac.js';
import { assertCanSeeEmployee, teamEmployeeIds, transitionEmployee } from './service.js';
import { createHrRequest, type HrRequestType } from '../hr-requests/service.js';
import { issueLetter } from '../letters/routes.js';

/**
 * Employee Command Center — one endpoint set that powers the profile header, summary cards, the unified timeline,
 * the compensation tab and the smart "Actions" menu (every sensitive action becomes an HR request).
 */
type Health = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'MISSING' | 'NOT_APPLICABLE';
const healthOf = (expiry: string | null | undefined, warnDays = 60): Health => {
  if (!expiry) return 'MISSING';
  const d = Math.round((new Date(expiry).getTime() - Date.now()) / 864e5);
  return d < 0 ? 'EXPIRED' : d <= warnDays ? 'EXPIRING_SOON' : 'VALID';
};
const daysTo = (d: string | null | undefined) => (d ? Math.round((new Date(d).getTime() - Date.now()) / 864e5) : null);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

const indicatorOut = z.object({ key: z.string(), label: z.string(), status: z.enum(['VALID', 'EXPIRING_SOON', 'EXPIRED', 'MISSING', 'NOT_APPLICABLE']), expiryDate: z.string().nullable(), daysToExpiry: z.number().nullable(), documentId: z.string().nullable() });
const summaryOut = z.object({
  header: z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), nameAr: z.string().nullable(), photoObjectKey: z.string().nullable(), status: z.string(), designation: z.string().nullable(), department: z.string().nullable(), project: z.string().nullable(), site: z.string().nullable(), costCenter: z.string().nullable(), manager: z.object({ id: z.string(), name: z.string() }).nullable(), joiningDate: z.string().nullable(), tenure: z.object({ years: z.number(), months: z.number(), label: z.string() }).nullable(), employmentType: z.string(), nationality: z.string().nullable(), mobile: z.string().nullable(), workEmail: z.string().nullable(), grade: z.string().nullable(), careerLevel: z.string().nullable(), jobFamily: z.string().nullable(), probation: z.object({ status: z.string(), endDate: z.string().nullable(), daysLeft: z.number().nullable() }), contractEndDate: z.string().nullable(), lastWorkingDate: z.string().nullable() }),
  health: z.array(indicatorOut),
  attention: z.array(z.object({ level: z.enum(['info', 'warning', 'critical']), text: z.string(), link: z.string().nullable() })),
  attendance: z.object({ period: z.string(), presentDays: z.number(), absentDays: z.number(), lateCount: z.number(), lateMinutes: z.number(), overtimeMinutes: z.number(), approvedOvertimeMinutes: z.number(), missingPunchDays: z.number(), leaveDays: z.number() }),
  leave: z.array(z.object({ leaveType: z.string(), code: z.string(), balance: z.number(), used: z.number(), pending: z.number() })),
  compensation: z.object({ visible: z.boolean(), currency: z.string().nullable(), basic: z.number().nullable(), gross: z.number().nullable(), version: z.number().nullable(), effectiveFrom: z.string().nullable(), lastChange: z.object({ source: z.string(), reason: z.string().nullable(), effectiveFrom: z.string(), delta: z.number().nullable() }).nullable(), activeLoans: z.number(), outstanding: z.number().nullable(), pendingDeductions: z.number(), pendingBonuses: z.number() }),
  counts: z.object({ documents: z.number(), expiringDocuments: z.number(), openRequests: z.number(), letters: z.number(), trainings: z.number(), expiringCertificates: z.number(), assets: z.number(), openCases: z.number(), notes: z.number() }),
  tabs: z.array(z.string()), actions: z.array(z.object({ key: z.string(), label: z.string(), requestType: z.string().nullable(), enabled: z.boolean(), reason: z.string().nullable() })), allowedTransitions: z.array(z.string()),
});

/** Which tabs a principal may open on a profile (RBAC-filtered). */
function tabsFor(p: ReturnType<typeof requireAuth>, own: boolean, scope: string): string[] {
  const has = (c: string) => hasPermission(p, c);
  const tabs = ['overview', 'personal', 'employment', 'job'];
  if (has('salary:read') || (own && has('salary:read:own'))) tabs.push('compensation');
  if (has('attendance:read') || has('attendance:read:team') || own) tabs.push('attendance');
  if (has('leave:read') || has('leave:read:team') || own) tabs.push('leave');
  if (has('timesheets:read') || has('timesheets:read:team') || own) tabs.push('timesheet');
  if (has('overtime:read') || has('overtime:read:team') || own) tabs.push('overtime');
  if (has('payroll:read') || (own && has('payslips:read:own'))) tabs.push('payroll');
  if (has('employees:documents:read') || own) tabs.push('documents');
  if (has('performance:read') || has('performance:read:team') || own) tabs.push('performance');
  if (has('training:read') || own) tabs.push('training');
  if (has('disciplinary:read')) tabs.push('disciplinary');
  if (has('assets:read') || own) tabs.push('assets');
  if (has('requests:read') || has('requests:read:team') || own) tabs.push('requests');
  if (has('letters:generate') || own) tabs.push('letters');
  if (has('biometric:read') || has('biometric:enroll') || own) tabs.push('biometric');
  tabs.push('history');
  if (has('audit:read')) tabs.push('audit');
  void scope;
  return tabs;
}

export const commandCenterRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const READ = ['employees:read', 'employees:read:team', 'employees:read:own'];

  r.get('/:id/summary', { preHandler: requirePermission(...READ), schema: { tags: ['employees'], summary: 'Employee Command Center summary (header, employment health, attention items, attendance/leave/compensation cards, RBAC-filtered tabs & actions)', params: idParam, response: { 200: summaryOut, 404: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const scope = await assertCanSeeEmployee(app.db, p, 'employees', req.params.id);
    const own = p.employeeId === req.params.id;
    const e = await app.db.selectFrom('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('sites as s', 's.id', 'e.site_id').leftJoin('projects as pr', 'pr.id', 'e.project_id').leftJoin('cost_centers as cc', 'cc.id', 'e.cost_center_id').leftJoin('employees as m', 'm.id', 'e.manager_employee_id').leftJoin('grades as gr', 'gr.id', 'e.grade_id').leftJoin('career_levels as cl', 'cl.id', 'e.career_level_id').leftJoin('job_families as jf', 'jf.id', 'e.job_family_id')
      .selectAll('e').select(['d.name as department', 'g.title as designation', 's.name as site', 'pr.name as project', 'cc.code as cost_center', 'm.id as manager_id', 'm.full_name_en as manager_name', 'gr.code as grade_code', 'cl.name as career_level', 'jf.name as job_family']).where('e.id', '=', req.params.id).where('e.deleted_at', 'is', null).executeTakeFirst();
    if (!e) throw notFound('Employee', req.params.id);
    // Tenure
    let tenure: { years: number; months: number; label: string } | null = null;
    if (e.joining_date) { const j = new Date(e.joining_date), n = new Date(); let months = (n.getFullYear() - j.getFullYear()) * 12 + (n.getMonth() - j.getMonth()); if (n.getDate() < j.getDate()) months--; months = Math.max(0, months); tenure = { years: Math.floor(months / 12), months: months % 12, label: `${Math.floor(months / 12)}y ${months % 12}m` }; }
    // Employment health from documents
    const docs = await app.db.selectFrom('employee_documents').selectAll().where('employee_id', '=', e.id).where('deleted_at', 'is', null).execute();
    const latest = (type: string) => docs.filter((d) => d.document_type === type).sort((a, b) => String(b.expiry_date ?? '').localeCompare(String(a.expiry_date ?? '')))[0];
    const health: z.infer<typeof indicatorOut>[] = [];
    for (const [key, label] of [['PASSPORT', 'Passport'], ['EMIRATES_ID', 'Emirates ID'], ['VISA', 'Residence visa'], ['LABOUR_CARD', 'Labour card'], ['INSURANCE', 'Medical insurance']] as const) {
      const d = latest(key);
      health.push({ key, label, status: d ? healthOf(d.expiry_date) : 'MISSING', expiryDate: d?.expiry_date ?? null, daysToExpiry: daysTo(d?.expiry_date), documentId: d?.id ?? null });
    }
    health.push({ key: 'CONTRACT', label: 'Contract', status: e.contract_end_date ? healthOf(e.contract_end_date, 90) : e.employment_type === 'FULL_TIME' ? 'NOT_APPLICABLE' : 'MISSING', expiryDate: e.contract_end_date, daysToExpiry: daysTo(e.contract_end_date), documentId: latest('CONTRACT')?.id ?? null });
    health.push({ key: 'PROBATION', label: 'Probation', status: e.probation_status === 'ON_PROBATION' ? (e.probation_end_date ? healthOf(e.probation_end_date, 14) : 'MISSING') : 'NOT_APPLICABLE', expiryDate: e.probation_end_date, daysToExpiry: e.probation_status === 'ON_PROBATION' ? daysTo(e.probation_end_date) : null, documentId: null });
    // Attention items
    const attention: { level: 'info' | 'warning' | 'critical'; text: string; link: string | null }[] = [];
    for (const h of health) { if (h.status === 'EXPIRED') attention.push({ level: 'critical', text: `${h.label} expired ${Math.abs(h.daysToExpiry ?? 0)} days ago`, link: `/employees/${e.id}?tab=documents` }); else if (h.status === 'EXPIRING_SOON') attention.push({ level: 'warning', text: `${h.label} expires in ${h.daysToExpiry} days`, link: `/employees/${e.id}?tab=documents` }); else if (h.status === 'MISSING' && ['PASSPORT', 'EMIRATES_ID', 'VISA', 'LABOUR_CARD'].includes(h.key)) attention.push({ level: 'warning', text: `${h.label} not on file`, link: `/employees/${e.id}?tab=documents` }); }
    if (!e.bank_iban && hasPermission(p, 'employees:banking:read')) attention.push({ level: 'warning', text: 'No IBAN on file — payroll will flag MISSING_IBAN', link: `/employees/${e.id}?tab=compensation` });
    if (!e.matrix_user_id) attention.push({ level: 'info', text: 'No biometric (Matrix) mapping — attendance cannot be captured', link: `/employees/${e.id}?tab=attendance` });
    const openReq = await app.db.selectFrom('hr_requests').select(['id', 'request_type', 'request_no']).where('employee_id', '=', e.id).where('status', '=', 'PENDING').execute();
    for (const q of openReq) attention.push({ level: 'info', text: `${q.request_type} request ${q.request_no} awaiting approval`, link: `/requests/${q.id}` });
    // Attendance (current month)
    const now = new Date(); const y = now.getFullYear(), mth = now.getMonth() + 1; const start = `${y}-${String(mth).padStart(2, '0')}-01`;
    const att = await app.db.selectFrom('attendance_daily').select((eb) => [
      eb.fn.count<number>('id').filterWhere('status', 'in', ['PRESENT', 'HALF_DAY']).as('present'), eb.fn.count<number>('id').filterWhere('status', '=', 'ABSENT').as('absent'), eb.fn.count<number>('id').filterWhere('late_minutes', '>', 0).as('late_count'),
      eb.fn.sum<number>('late_minutes').as('late_minutes'), eb.fn.sum<number>('overtime_minutes').as('ot'), eb.fn.sum<number>('approved_overtime_minutes').as('aot'), eb.fn.count<number>('id').filterWhere('status', '=', 'MISSING_PUNCH').as('missing'), eb.fn.count<number>('id').filterWhere('status', '=', 'ON_LEAVE').as('leave'),
    ]).where('employee_id', '=', e.id).where('attendance_date', '>=', start).executeTakeFirstOrThrow();
    // Leave balances
    const leave = await app.db.selectFrom('leave_balances as b').innerJoin('leave_types as t', 't.id', 'b.leave_type_id').select(['t.name', 't.code', 'b.balance_days', 'b.used_days', 'b.pending_days']).where('b.employee_id', '=', e.id).where('b.period_year', '=', y).orderBy('t.name').execute();
    // Compensation (restricted)
    const canSalary = hasPermission(p, 'salary:read') || (own && hasPermission(p, 'salary:read:own'));
    const ss = canSalary ? await app.db.selectFrom('employee_salary_structures').selectAll().where('employee_id', '=', e.id).orderBy('version', 'desc').limit(2).execute() : [];
    const cur = ss[0], prev = ss[1];
    const loans = canSalary ? await app.db.selectFrom('employee_loans').select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.sum<number>('outstanding').as('o')]).where('employee_id', '=', e.id).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow() : { n: 0, o: null };
    const pendDed = canSalary ? Number((await app.db.selectFrom('employee_deductions').select((eb) => eb.fn.countAll<number>().as('n')).where('employee_id', '=', e.id).where('status', 'in', ['PENDING', 'APPROVED']).executeTakeFirstOrThrow()).n) : 0;
    const pendBon = canSalary ? Number((await app.db.selectFrom('employee_bonuses').select((eb) => eb.fn.countAll<number>().as('n')).where('employee_id', '=', e.id).where('status', 'in', ['PENDING', 'APPROVED']).executeTakeFirstOrThrow()).n) : 0;
    // Counts
    const c = async (q: any) => Number((await q.executeTakeFirstOrThrow()).n);
    const cnt = (eb: any) => eb.fn.countAll().as('n');
    const counts = {
      documents: docs.length, expiringDocuments: docs.filter((d) => ['EXPIRED', 'EXPIRING_SOON'].includes(healthOf(d.expiry_date))).length, openRequests: openReq.length,
      letters: await c(app.db.selectFrom('generated_letters').select(cnt).where('employee_id', '=', e.id).where('status', '=', 'ISSUED')),
      trainings: await c(app.db.selectFrom('training_records').select(cnt).where('employee_id', '=', e.id)),
      expiringCertificates: await c(app.db.selectFrom('training_records').select(cnt).where('employee_id', '=', e.id).where('certificate_expiry', 'is not', null).where('certificate_expiry', '<=', sql<string>`(CURRENT_DATE + interval '60 days')::date`)),
      assets: await c(app.db.selectFrom('employee_assets').select(cnt).where('employee_id', '=', e.id).where('returned_at', 'is', null)),
      openCases: hasPermission(p, 'disciplinary:read') ? await c(app.db.selectFrom('disciplinary_cases').select(cnt).where('employee_id', '=', e.id).where('status', 'not in', ['CLOSED', 'WITHDRAWN'])) : 0,
      notes: await c(app.db.selectFrom('employee_notes').select(cnt).where('employee_id', '=', e.id).where((eb) => hasPermission(p, 'notes:confidential') ? eb.lit(true) : eb('is_confidential', '=', false))),
    };
    for (const t of await app.db.selectFrom('training_records as t').innerJoin('training_catalog as k', 'k.id', 't.training_id').select(['k.title', 't.certificate_expiry']).where('t.employee_id', '=', e.id).where('t.certificate_expiry', 'is not', null).where('t.certificate_expiry', '<=', sql<string>`(CURRENT_DATE + interval '60 days')::date`).execute()) attention.push({ level: healthOf(t.certificate_expiry) === 'EXPIRED' ? 'critical' : 'warning', text: `${t.title} certificate ${healthOf(t.certificate_expiry) === 'EXPIRED' ? 'expired' : 'expires soon'}`, link: `/employees/${e.id}?tab=training` });
    // Actions menu (RBAC + lifecycle aware)
    const working = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED'].includes(e.status);
    const act = (key: string, label: string, requestType: string | null, perm: boolean, cond = true, why: string | null = null) => ({ key, label, requestType, enabled: perm && cond, reason: !perm ? 'No permission' : !cond ? why : null });
    const canReq = hasPermission(p, 'requests:create:any');
    const actions = [
      act('edit', 'Edit profile', null, hasPermission(p, 'employees:update')),
      act('promote', 'Promote', 'PROMOTION', canReq && (hasPermission(p, 'compensation:write') || hasPermission(p, 'employees:update')), working, 'Employee is not in a working status'),
      act('transfer', 'Transfer', 'TRANSFER', canReq && hasPermission(p, 'employees:update'), working, 'Employee is not in a working status'),
      act('salary-change', 'Change salary', 'SALARY_CHANGE', canReq && hasPermission(p, 'compensation:write'), working, 'Employee is not in a working status'),
      act('bonus', 'Give bonus', 'BONUS', canReq && hasPermission(p, 'compensation:write'), working, 'Employee is not in a working status'),
      act('deduction', 'Add deduction', 'DEDUCTION', canReq && hasPermission(p, 'compensation:write'), working || e.status === 'CLEARANCE', 'Employee is not on payroll'),
      act('loan', 'Loan', 'LOAN', (canReq && hasPermission(p, 'compensation:write')) || own, working, 'Employee is not in a working status'),
      act('advance', 'Salary advance', 'ADVANCE', (canReq && hasPermission(p, 'compensation:write')) || own, working, 'Employee is not in a working status'),
      act('generate-letter', 'Generate letter', 'LETTER', hasPermission(p, 'letters:generate') || own),
      act('assign-training', 'Assign training', 'TRAINING', (canReq && hasPermission(p, 'training:write')) || own, working, 'Employee is not in a working status'),
      act('disciplinary', 'Disciplinary action', 'DISCIPLINARY', canReq && hasPermission(p, 'disciplinary:write'), working, 'Employee is not in a working status'),
      act('resign', 'Record resignation', 'RESIGNATION', (canReq && hasPermission(p, 'employees:transition')) || own, working, 'Employee is not in a working status'),
      act('terminate', 'Terminate', 'TERMINATION', canReq && hasPermission(p, 'employees:transition'), working, 'Employee is not in a working status'),
      act('start-clearance', 'Start clearance', null, hasPermission(p, 'employees:transition'), ['RESIGNED', 'TERMINATED'].includes(e.status), 'Only after resignation/termination'),
    ];
    return {
      header: { id: e.id, employeeNo: e.employee_no, name: e.full_name_en, nameAr: e.full_name_ar, photoObjectKey: e.photo_object_key, status: e.status, designation: e.designation, department: e.department, project: e.project, site: e.site, costCenter: e.cost_center, manager: e.manager_id ? { id: e.manager_id, name: e.manager_name! } : null, joiningDate: e.joining_date, tenure, employmentType: e.employment_type, nationality: e.nationality, mobile: e.mobile, workEmail: e.work_email, grade: e.grade_code ?? e.grade, careerLevel: e.career_level, jobFamily: e.job_family, probation: { status: e.probation_status, endDate: e.probation_end_date, daysLeft: e.probation_status === 'ON_PROBATION' ? daysTo(e.probation_end_date) : null }, contractEndDate: e.contract_end_date, lastWorkingDate: e.last_working_date },
      health, attention,
      attendance: { period: `${y}-${String(mth).padStart(2, '0')}`, presentDays: Number(att.present), absentDays: Number(att.absent), lateCount: Number(att.late_count), lateMinutes: Number(att.late_minutes ?? 0), overtimeMinutes: Number(att.ot ?? 0), approvedOvertimeMinutes: Number(att.aot ?? 0), missingPunchDays: Number(att.missing), leaveDays: Number(att.leave) },
      leave: leave.map((l) => ({ leaveType: l.name, code: l.code, balance: Number(l.balance_days), used: Number(l.used_days), pending: Number(l.pending_days) })),
      compensation: { visible: canSalary, currency: cur?.currency ?? null, basic: cur ? Number(cur.basic_salary) : null, gross: cur ? Number(cur.gross_salary) : null, version: cur?.version ?? null, effectiveFrom: cur?.effective_from ?? null, lastChange: cur && prev ? { source: cur.source, reason: cur.reason, effectiveFrom: cur.effective_from, delta: Math.round((Number(cur.gross_salary) - Number(prev.gross_salary)) * 100) / 100 } : cur ? { source: cur.source, reason: cur.reason, effectiveFrom: cur.effective_from, delta: null } : null, activeLoans: Number(loans.n), outstanding: loans.o === null ? null : Number(loans.o), pendingDeductions: pendDed, pendingBonuses: pendBon },
      counts, tabs: tabsFor(p, own, scope), actions, allowedTransitions: nextStatuses(e.status),
    };
  });

  // ── Unified timeline (business events; technical audit stays under /audit) ──
  const tlOut = z.object({ id: z.string(), type: z.string(), title: z.string(), description: z.string().nullable(), occurredAt: z.string(), refType: z.string().nullable(), refId: z.string().nullable(), actor: z.string().nullable(), visibility: z.string(), metadata: z.unknown().nullable() });
  r.get('/:id/timeline', { preHandler: requirePermission(...READ), schema: { tags: ['employees'], summary: 'Unified employee timeline (status, org changes, leave, OT, corrections, documents, letters, compensation, training… visibility-filtered)', params: idParam, querystring: z.object({ types: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), response: { 200: z.array(tlOut) } } }, async (req) => {
    const p = requireAuth(req);
    const scope = await assertCanSeeEmployee(app.db, p, 'employees', req.params.id);
    const own = p.employeeId === req.params.id;
    const vis: string[] = ['EMPLOYEE'];
    if (scope === 'team' || scope === 'all') vis.push('MANAGER');
    if (scope === 'all' || hasPermission(p, 'employees:read')) vis.push('HR');
    if (hasPermission(p, 'salary:read') || hasPermission(p, 'disciplinary:read')) vis.push('RESTRICTED');
    if (!own && scope === 'own') throw forbidden();
    const rows = await app.db.selectFrom('employee_timeline_events as t').leftJoin('users as u', 'u.id', 't.actor_user_id').selectAll('t').select('u.display_name').where('t.employee_id', '=', req.params.id).where('t.visibility', 'in', vis).orderBy('t.occurred_at', 'desc').limit(req.query.limit).execute();
    const out = rows.map((t) => ({ id: `tl-${t.id}`, type: t.event_type, title: t.title, description: t.description, occurredAt: new Date(t.occurred_at).toISOString(), refType: t.ref_type, refId: t.ref_id, actor: t.display_name ?? null, visibility: t.visibility, metadata: t.visibility === 'RESTRICTED' && !hasPermission(p, 'salary:read') ? null : t.metadata }));
    // Derived events from operational tables (not duplicated into the append-only table)
    for (const s of await app.db.selectFrom('employee_status_history as h').leftJoin('users as u', 'u.id', 'h.changed_by').select(['h.id', 'h.from_status', 'h.to_status', 'h.effective_date', 'h.reason', 'h.created_at', 'u.display_name']).where('h.employee_id', '=', req.params.id).execute()) out.push({ id: `st-${s.id}`, type: 'STATUS', title: s.from_status ? `${s.from_status} → ${s.to_status}` : `Created as ${s.to_status}`, description: s.reason, occurredAt: new Date(s.created_at).toISOString(), refType: 'employee_status_history', refId: String(s.id), actor: s.display_name ?? null, visibility: 'EMPLOYEE', metadata: null });
    if (vis.includes('MANAGER') || own) {
      for (const l of await app.db.selectFrom('leave_requests as l').innerJoin('leave_types as t', 't.id', 'l.leave_type_id').select(['l.id', 't.name', 'l.start_date', 'l.end_date', 'l.total_days', 'l.status', 'l.created_at']).where('l.employee_id', '=', req.params.id).where('l.status', 'in', ['APPROVED', 'REJECTED', 'CANCELLED']).execute()) out.push({ id: `lv-${l.id}`, type: 'LEAVE', title: `${l.name} ${l.status.toLowerCase()} · ${Number(l.total_days)}d`, description: `${l.start_date} → ${l.end_date}`, occurredAt: new Date(l.created_at).toISOString(), refType: 'leave_request', refId: l.id, actor: null, visibility: 'EMPLOYEE', metadata: null });
      for (const o of await app.db.selectFrom('overtime_requests').select(['id', 'attendance_date', 'approved_minutes', 'requested_minutes', 'status', 'created_at']).where('employee_id', '=', req.params.id).where('status', 'in', ['APPROVED', 'REJECTED']).execute()) out.push({ id: `ot-${o.id}`, type: 'OVERTIME', title: `Overtime ${o.status.toLowerCase()} · ${Math.round((o.approved_minutes ?? o.requested_minutes) / 60 * 10) / 10}h`, description: String(o.attendance_date), occurredAt: new Date(o.created_at).toISOString(), refType: 'overtime_request', refId: o.id, actor: null, visibility: 'EMPLOYEE', metadata: null });
      for (const c of await app.db.selectFrom('attendance_corrections').select(['id', 'attendance_date', 'correction_type', 'status', 'reason', 'created_at']).where('employee_id', '=', req.params.id).where('status', 'in', ['APPROVED', 'REJECTED']).execute()) out.push({ id: `ac-${c.id}`, type: 'ATTENDANCE_CORRECTION', title: `Correction ${c.status.toLowerCase()} · ${c.correction_type}`, description: `${c.attendance_date} · ${c.reason}`, occurredAt: new Date(c.created_at).toISOString(), refType: 'attendance_correction', refId: c.id, actor: null, visibility: 'MANAGER', metadata: null });
    }
    if (vis.includes('HR') || own) for (const d of await app.db.selectFrom('employee_documents').select(['id', 'document_type', 'expiry_date', 'created_at']).where('employee_id', '=', req.params.id).where('deleted_at', 'is', null).execute()) out.push({ id: `doc-${d.id}`, type: 'DOCUMENT', title: `${d.document_type.replace('_', ' ')} added`, description: d.expiry_date ? `Expires ${d.expiry_date}` : null, occurredAt: new Date(d.created_at).toISOString(), refType: 'employee_document', refId: d.id, actor: null, visibility: 'HR', metadata: null });
    if (vis.includes('HR')) for (const h of await app.db.selectFrom('employment_history as h').leftJoin('designations as g', 'g.id', 'h.designation_id').leftJoin('projects as pr', 'pr.id', 'h.project_id').leftJoin('departments as d', 'd.id', 'h.department_id').select(['h.id', 'h.change_type', 'h.effective_from', 'h.reason', 'h.created_at', 'g.title', 'pr.name as project', 'd.name as department', 'h.hr_request_id']).where('h.employee_id', '=', req.params.id).where('h.hr_request_id', 'is', null).where('h.change_type', '!=', 'JOIN').execute()) out.push({ id: `eh-${h.id}`, type: h.change_type, title: `${h.change_type.replace('_', ' ')} · ${h.title ?? ''}${h.project ? ` @ ${h.project}` : h.department ? ` @ ${h.department}` : ''}`.trim(), description: h.reason, occurredAt: new Date(h.created_at).toISOString(), refType: 'employment_history', refId: String(h.id), actor: null, visibility: 'HR', metadata: null });
    const types = req.query.types ? new Set(req.query.types.split(',').map((s) => s.trim().toUpperCase())) : null;
    return out.filter((x) => !types || types.has(x.type)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, req.query.limit);
  });

  // ── Compensation tab: versioned salary with "what changed", deductions, bonuses, loans ──
  const lineOut = z.object({ componentCode: z.string(), componentName: z.string(), kind: z.string(), amount: z.number(), previous: z.number().nullable(), delta: z.number().nullable() });
  r.get('/:id/compensation', { preHandler: requirePermission('salary:read', 'salary:read:own'), schema: { tags: ['employees'], summary: 'Compensation history with what-changed per version, plus deductions, bonuses, loans (restricted)', params: idParam, response: { 200: z.object({ versions: z.array(z.object({ id: z.string(), version: z.number(), effectiveFrom: z.string(), effectiveTo: z.string().nullable(), currency: z.string(), basic: z.number(), gross: z.number(), source: z.string(), reason: z.string().nullable(), hrRequestId: z.string().nullable(), createdAt: z.string(), createdBy: z.string().nullable(), grossDelta: z.number().nullable(), grossDeltaPct: z.number().nullable(), lines: z.array(lineOut) })), grade: z.object({ code: z.string(), min: z.number().nullable(), mid: z.number().nullable(), max: z.number().nullable(), compaRatio: z.number().nullable() }).nullable(), deductions: z.array(z.object({ id: z.string(), componentCode: z.string(), amount: z.number(), reason: z.string(), period: z.string(), source: z.string(), status: z.string() })), bonuses: z.array(z.object({ id: z.string(), bonusType: z.string(), amount: z.number().nullable(), percentage: z.number().nullable(), reason: z.string(), period: z.string(), status: z.string() })), loans: z.array(z.object({ id: z.string(), loanType: z.string(), principal: z.number(), installment: z.number(), outstanding: z.number(), startPeriod: z.string(), status: z.string(), paidInstallments: z.number(), totalInstallments: z.number() })) }) } } }, async (req) => {
    const p = requireAuth(req);
    if (!hasPermission(p, 'salary:read') && p.employeeId !== req.params.id) throw notFound('Employee', req.params.id);
    const vs = await app.db.selectFrom('employee_salary_structures as s').leftJoin('users as u', 'u.id', 's.created_by').selectAll('s').select('u.display_name').where('s.employee_id', '=', req.params.id).orderBy('s.version', 'desc').execute();
    const linesFor = async (id: string) => app.db.selectFrom('employee_salary_lines as l').innerJoin('salary_components as c', 'c.id', 'l.component_id').select(['c.code', 'c.name', 'c.kind', 'l.amount', 'c.sort_order']).where('l.salary_structure_id', '=', id).orderBy('c.sort_order').execute();
    const versions = [] as any[];
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i]!, prev = vs[i + 1];
      const lines = await linesFor(v.id); const prevLines = prev ? await linesFor(prev.id) : [];
      const pm = new Map(prevLines.map((l) => [l.code, Number(l.amount)]));
      const gd = prev ? Math.round((Number(v.gross_salary) - Number(prev.gross_salary)) * 100) / 100 : null;
      versions.push({ id: v.id, version: v.version, effectiveFrom: v.effective_from, effectiveTo: v.effective_to, currency: v.currency, basic: Number(v.basic_salary), gross: Number(v.gross_salary), source: v.source, reason: v.reason, hrRequestId: v.hr_request_id, createdAt: iso(v.created_at)!, createdBy: v.display_name ?? null, grossDelta: gd, grossDeltaPct: gd !== null && Number(prev!.gross_salary) ? Math.round((gd / Number(prev!.gross_salary)) * 10000) / 100 : null,
        lines: lines.map((l) => { const pv = pm.get(l.code) ?? null; return { componentCode: l.code, componentName: l.name, kind: l.kind, amount: Number(l.amount), previous: prev ? pv : null, delta: prev ? Math.round((Number(l.amount) - (pv ?? 0)) * 100) / 100 : null }; }) });
    }
    const e = await app.db.selectFrom('employees as e').leftJoin('grades as g', 'g.id', 'e.grade_id').select(['g.code', 'g.min_salary', 'g.mid_salary', 'g.max_salary']).where('e.id', '=', req.params.id).executeTakeFirst();
    const basic = versions[0]?.basic as number | undefined;
    const grade = e?.code ? { code: e.code, min: e.min_salary === null ? null : Number(e.min_salary), mid: e.mid_salary === null ? null : Number(e.mid_salary), max: e.max_salary === null ? null : Number(e.max_salary), compaRatio: basic && e.mid_salary ? Math.round((basic / Number(e.mid_salary)) * 1000) / 1000 : null } : null;
    const per = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
    const deductions = (await app.db.selectFrom('employee_deductions as d').innerJoin('salary_components as c', 'c.id', 'd.component_id').selectAll('d').select('c.code').where('d.employee_id', '=', req.params.id).orderBy('d.created_at', 'desc').execute()).map((d) => ({ id: d.id, componentCode: d.code, amount: Number(d.amount), reason: d.reason, period: per(d.period_year, d.period_month), source: d.source, status: d.status }));
    const bonuses = (await app.db.selectFrom('employee_bonuses').selectAll().where('employee_id', '=', req.params.id).orderBy('created_at', 'desc').execute()).map((b) => ({ id: b.id, bonusType: b.bonus_type, amount: b.amount === null ? null : Number(b.amount), percentage: b.percentage === null ? null : Number(b.percentage), reason: b.reason, period: per(b.period_year, b.period_month), status: b.status }));
    const loans = await Promise.all((await app.db.selectFrom('employee_loans').selectAll().where('employee_id', '=', req.params.id).orderBy('created_at', 'desc').execute()).map(async (l) => { const ins = await app.db.selectFrom('loan_installments').select(['status']).where('loan_id', '=', l.id).execute(); return { id: l.id, loanType: l.loan_type, principal: Number(l.principal), installment: Number(l.installment), outstanding: Number(l.outstanding), startPeriod: String(l.start_period).slice(0, 7), status: l.status, paidInstallments: ins.filter((i) => i.status === 'DEDUCTED').length, totalInstallments: ins.length }; }));
    return { versions, grade, deductions, bonuses, loans };
  });

  // ── Final settlement preview (end of service) ──
  const settlementLine = z.object({ code: z.string(), label: z.string(), kind: z.string(), amount: z.number(), detail: z.string() });
  r.get('/:id/final-settlement', { preHandler: requirePermission('payroll:read', 'salary:read', 'salary:read:own'), schema: { tags: ['employees'], summary: 'Final settlement statement (DRAFT until the settlement policy is signed off by HR/Legal). Inputs come from salary, leave, loans, deductions, bonuses and the final payroll period.', params: idParam, querystring: z.object({ lastWorkingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), exitType: z.enum(['RESIGNATION', 'TERMINATION', 'END_OF_CONTRACT', 'OTHER']).optional() }), response: { 200: z.object({ status: z.string(), policySignedOff: z.boolean(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), status: z.string(), joiningDate: z.string().nullable(), lastWorkingDate: z.string(), exitType: z.string() }), inputs: z.record(z.unknown()), service: z.record(z.unknown()), dailyRate: z.object({ gratuity: z.number(), encashment: z.number() }), lines: z.array(settlementLine), totalEarnings: z.number(), totalDeductions: z.number(), net: z.number(), warnings: z.array(z.string()), trace: z.record(z.unknown()) }), 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    if (!hasPermission(p, 'payroll:read') && !hasPermission(p, 'salary:read') && p.employeeId !== req.params.id) throw notFound('Employee', req.params.id);
    const e = await app.db.selectFrom('employees').select(['id', 'employee_no', 'full_name_en', 'status', 'joining_date', 'last_working_date', 'resignation_date', 'notice_period_days', 'exit_reason']).where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!e) throw notFound('Employee', req.params.id);
    const lwd = req.query.lastWorkingDate ?? e.last_working_date;
    if (!lwd) throw badRequest('lastWorkingDate is required (no last working date on file yet)');
    if (!e.joining_date) throw badRequest('Employee has no joining date');
    const { activePolicy } = await import('../payroll/service.js');
    const pol = await activePolicy(app.db, lwd);
    const policy = ((pol?.config as any)?.finalSettlement as SettlementPolicy | undefined) ?? EXAMPLE_SETTLEMENT_POLICY;
    const ss = await app.db.selectFrom('employee_salary_structures').select(['basic_salary', 'gross_salary']).where('employee_id', '=', e.id).orderBy('version', 'desc').executeTakeFirst();
    if (!ss) throw badRequest('Employee has no salary structure');
    const unpaid = Number((await app.db.selectFrom('leave_requests as l').innerJoin('leave_types as t', 't.id', 'l.leave_type_id').select((eb) => eb.fn.sum<number>('l.total_days').as('d')).where('l.employee_id', '=', e.id).where('l.status', '=', 'APPROVED').where('t.is_paid', '=', false).executeTakeFirstOrThrow()).d ?? 0);
    const bal = await app.db.selectFrom('leave_balances as b').innerJoin('leave_types as t', 't.id', 'b.leave_type_id').select('b.balance_days').where('b.employee_id', '=', e.id).where('t.code', '=', 'ANNUAL').where('b.period_year', '=', Number(lwd.slice(0, 4))).executeTakeFirst();
    const loans = Number((await app.db.selectFrom('employee_loans').select((eb) => eb.fn.sum<number>('outstanding').as('o')).where('employee_id', '=', e.id).where('status', 'in', ['ACTIVE', 'PAUSED']).executeTakeFirstOrThrow()).o ?? 0);
    const deds = Number((await app.db.selectFrom('employee_deductions').select((eb) => eb.fn.sum<number>('amount').as('a')).where('employee_id', '=', e.id).where('status', '=', 'APPROVED').executeTakeFirstOrThrow()).a ?? 0);
    const bon = Number((await app.db.selectFrom('employee_bonuses').select((eb) => eb.fn.sum<number>('amount').as('a')).where('employee_id', '=', e.id).where('status', '=', 'APPROVED').where('is_recurring', '=', false).executeTakeFirstOrThrow()).a ?? 0);
    const finalRun = await app.db.selectFrom('payroll_employees as pe').innerJoin('payroll_runs as r', 'r.id', 'pe.payroll_run_id').select(['pe.net_salary', 'r.status', 'r.code']).where('pe.employee_id', '=', e.id).where('r.period_year', '=', Number(lwd.slice(0, 4))).where('r.period_month', '=', Number(lwd.slice(5, 7))).executeTakeFirst();
    let noticeShortfall = 0;
    if (e.notice_period_days && e.resignation_date) { const served = Math.round((new Date(lwd).getTime() - new Date(e.resignation_date).getTime()) / 864e5); noticeShortfall = Math.max(0, e.notice_period_days - served); }
    const exitType = req.query.exitType ?? (e.status === 'TERMINATED' ? 'TERMINATION' : 'RESIGNATION');
    const inputs = { basicSalary: Number(ss.basic_salary), grossSalary: Number(ss.gross_salary), unpaidLeaveDays: unpaid, leaveBalanceDays: bal ? Number(bal.balance_days) : 0, outstandingLoans: loans, pendingDeductions: deds, pendingBonuses: bon, noticeShortfallDays: noticeShortfall, finalPeriodNet: finalRun ? Number(finalRun.net_salary) : undefined, finalPeriodRun: finalRun ? `${finalRun.code} (${finalRun.status})` : null, exitType };
    const res = calculateSettlement(policy, { joiningDate: e.joining_date, lastWorkingDate: lwd, ...inputs, exitType: exitType as any });
    await app.audit(req, { action: 'employee.final_settlement.preview', entityType: 'employee', entityId: e.id, newValue: { lastWorkingDate: lwd, net: res.net, status: res.status } });
    return { status: res.status, policySignedOff: policy.signedOff, employee: { id: e.id, employeeNo: e.employee_no, name: e.full_name_en, status: e.status, joiningDate: e.joining_date, lastWorkingDate: lwd, exitType }, inputs, service: res.service as unknown as Record<string, unknown>, dailyRate: res.dailyRate, lines: res.lines, totalEarnings: res.totalEarnings, totalDeductions: res.totalDeductions, net: res.net, warnings: res.warnings, trace: res.trace };
  });

  // ── Business actions → HR requests ──
  const actionOut = z.object({ id: z.string(), requestNo: z.string(), status: z.string(), workflowInstanceId: z.string().nullable() });
  const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const common = { effectiveDate: dateStr.optional(), reason: z.string().max(2000).optional() };
  const action = <B extends z.ZodRawShape>(path: string, type: HrRequestType, summary: string, perms: string[], body: z.ZodObject<B>, extra?: (p: ReturnType<typeof requireAuth>, employeeId: string) => void) => {
    r.post(`/:id/${path}`, { preHandler: requirePermission(...perms), schema: { tags: ['employees'], summary, params: idParam, body: body.extend(common), response: { 201: actionOut, 400: errorSchema, 403: errorSchema, 422: errorSchema } } }, async (req, reply) => {
      const p = requireAuth(req);
      extra?.(p, req.params.id);
      const { effectiveDate, reason, ...payload } = req.body as Record<string, any>;
      const res = await createHrRequest(app, { type, employeeId: req.params.id, payload, effectiveDate, reason, requestedBy: p.userId });
      await app.audit(req, { action: `employee.${path.replace(/-/g, '_')}`, entityType: 'hr_request', entityId: res.id, newValue: { employeeId: req.params.id, requestNo: res.requestNo, effectiveDate }, reason, approvalRef: res.workflowInstanceId });
      return reply.status(201).send(res);
    });
  };
  const ownOrAny = (p: ReturnType<typeof requireAuth>, employeeId: string) => { if (!hasPermission(p, 'requests:create:any') && p.employeeId !== employeeId) throw forbidden('You can only raise this request for yourself'); };
  const salaryLines = z.array(z.object({ componentCode: z.string(), amount: z.number().min(0) })).optional();
  action('promote', 'PROMOTION', 'Promote (designation/grade/level, optional new salary; approval chain PROMOTION; issues promotion letter on approval)', ['requests:create:any'], z.object({ designationId: z.string().uuid().optional(), gradeId: z.string().uuid().optional(), careerLevelId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), managerEmployeeId: z.string().uuid().optional(), jobFamilyId: z.string().uuid().optional(), jobFunctionId: z.string().uuid().optional(), lines: salaryLines, newBasic: z.number().positive().optional(), percentage: z.number().min(0).max(100).optional(), issueLetter: z.boolean().default(true) }), (p) => { if (!hasPermission(p, 'compensation:write') && !hasPermission(p, 'employees:update')) throw forbidden(); });
  action('transfer', 'TRANSFER', 'Transfer (department/project/site/cost center/manager; re-evaluates shift assignment on approval)', ['requests:create:any'], z.object({ departmentId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), siteId: z.string().uuid().optional(), costCenterId: z.string().uuid().optional(), managerEmployeeId: z.string().uuid().optional() }), (p) => { if (!hasPermission(p, 'employees:update')) throw forbidden(); });
  action('salary-change', 'SALARY_CHANGE', 'Salary change (new version on approval; restricted)', ['requests:create:any'], z.object({ lines: salaryLines, newBasic: z.number().positive().optional(), percentage: z.number().min(-100).max(100).optional() }), (p) => { if (!hasPermission(p, 'compensation:write')) throw forbidden(); });
  action('deduction', 'DEDUCTION', 'Deduction (asset damage, penalty…; applied in the period payroll on approval)', ['requests:create:any'], z.object({ componentCode: z.string().default('PENALTY'), amount: z.number().positive(), periodYear: z.number().int(), periodMonth: z.number().int().min(1).max(12), source: z.enum(['MANUAL', 'ASSET_DAMAGE', 'DISCIPLINARY', 'OTHER']).default('MANUAL') }), (p) => { if (!hasPermission(p, 'compensation:write')) throw forbidden(); });
  action('bonus', 'BONUS', 'Bonus (amount or % of basic; one-off or recurring)', ['requests:create:any'], z.object({ bonusType: z.string().default('PERFORMANCE'), componentCode: z.string().default('BONUS'), amount: z.number().positive().optional(), percentage: z.number().positive().max(1000).optional(), periodYear: z.number().int(), periodMonth: z.number().int().min(1).max(12), isRecurring: z.boolean().default(false), recurringMonths: z.number().int().min(1).max(36).optional() }), (p) => { if (!hasPermission(p, 'compensation:write')) throw forbidden(); });
  action('loan', 'LOAN', 'Loan request (instalment schedule generated on approval)', ['requests:create:any', 'requests:create:own'], z.object({ principal: z.number().positive(), installments: z.number().int().min(1).max(60), startPeriod: z.string().regex(/^\d{4}-\d{2}/) }), ownOrAny);
  action('advance', 'ADVANCE', 'Salary advance request', ['requests:create:any', 'requests:create:own'], z.object({ principal: z.number().positive(), installments: z.number().int().min(1).max(12).default(1), startPeriod: z.string().regex(/^\d{4}-\d{2}/) }), ownOrAny);
  action('assign-training', 'TRAINING', 'Assign / request training', ['requests:create:any', 'requests:create:own'], z.object({ courseId: z.string().uuid(), scheduledDate: dateStr.optional(), cost: z.number().min(0).optional() }), ownOrAny);
  action('disciplinary', 'DISCIPLINARY', 'Disciplinary action (confidential; HR Manager + Management approval)', ['requests:create:any'], z.object({ category: z.string(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'), incidentDate: dateStr.optional(), summary: z.string().min(3), details: z.string().optional(), action: z.enum(['VERBAL_WARNING', 'WARNING', 'FINAL_WARNING', 'SUSPENSION', 'PENALTY', 'TERMINATION_RECOMMENDED']), penaltyAmount: z.number().positive().optional(), penaltyPeriod: z.string().optional() }), (p) => { if (!hasPermission(p, 'disciplinary:write')) throw forbidden(); });
  action('resign', 'RESIGNATION', 'Record resignation (manager + HR acceptance; clearance workflow starts on approval)', ['requests:create:any', 'requests:create:own'], z.object({ resignationDate: dateStr.optional(), lastWorkingDate: dateStr, noticePeriodDays: z.number().int().min(0).optional(), exitReason: z.string().optional() }), ownOrAny);
  action('terminate', 'TERMINATION', 'Terminate (HR Manager + Management approval). Legal grounds REQUIRE HR/LEGAL SIGN-OFF per UAE Labour Law.', ['requests:create:any'], z.object({ lastWorkingDate: dateStr, exitReason: z.string().min(3), noticePeriodDays: z.number().int().min(0).optional() }), (p) => { if (!hasPermission(p, 'employees:transition')) throw forbidden(); });

  r.post('/:id/generate-letter', { preHandler: requirePermission('letters:generate', 'requests:create:own'), schema: { tags: ['employees'], summary: 'Generate a letter now (templates that require approval become a LETTER request instead)', params: idParam, body: z.object({ templateCode: z.string(), language: z.enum(['en', 'ar', 'bilingual']).optional(), addressee: z.string().max(200).optional(), purpose: z.string().max(500).optional(), change: z.record(z.unknown()).optional() }), response: { 201: z.object({ mode: z.enum(['ISSUED', 'REQUESTED']), id: z.string(), letterNo: z.string().nullable(), verificationCode: z.string().nullable(), requestNo: z.string().nullable(), status: z.string() }), 400: errorSchema, 403: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    ownOrAny(p, req.params.id);
    const t = await app.db.selectFrom('letter_templates').select(['requires_approval', 'code']).where('code', '=', req.body.templateCode.toUpperCase()).where('is_active', '=', true).executeTakeFirst();
    if (!t) throw badRequest(`Unknown template ${req.body.templateCode}`);
    if (t.requires_approval || !hasPermission(p, 'letters:generate')) {
      const res = await createHrRequest(app, { type: 'LETTER', employeeId: req.params.id, payload: { ...req.body, templateCode: t.code }, reason: req.body.purpose, requestedBy: p.userId });
      await app.audit(req, { action: 'employee.generate_letter.request', entityType: 'hr_request', entityId: res.id, newValue: { employeeId: req.params.id, template: t.code } });
      return reply.status(201).send({ mode: 'REQUESTED' as const, id: res.id, letterNo: null, verificationCode: null, requestNo: res.requestNo, status: res.status });
    }
    const l = await issueLetter(app, { employeeId: req.params.id, templateCode: t.code, language: req.body.language, addressee: req.body.addressee, purpose: req.body.purpose, change: req.body.change, userId: p.userId, hrRequestId: null });
    return reply.status(201).send({ mode: 'ISSUED' as const, id: l.id, letterNo: l.letterNo, verificationCode: l.verificationCode, requestNo: null, status: 'ISSUED' });
  });

  r.post('/:id/start-clearance', { preHandler: requirePermission('employees:transition'), schema: { tags: ['employees'], summary: 'Start clearance (creates the clearance checklist)', params: idParam, body: z.object({ reason: z.string().max(500).optional() }).default({}), response: { 200: z.object({ from: z.string(), to: z.string(), checklistInstanceId: z.string().nullable() }), 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const t = await transitionEmployee(app.db, { employeeId: req.params.id, to: 'CLEARANCE', reason: req.body.reason ?? 'Clearance started', actorUserId: p.userId });
    await app.audit(req, { action: 'employee.start_clearance', entityType: 'employee', entityId: req.params.id, oldValue: { status: t.from }, newValue: { status: t.to }, reason: req.body.reason });
    return { from: t.from, to: t.to, checklistInstanceId: t.checklistInstanceId };
  });

  // ── Bulk operations (preview → confirm; per-employee results) ──
  const bulkBody = z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['TRANSFER', 'BONUS', 'DEDUCTION', 'TRAINING', 'LETTER', 'SALARY_CHANGE']), payload: z.record(z.unknown()).default({}), effectiveDate: dateStr.optional(), reason: z.string().max(2000).optional(), confirm: z.boolean().default(false) });
  const bulkOut = z.object({ mode: z.enum(['PREVIEW', 'APPLIED']), action: z.string(), total: z.number(), eligible: z.number(), skipped: z.number(), results: z.array(z.object({ employeeId: z.string(), employeeNo: z.string(), name: z.string(), status: z.string(), ok: z.boolean(), message: z.string().nullable(), requestId: z.string().nullable(), requestNo: z.string().nullable(), before: z.record(z.unknown()).nullable() })) });
  r.post('/bulk', { preHandler: requirePermission('bulk:run'), schema: { tags: ['employees'], summary: 'Bulk operation: preview (confirm=false) then confirm=true. Creates one HR request per employee (each goes through its workflow).', body: bulkBody, response: { 200: bulkOut } } }, async (req) => {
    const p = requireAuth(req);
    const b = req.body;
    const typeMap: Record<string, HrRequestType> = { TRANSFER: 'TRANSFER', BONUS: 'BONUS', DEDUCTION: 'DEDUCTION', TRAINING: 'TRAINING', LETTER: 'LETTER', SALARY_CHANGE: 'SALARY_CHANGE' };
    if ((b.action === 'BONUS' || b.action === 'DEDUCTION' || b.action === 'SALARY_CHANGE') && !hasPermission(p, 'compensation:write')) throw forbidden(`${b.action} needs compensation:write`);
    if (b.action === 'TRANSFER' && !hasPermission(p, 'employees:update')) throw forbidden('TRANSFER needs employees:update');
    const emps = await app.db.selectFrom('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('projects as pr', 'pr.id', 'e.project_id').leftJoin('sites as s', 's.id', 'e.site_id').leftJoin('designations as g', 'g.id', 'e.designation_id').select(['e.id', 'e.employee_no', 'e.full_name_en', 'e.status', 'd.name as department', 'pr.name as project', 's.name as site', 'g.title as designation']).where('e.id', 'in', b.employeeIds).where('e.deleted_at', 'is', null).execute();
    const byId = new Map(emps.map((e) => [e.id, e]));
    const results: z.infer<typeof bulkOut>['results'] = [];
    for (const id of b.employeeIds) {
      const e = byId.get(id);
      if (!e) { results.push({ employeeId: id, employeeNo: '?', name: '?', status: '?', ok: false, message: 'Employee not found', requestId: null, requestNo: null, before: null }); continue; }
      const working = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED'].includes(e.status);
      const before = { department: e.department, project: e.project, site: e.site, designation: e.designation };
      if (!working && b.action !== 'LETTER') { results.push({ employeeId: id, employeeNo: e.employee_no, name: e.full_name_en, status: e.status, ok: false, message: `Skipped: status ${e.status}`, requestId: null, requestNo: null, before }); continue; }
      if (!b.confirm) { results.push({ employeeId: id, employeeNo: e.employee_no, name: e.full_name_en, status: e.status, ok: true, message: 'Eligible', requestId: null, requestNo: null, before }); continue; }
      try {
        const res = await createHrRequest(app, { type: typeMap[b.action]!, employeeId: id, payload: b.payload as Record<string, any>, effectiveDate: b.effectiveDate, reason: b.reason, requestedBy: p.userId, title: `Bulk ${b.action.toLowerCase()} — ${e.full_name_en}` });
        results.push({ employeeId: id, employeeNo: e.employee_no, name: e.full_name_en, status: e.status, ok: res.status !== 'FAILED', message: res.status, requestId: res.id, requestNo: res.requestNo, before });
      } catch (err) { results.push({ employeeId: id, employeeNo: e.employee_no, name: e.full_name_en, status: e.status, ok: false, message: (err as Error).message, requestId: null, requestNo: null, before }); }
    }
    if (b.confirm) await app.audit(req, { action: `employee.bulk.${b.action.toLowerCase()}`, entityType: 'employee', entityId: null, newValue: { count: b.employeeIds.length, ok: results.filter((x) => x.ok).length, effectiveDate: b.effectiveDate }, reason: b.reason, metadata: { requestIds: results.map((x) => x.requestId).filter(Boolean) } });
    const eligible = results.filter((x) => x.ok).length;
    return { mode: b.confirm ? 'APPLIED' as const : 'PREVIEW' as const, action: b.action, total: b.employeeIds.length, eligible, skipped: results.length - eligible, results };
  });

  // ── Document center: expiry watch-list ──
  r.get('/documents/expiring', { preHandler: requirePermission('employees:documents:read', 'reports:hr'), schema: { tags: ['employees'], summary: 'Documents expiring within N days (or already expired) across working employees', querystring: z.object({ days: z.coerce.number().int().min(0).max(730).default(90), type: z.string().optional() }), response: { 200: z.array(z.object({ id: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), documentType: z.string(), documentNumber: z.string().nullable(), expiryDate: z.string(), daysToExpiry: z.number(), site: z.string().nullable(), project: z.string().nullable(), department: z.string().nullable() })) } } }, async (req) => {
    let q = app.db.selectFrom('employee_documents as d').innerJoin('employees as e', 'e.id', 'd.employee_id').leftJoin('sites as s', 's.id', 'e.site_id').leftJoin('projects as pr', 'pr.id', 'e.project_id').leftJoin('departments as dep', 'dep.id', 'e.department_id')
      .select(['d.id', 'e.id as employee_id', 'e.employee_no', 'e.full_name_en', 'd.document_type', 'd.document_number', 'd.expiry_date', 's.name as site', 'pr.name as project', 'dep.name as department']).where('d.deleted_at', 'is', null).where('d.expiry_date', 'is not', null).where('e.deleted_at', 'is', null).where('e.status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE'])
      .where('d.expiry_date', '<=', sql<string>`(CURRENT_DATE + ${req.query.days} * interval '1 day')::date`);
    if (req.query.type) q = q.where('d.document_type', '=', req.query.type.toUpperCase() as any);
    return (await q.orderBy('d.expiry_date').execute()).map((d) => ({ id: d.id, employeeId: d.employee_id, employeeNo: d.employee_no, employeeName: d.full_name_en, documentType: d.document_type, documentNumber: d.document_number ? `···${d.document_number.slice(-4)}` : null, expiryDate: d.expiry_date!, daysToExpiry: daysTo(d.expiry_date) ?? 0, site: d.site ?? null, project: d.project ?? null, department: d.department ?? null }));
  });

  // ── Org chart ──
  const nodeOut: z.ZodType<any> = z.lazy(() => z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), designation: z.string().nullable(), department: z.string().nullable(), project: z.string().nullable(), photoObjectKey: z.string().nullable(), status: z.string(), directReports: z.number(), totalReports: z.number(), children: z.array(nodeOut) }));
  r.get('/org-chart', { preHandler: requirePermission('employees:read', 'employees:read:team'), schema: { tags: ['employees'], summary: 'Org chart from reporting lines (rootId optional; depth default 4)', querystring: z.object({ rootId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), depth: z.coerce.number().int().min(1).max(8).default(4) }), response: { 200: z.array(nodeOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = app.db.selectFrom('employees as e').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('projects as pr', 'pr.id', 'e.project_id').select(['e.id', 'e.employee_no', 'e.full_name_en', 'e.manager_employee_id', 'e.photo_object_key', 'e.status', 'g.title', 'd.name as department', 'pr.name as project']).where('e.deleted_at', 'is', null).where('e.status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE']);
    if (req.query.departmentId) q = q.where('e.department_id', '=', req.query.departmentId);
    const all = await q.execute();
    const scope = resolveScope(p, 'employees');
    const visible = scope === 'all' ? null : new Set([...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '']);
    const byMgr = new Map<string | null, typeof all>();
    for (const e of all) { const k = e.manager_employee_id; if (!byMgr.has(k)) byMgr.set(k, []); byMgr.get(k)!.push(e); }
    const count = (id: string): number => (byMgr.get(id) ?? []).reduce((s, c) => s + 1 + count(c.id), 0);
    const build = (e: typeof all[number], depth: number): any => ({ id: e.id, employeeNo: e.employee_no, name: e.full_name_en, designation: e.title, department: e.department, project: e.project, photoObjectKey: e.photo_object_key, status: e.status, directReports: (byMgr.get(e.id) ?? []).length, totalReports: count(e.id), children: depth > 1 ? (byMgr.get(e.id) ?? []).filter((c) => !visible || visible.has(c.id)).sort((a, b) => a.employee_no.localeCompare(b.employee_no)).map((c) => build(c, depth - 1)) : [] });
    let roots: typeof all;
    if (req.query.rootId) roots = all.filter((e) => e.id === req.query.rootId);
    else if (scope !== 'all') roots = all.filter((e) => e.id === p.employeeId);
    else roots = all.filter((e) => !e.manager_employee_id || !all.some((m) => m.id === e.manager_employee_id));
    return roots.sort((a, b) => count(b.id) - count(a.id)).map((e) => build(e, req.query.depth));
  });
};
