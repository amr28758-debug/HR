import { sql, type Kysely } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@burtplace/database';
import { badRequest, notFound, unprocessable } from '../../plugins/errors.js';
import { startWorkflow } from '../workflows/service.js';
import { transitionEmployee } from '../employees/service.js';
import { addTimeline } from './timeline.js';

/**
 * HR Requests — the single entry point for every sensitive business action (promotion, transfer, salary change,
 * loan, advance, bonus, deduction, letter, training, disciplinary, resignation, termination…).
 *
 *   createHrRequest → snapshot "before" → start workflow (code = request_type) → on approval applyHrRequest
 *   (side effects: salary versions, employment history, loans + instalments, letters, timeline, audit).
 *
 * If no active workflow definition exists for the type the request is applied immediately (still audited).
 */
export const HR_REQUEST_TYPES = ['PROMOTION', 'TRANSFER', 'SALARY_CHANGE', 'INCREMENT', 'LOAN', 'ADVANCE', 'BONUS', 'DEDUCTION', 'LETTER', 'TRAINING', 'DISCIPLINARY', 'DOCUMENT', 'RESIGNATION', 'TERMINATION', 'OTHER'] as const;
export type HrRequestType = (typeof HR_REQUEST_TYPES)[number];

export interface CreateHrRequestInput {
  type: HrRequestType;
  employeeId: string;
  title?: string;
  payload: Record<string, any>;
  effectiveDate?: string;
  reason?: string;
  requestedBy: string;
  /** Skip the approval workflow (only for actions already approved at a higher level, e.g. an APPROVED increment cycle). */
  bypassWorkflow?: boolean;
}

export async function nextRequestNo(db: Kysely<DB>): Promise<string> {
  const r = await sql<{ n: number }>`SELECT nextval('hr_request_no_seq')::int AS n`.execute(db);
  return `HR-${new Date().getFullYear()}-${String(r.rows[0]!.n).padStart(6, '0')}`;
}

/** Current values that the request may change — stored for "what changed" and for the approver. */
export async function snapshotEmployee(db: Kysely<DB>, employeeId: string): Promise<Record<string, unknown>> {
  const e = await db.selectFrom('employees as e')
    .leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('sites as s', 's.id', 'e.site_id')
    .leftJoin('projects as pr', 'pr.id', 'e.project_id').leftJoin('cost_centers as cc', 'cc.id', 'e.cost_center_id').leftJoin('employees as m', 'm.id', 'e.manager_employee_id')
    .leftJoin('grades as gr', 'gr.id', 'e.grade_id').leftJoin('career_levels as cl', 'cl.id', 'e.career_level_id')
    .select(['e.id', 'e.employee_no', 'e.full_name_en', 'e.status', 'e.department_id', 'd.name as department', 'e.designation_id', 'g.title as designation', 'e.site_id', 's.name as site', 'e.project_id', 'pr.name as project',
      'e.cost_center_id', 'cc.code as cost_center', 'e.manager_employee_id', 'm.full_name_en as manager', 'e.grade_id', 'gr.code as grade', 'e.career_level_id', 'cl.code as career_level', 'e.employment_type', 'e.is_office_staff'])
    .where('e.id', '=', employeeId).where('e.deleted_at', 'is', null).executeTakeFirst();
  if (!e) throw notFound('Employee', employeeId);
  const ss = await db.selectFrom('employee_salary_structures').select(['id', 'version', 'basic_salary', 'gross_salary', 'effective_from']).where('employee_id', '=', employeeId).orderBy('version', 'desc').executeTakeFirst();
  return {
    employeeNo: e.employee_no, name: e.full_name_en, status: e.status, departmentId: e.department_id, department: e.department, designationId: e.designation_id, designation: e.designation,
    siteId: e.site_id, site: e.site, projectId: e.project_id, project: e.project, costCenterId: e.cost_center_id, costCenter: e.cost_center, managerEmployeeId: e.manager_employee_id, manager: e.manager,
    gradeId: e.grade_id, grade: e.grade, careerLevelId: e.career_level_id, careerLevel: e.career_level, employmentType: e.employment_type,
    salary: ss ? { structureId: ss.id, version: ss.version, basic: Number(ss.basic_salary), gross: Number(ss.gross_salary), effectiveFrom: ss.effective_from } : null,
  };
}

/** Workflow definition code per request type (RESIGNATION/TERMINATION keep the employee-level clearance workflow separate). */
export const WORKFLOW_CODE: Partial<Record<HrRequestType, string>> = { RESIGNATION: 'HR_RESIGNATION', TERMINATION: 'HR_TERMINATION' };

const TITLES: Record<HrRequestType, string> = {
  PROMOTION: 'Promotion', TRANSFER: 'Transfer', SALARY_CHANGE: 'Salary change', INCREMENT: 'Increment', LOAN: 'Loan', ADVANCE: 'Salary advance', BONUS: 'Bonus', DEDUCTION: 'Deduction',
  LETTER: 'Letter', TRAINING: 'Training assignment', DISCIPLINARY: 'Disciplinary action', DOCUMENT: 'Document request', RESIGNATION: 'Resignation', TERMINATION: 'Termination', OTHER: 'HR request',
};

/** Validate a payload against the request type (structural checks only — business approval is the workflow's job). */
export async function validatePayload(db: Kysely<DB>, type: HrRequestType, payload: Record<string, any>, employeeId: string): Promise<void> {
  const need = (k: string) => { if (payload[k] === undefined || payload[k] === null || payload[k] === '') throw badRequest(`${type}: '${k}' is required`); };
  const positive = (k: string) => { if (payload[k] !== undefined && !(Number(payload[k]) > 0)) throw badRequest(`${type}: '${k}' must be > 0`); };
  switch (type) {
    case 'PROMOTION': if (!payload.designationId && !payload.gradeId && !payload.careerLevelId) throw badRequest('PROMOTION needs designationId, gradeId or careerLevelId'); break;
    case 'TRANSFER': if (!payload.departmentId && !payload.projectId && !payload.siteId && !payload.managerEmployeeId && !payload.costCenterId) throw badRequest('TRANSFER needs a target department, project, site, cost center or manager'); break;
    case 'SALARY_CHANGE': case 'INCREMENT': if (!Array.isArray(payload.lines) && payload.newBasic === undefined && payload.percentage === undefined) throw badRequest(`${type} needs lines[], newBasic or percentage`); break;
    case 'LOAN': case 'ADVANCE': need('principal'); positive('principal'); need('installments'); if (!(Number(payload.installments) >= 1)) throw badRequest('installments must be >= 1'); need('startPeriod'); break;
    case 'BONUS': if (payload.amount === undefined && payload.percentage === undefined) throw badRequest('BONUS needs amount or percentage'); need('periodYear'); need('periodMonth'); break;
    case 'DEDUCTION': need('amount'); positive('amount'); need('periodYear'); need('periodMonth'); need('componentCode'); break;
    case 'LETTER': need('templateCode'); break;
    case 'TRAINING': need('courseId'); break;
    case 'DISCIPLINARY': need('category'); need('action'); need('summary'); break;
    case 'RESIGNATION': need('lastWorkingDate'); break;
    case 'TERMINATION': need('lastWorkingDate'); need('exitReason'); break;
    default: break;
  }
  if (type === 'LOAN' || type === 'ADVANCE') {
    const open = await db.selectFrom('employee_loans').select('id').where('employee_id', '=', employeeId).where('loan_type', '=', type).where('status', '=', 'ACTIVE').executeTakeFirst();
    if (open) throw unprocessable(`Employee already has an active ${type.toLowerCase()}`);
  }
}

/** Create the request, snapshot, and start its workflow. Auto-applies when no workflow definition is active. */
export async function createHrRequest(app: FastifyInstance, input: CreateHrRequestInput): Promise<{ id: string; requestNo: string; status: string; workflowInstanceId: string | null }> {
  const db = app.db;
  await validatePayload(db, input.type, input.payload, input.employeeId);
  const before = await snapshotEmployee(db, input.employeeId);
  const requestNo = await nextRequestNo(db);
  const row = await db.insertInto('hr_requests').values({
    request_no: requestNo, request_type: input.type, employee_id: input.employeeId, title: input.title ?? `${TITLES[input.type]} — ${before.name as string}`, payload: JSON.stringify(input.payload), before_snapshot: JSON.stringify(before),
    effective_date: input.effectiveDate ?? null, reason: input.reason ?? null, status: 'PENDING', requested_by: input.requestedBy,
  }).returning(['id']).executeTakeFirstOrThrow();
  const context = { employeeId: input.employeeId, requestType: input.type, amount: input.payload.amount ?? input.payload.principal ?? null, percentage: input.payload.percentage ?? null, effectiveDate: input.effectiveDate ?? null, ...(input.payload.contextExtras ?? {}) };
  const wf = input.bypassWorkflow ? null : await startWorkflow(db, { code: WORKFLOW_CODE[input.type] ?? input.type, entityType: 'hr_request', entityId: row.id, initiatedBy: input.requestedBy, context });
  await db.updateTable('hr_requests').set({ workflow_instance_id: wf }).where('id', '=', row.id).execute();
  await addTimeline(db, { employeeId: input.employeeId, type: 'REQUEST', title: `${TITLES[input.type]} requested`, description: `${requestNo}${input.reason ? ` · ${input.reason}` : ''}`, refType: 'hr_request', refId: row.id, actorUserId: input.requestedBy, visibility: ['DISCIPLINARY', 'TERMINATION'].includes(input.type) ? 'RESTRICTED' : 'HR' });
  let status = 'PENDING';
  if (!wf) {
    // No workflow (or its conditions not met) → approved immediately and applied.
    await db.updateTable('hr_requests').set({ status: 'APPROVED', decided_by: input.requestedBy, decided_at: new Date() }).where('id', '=', row.id).execute();
    status = (await applyHrRequest(app, row.id, input.requestedBy)).status;
  } else {
    const inst = await db.selectFrom('workflow_instances').select('status').where('id', '=', wf).executeTakeFirstOrThrow();
    if (inst.status === 'APPROVED') { await db.updateTable('hr_requests').set({ status: 'APPROVED', decided_by: input.requestedBy, decided_at: new Date() }).where('id', '=', row.id).execute(); status = (await applyHrRequest(app, row.id, input.requestedBy)).status; }
  }
  void app.queues.add('notifications.deliver', {}).catch(() => undefined);
  return { id: row.id, requestNo, status, workflowInstanceId: wf };
}

export async function rejectHrRequest(db: Kysely<DB>, id: string, userId: string, comment?: string): Promise<void> {
  const r = await db.selectFrom('hr_requests').select(['employee_id', 'request_type', 'request_no']).where('id', '=', id).executeTakeFirst();
  if (!r) return;
  await db.updateTable('hr_requests').set({ status: 'REJECTED', decided_by: userId, decided_at: new Date() }).where('id', '=', id).execute();
  await addTimeline(db, { employeeId: r.employee_id, type: 'REQUEST', title: `${TITLES[r.request_type as HrRequestType] ?? r.request_type} rejected`, description: `${r.request_no}${comment ? ` · ${comment}` : ''}`, refType: 'hr_request', refId: id, actorUserId: userId });
}

function addMonths(period: string, n: number): { year: number; month: number } {
  const [y, m] = period.slice(0, 7).split('-').map(Number) as [number, number];
  const idx = (m - 1) + n;
  return { year: y + Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Build a new salary version from either explicit lines, a new basic (other lines kept), or a percentage increase on every fixed earning. */
async function createSalaryVersion(db: Kysely<DB>, employeeId: string, opts: { lines?: { componentCode: string; amount: number }[]; newBasic?: number; percentage?: number; effectiveFrom: string; reason: string; source: string; hrRequestId: string; userId: string }): Promise<{ id: string; basic: number; gross: number; prevBasic: number | null; prevGross: number | null; lines: { componentCode: string; amount: number; previous: number | null }[] }> {
  const comps = await db.selectFrom('salary_components').select(['id', 'code', 'kind', 'is_fixed_pay']).where('is_active', '=', true).execute();
  const byCode = new Map(comps.map((c) => [c.code, c]));
  const prev = await db.selectFrom('employee_salary_structures').selectAll().where('employee_id', '=', employeeId).orderBy('version', 'desc').limit(1).forUpdate().executeTakeFirst();
  const prevLines = prev ? await db.selectFrom('employee_salary_lines as l').innerJoin('salary_components as c', 'c.id', 'l.component_id').select(['c.code', 'l.amount']).where('l.salary_structure_id', '=', prev.id).execute() : [];
  const prevMap = new Map(prevLines.map((l) => [l.code, Number(l.amount)]));
  let lines: { componentCode: string; amount: number }[];
  if (opts.lines?.length) lines = opts.lines;
  else if (opts.newBasic !== undefined) { lines = [...prevLines.map((l) => ({ componentCode: l.code, amount: Number(l.amount) })).filter((l) => l.componentCode !== 'BASIC'), { componentCode: 'BASIC', amount: opts.newBasic }]; }
  else if (opts.percentage !== undefined) {
    if (!prev) throw unprocessable('Employee has no salary structure to apply a percentage to');
    lines = prevLines.map((l) => ({ componentCode: l.code, amount: byCode.get(l.code)?.is_fixed_pay && byCode.get(l.code)?.kind === 'EARNING' ? Math.round(Number(l.amount) * (1 + opts.percentage! / 100) * 100) / 100 : Number(l.amount) }));
  } else throw badRequest('Salary change needs lines, newBasic or percentage');
  for (const l of lines) if (!byCode.has(l.componentCode)) throw badRequest(`Unknown salary component ${l.componentCode}`);
  const basic = lines.find((l) => l.componentCode === 'BASIC')?.amount;
  if (basic === undefined) throw badRequest('A BASIC line is required');
  const gross = lines.filter((l) => byCode.get(l.componentCode)!.is_fixed_pay && byCode.get(l.componentCode)!.kind === 'EARNING').reduce((s, l) => s + l.amount, 0);
  if (prev) await db.updateTable('employee_salary_structures').set({ effective_to: sql`(${opts.effectiveFrom}::date - interval '1 day')::date` }).where('id', '=', prev.id).execute();
  const s = await db.insertInto('employee_salary_structures').values({ employee_id: employeeId, version: (prev?.version ?? 0) + 1, effective_from: opts.effectiveFrom, currency: prev?.currency ?? 'AED', basic_salary: basic, gross_salary: gross, reason: opts.reason, source: opts.source, hr_request_id: opts.hrRequestId, created_by: opts.userId }).returning('id').executeTakeFirstOrThrow();
  for (const l of lines) await db.insertInto('employee_salary_lines').values({ salary_structure_id: s.id, component_id: byCode.get(l.componentCode)!.id, amount: l.amount }).execute();
  return { id: s.id, basic, gross, prevBasic: prev ? Number(prev.basic_salary) : null, prevGross: prev ? Number(prev.gross_salary) : null, lines: lines.map((l) => ({ ...l, previous: prevMap.get(l.componentCode) ?? null })) };
}

async function closeAndOpenEmploymentHistory(db: Kysely<DB>, employeeId: string, effective: string, changeType: string, reason: string | null, hrRequestId: string, userId: string) {
  const e = await db.selectFrom('employees').selectAll().where('id', '=', employeeId).executeTakeFirstOrThrow();
  await db.updateTable('employment_history').set({ effective_to: sql`(${effective}::date - interval '1 day')::date` }).where('employee_id', '=', employeeId).where('effective_to', 'is', null).execute();
  await db.insertInto('employment_history').values({ employee_id: employeeId, effective_from: effective, change_type: changeType, department_id: e.department_id, designation_id: e.designation_id, site_id: e.site_id, project_id: e.project_id, cost_center_id: e.cost_center_id, manager_employee_id: e.manager_employee_id, grade: e.grade, grade_id: e.grade_id, career_level_id: e.career_level_id, employment_type: e.employment_type, reason, hr_request_id: hrRequestId, changed_by: userId }).execute();
}

/** Apply an APPROVED request's side effects. Idempotent: an already APPLIED request is returned as-is. */
export async function applyHrRequest(app: FastifyInstance, id: string, actorUserId: string): Promise<{ status: string; result: Record<string, unknown> | null; error?: string }> {
  const db = app.db;
  const r = await db.selectFrom('hr_requests').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw notFound('HR request', id);
  if (r.status === 'APPLIED') return { status: 'APPLIED', result: r.result as Record<string, unknown> | null };
  if (r.status !== 'APPROVED') throw unprocessable(`Request is ${r.status}; only APPROVED requests can be applied`);
  const p = r.payload as Record<string, any>;
  const before = (r.before_snapshot ?? {}) as Record<string, any>;
  const effective = r.effective_date ?? new Date().toISOString().slice(0, 10);
  const type = r.request_type as HrRequestType;
  const emp = r.employee_id;
  const result: Record<string, unknown> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  try {
    await db.transaction().execute(async (trx) => {
      switch (type) {
        case 'PROMOTION': {
          const patch: Record<string, unknown> = { updated_by: actorUserId };
          if (p.designationId) patch.designation_id = p.designationId;
          if (p.gradeId) patch.grade_id = p.gradeId;
          if (p.careerLevelId) patch.career_level_id = p.careerLevelId;
          if (p.departmentId) patch.department_id = p.departmentId;
          if (p.managerEmployeeId) patch.manager_employee_id = p.managerEmployeeId;
          if (p.jobFamilyId) patch.job_family_id = p.jobFamilyId;
          if (p.jobFunctionId) patch.job_function_id = p.jobFunctionId;
          if (p.gradeId) { const g = await trx.selectFrom('grades').select('code').where('id', '=', p.gradeId).executeTakeFirst(); if (g) patch.grade = g.code; }
          await trx.updateTable('employees').set(patch).where('id', '=', emp).execute();
          await closeAndOpenEmploymentHistory(trx, emp, effective, 'PROMOTION', r.reason, id, actorUserId);
          const after = await snapshotEmployee(trx, emp);
          for (const k of ['designation', 'grade', 'careerLevel', 'department', 'manager']) if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
          if (p.lines?.length || p.newBasic !== undefined || p.percentage !== undefined) {
            const s = await createSalaryVersion(trx, emp, { lines: p.lines, newBasic: p.newBasic, percentage: p.percentage, effectiveFrom: effective, reason: `Promotion ${r.request_no}`, source: 'PROMOTION', hrRequestId: id, userId: actorUserId });
            result.salaryStructureId = s.id; changes.basic = { from: s.prevBasic, to: s.basic }; changes.gross = { from: s.prevGross, to: s.gross };
          }
          await addTimeline(trx, { employeeId: emp, type: 'PROMOTION', title: `Promoted to ${after.designation ?? after.grade ?? 'new role'}`, description: Object.entries(changes).map(([k, v]) => `${k}: ${v.from ?? '—'} → ${v.to ?? '—'}`).join(' · '), occurredAt: new Date(effective), refType: 'hr_request', refId: id, actorUserId, visibility: 'EMPLOYEE', metadata: changes });
          break;
        }
        case 'TRANSFER': {
          const patch: Record<string, unknown> = { updated_by: actorUserId };
          for (const [k, col] of [['departmentId', 'department_id'], ['projectId', 'project_id'], ['siteId', 'site_id'], ['costCenterId', 'cost_center_id'], ['managerEmployeeId', 'manager_employee_id']] as const) if (p[k]) patch[col] = p[k];
          await trx.updateTable('employees').set(patch).where('id', '=', emp).execute();
          await closeAndOpenEmploymentHistory(trx, emp, effective, 'TRANSFER', r.reason, id, actorUserId);
          const after = await snapshotEmployee(trx, emp);
          for (const k of ['department', 'project', 'site', 'costCenter', 'manager']) if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
          await addTimeline(trx, { employeeId: emp, type: 'TRANSFER', title: `Transferred${after.project ? ` to ${after.project}` : after.department ? ` to ${after.department}` : ''}`, description: Object.entries(changes).map(([k, v]) => `${k}: ${v.from ?? '—'} → ${v.to ?? '—'}`).join(' · '), occurredAt: new Date(effective), refType: 'hr_request', refId: id, actorUserId, visibility: 'EMPLOYEE', metadata: changes });
          result.reevaluateShiftFrom = effective; // shift re-evaluation is enqueued by the caller (queues live on the app)
          break;
        }
        case 'SALARY_CHANGE': case 'INCREMENT': {
          const s = await createSalaryVersion(trx, emp, { lines: p.lines, newBasic: p.newBasic, percentage: p.percentage, effectiveFrom: effective, reason: r.reason ?? `${TITLES[type]} ${r.request_no}`, source: type, hrRequestId: id, userId: actorUserId });
          result.salaryStructureId = s.id; changes.basic = { from: s.prevBasic, to: s.basic }; changes.gross = { from: s.prevGross, to: s.gross };
          for (const l of s.lines) if (l.previous !== l.amount) changes[`line.${l.componentCode}`] = { from: l.previous, to: l.amount };
          await addTimeline(trx, { employeeId: emp, type: type === 'INCREMENT' ? 'INCREMENT' : 'SALARY', title: `${TITLES[type]} applied`, description: `Gross ${s.prevGross ?? '—'} → ${s.gross}`, occurredAt: new Date(effective), refType: 'hr_request', refId: id, actorUserId, visibility: 'RESTRICTED', metadata: changes });
          break;
        }
        case 'LOAN': case 'ADVANCE': {
          const principal = Number(p.principal), n = Number(p.installments);
          const inst = Math.round((principal / n) * 100) / 100;
          const startPeriod = `${p.startPeriod.slice(0, 7)}-01`;
          const endP = addMonths(startPeriod, n - 1);
          const loan = await trx.insertInto('employee_loans').values({ employee_id: emp, loan_type: type, principal, installment: inst, outstanding: principal, start_period: startPeriod, end_period: `${endP.year}-${String(endP.month).padStart(2, '0')}-01`, status: 'ACTIVE', reason: r.reason ?? p.reason ?? null, hr_request_id: id, approved_by: actorUserId, approved_at: new Date(), created_by: actorUserId }).returning('id').executeTakeFirstOrThrow();
          let remaining = principal;
          for (let i = 0; i < n; i++) { const per = addMonths(startPeriod, i); const amt = i === n - 1 ? Math.round(remaining * 100) / 100 : inst; remaining -= amt; await trx.insertInto('loan_installments').values({ loan_id: loan.id, period_year: per.year, period_month: per.month, amount: amt }).execute(); }
          result.loanId = loan.id; changes[type.toLowerCase()] = { from: null, to: `${principal} over ${n} months` };
          await addTimeline(trx, { employeeId: emp, type, title: `${TITLES[type]} approved`, description: `${principal} AED · ${n} instalments of ${inst}`, refType: 'employee_loan', refId: loan.id, actorUserId, visibility: 'EMPLOYEE' });
          break;
        }
        case 'BONUS': {
          const comp = await trx.selectFrom('salary_components').select('id').where('code', '=', p.componentCode ?? 'BONUS').executeTakeFirstOrThrow();
          const b = await trx.insertInto('employee_bonuses').values({ employee_id: emp, bonus_type: p.bonusType ?? 'PERFORMANCE', component_id: comp.id, amount: p.amount ?? null, percentage: p.percentage ?? null, reason: r.reason ?? p.reason ?? TITLES.BONUS, period_year: Number(p.periodYear), period_month: Number(p.periodMonth), is_recurring: !!p.isRecurring, recurring_months: p.recurringMonths ?? null, status: 'APPROVED', hr_request_id: id, approved_by: actorUserId, approved_at: new Date(), created_by: actorUserId }).returning('id').executeTakeFirstOrThrow();
          result.bonusId = b.id; changes.bonus = { from: null, to: p.amount ?? `${p.percentage}% of basic` };
          await addTimeline(trx, { employeeId: emp, type: 'BONUS', title: `${p.bonusType ?? 'Bonus'} approved`, description: `${p.amount ?? `${p.percentage}% of basic`} · ${p.periodYear}-${String(p.periodMonth).padStart(2, '0')}`, refType: 'employee_bonus', refId: b.id, actorUserId, visibility: 'EMPLOYEE' });
          break;
        }
        case 'DEDUCTION': {
          const comp = await trx.selectFrom('salary_components').select('id').where('code', '=', p.componentCode).executeTakeFirst();
          if (!comp) throw badRequest(`Unknown deduction component ${p.componentCode}`);
          const d = await trx.insertInto('employee_deductions').values({ employee_id: emp, component_id: comp.id, amount: Number(p.amount), reason: r.reason ?? p.reason ?? TITLES.DEDUCTION, deduction_date: effective, period_year: Number(p.periodYear), period_month: Number(p.periodMonth), source: p.source ?? 'MANUAL', status: 'APPROVED', hr_request_id: id, approved_by: actorUserId, approved_at: new Date(), created_by: actorUserId }).returning('id').executeTakeFirstOrThrow();
          result.deductionId = d.id; changes.deduction = { from: null, to: Number(p.amount) };
          await addTimeline(trx, { employeeId: emp, type: 'DEDUCTION', title: `Deduction approved (${p.componentCode})`, description: `${Number(p.amount)} AED · ${p.periodYear}-${String(p.periodMonth).padStart(2, '0')}`, refType: 'employee_deduction', refId: d.id, actorUserId, visibility: 'EMPLOYEE' });
          break;
        }
        case 'TRAINING': {
          const course = await trx.selectFrom('training_catalog').select(['id', 'title', 'validity_months']).where('id', '=', p.courseId).executeTakeFirst();
          if (!course) throw badRequest('Unknown training course');
          const t = await trx.insertInto('training_records').values({ employee_id: emp, training_id: course.id, status: 'PLANNED', scheduled_date: p.scheduledDate ?? effective, cost: p.cost ?? null, notes: r.reason ?? null, hr_request_id: id, assigned_by: actorUserId }).returning('id').executeTakeFirstOrThrow();
          result.trainingRecordId = t.id;
          await addTimeline(trx, { employeeId: emp, type: 'TRAINING', title: `Training assigned: ${course.title}`, description: p.scheduledDate ? `Scheduled ${p.scheduledDate}` : null, refType: 'training_record', refId: t.id, actorUserId, visibility: 'EMPLOYEE' });
          break;
        }
        case 'DISCIPLINARY': {
          const seq = await sql<{ n: number }>`SELECT nextval('disciplinary_case_no_seq')::int AS n`.execute(trx);
          const caseNo = `DC-${new Date().getFullYear()}-${String(seq.rows[0]!.n).padStart(4, '0')}`;
          const c = await trx.insertInto('disciplinary_cases').values({ case_no: caseNo, employee_id: emp, category: p.category, severity: p.severity ?? 'MEDIUM', incident_date: p.incidentDate ?? effective, description: [p.summary, p.details].filter(Boolean).join('\n\n'), action_taken: p.action, status: 'ACTION_TAKEN', is_confidential: true, hr_request_id: id, created_by: actorUserId }).returning('id').executeTakeFirstOrThrow();
          result.caseId = c.id;
          if (p.penaltyAmount && Number(p.penaltyAmount) > 0) {
            const comp = await trx.selectFrom('salary_components').select('id').where('code', '=', 'PENALTY').executeTakeFirst();
            const per = p.penaltyPeriod ? addMonths(`${p.penaltyPeriod.slice(0, 7)}-01`, 0) : addMonths(effective.slice(0, 7) + '-01', 1);
            if (comp) { const d = await trx.insertInto('employee_deductions').values({ employee_id: emp, component_id: comp.id, amount: Number(p.penaltyAmount), reason: `Disciplinary ${caseNo}`, deduction_date: effective, period_year: per.year, period_month: per.month, source: 'DISCIPLINARY', status: 'APPROVED', hr_request_id: id, approved_by: actorUserId, approved_at: new Date(), created_by: actorUserId }).returning('id').executeTakeFirstOrThrow(); result.deductionId = d.id; }
          }
          if (p.action === 'WARNING' || p.action === 'FINAL_WARNING') result.letterTemplate = 'WARNING_LETTER';
          await addTimeline(trx, { employeeId: emp, type: 'DISCIPLINARY', title: `Disciplinary action: ${p.action}`, description: caseNo, refType: 'disciplinary_case', refId: c.id, actorUserId, visibility: 'RESTRICTED' });
          break;
        }
        case 'RESIGNATION': case 'TERMINATION': {
          const to = type === 'RESIGNATION' ? 'RESIGNED' : 'TERMINATED';
          await trx.updateTable('employees').set({ resignation_date: type === 'RESIGNATION' ? (p.resignationDate ?? effective) : null, exit_reason: p.exitReason ?? r.reason ?? null, notice_period_days: p.noticePeriodDays ?? null, updated_by: actorUserId }).where('id', '=', emp).execute();
          const t = await transitionEmployee(trx, { employeeId: emp, to, effectiveDate: effective, reason: r.reason ?? p.exitReason, lastWorkingDate: p.lastWorkingDate, actorUserId });
          result.transition = t;
          changes.status = { from: before.status, to };
          await addTimeline(trx, { employeeId: emp, type: 'STATUS', title: type === 'RESIGNATION' ? 'Resignation accepted' : 'Employment terminated', description: `Last working day ${p.lastWorkingDate}`, refType: 'hr_request', refId: id, actorUserId, visibility: type === 'RESIGNATION' ? 'EMPLOYEE' : 'RESTRICTED' });
          break;
        }
        case 'LETTER': case 'DOCUMENT': case 'OTHER': {
          // Letter issuance happens outside the transaction (uses app-level helpers); DOCUMENT/OTHER just record approval.
          await addTimeline(trx, { employeeId: emp, type: type === 'LETTER' ? 'LETTER' : 'REQUEST', title: `${TITLES[type]} approved`, description: r.request_no, refType: 'hr_request', refId: id, actorUserId, visibility: 'EMPLOYEE' });
          break;
        }
      }
    });
    if (type === 'LETTER') {
      const { issueLetter } = await import('../letters/routes.js');
      const l = await issueLetter(app, { employeeId: emp, templateCode: p.templateCode, language: p.language, addressee: p.addressee, purpose: p.purpose ?? r.reason ?? undefined, change: p.change, userId: actorUserId, hrRequestId: id });
      result.letterId = l.id; result.letterNo = l.letterNo;
    }
    if (type === 'PROMOTION' && p.issueLetter !== false) {
      const { issueLetter } = await import('../letters/routes.js');
      try { const l = await issueLetter(app, { employeeId: emp, templateCode: 'PROMOTION_LETTER', userId: actorUserId, hrRequestId: id, change: { ...changes, effectiveDate: effective } }); result.letterId = l.id; result.letterNo = l.letterNo; } catch (e) { result.letterError = (e as Error).message; }
    }
    if (type === 'INCREMENT' && p.issueLetter) {
      const { issueLetter } = await import('../letters/routes.js');
      try { const l = await issueLetter(app, { employeeId: emp, templateCode: 'INCREMENT_LETTER', userId: actorUserId, hrRequestId: id, change: { ...changes, effectiveDate: effective } }); result.letterId = l.id; result.letterNo = l.letterNo; } catch (e) { result.letterError = (e as Error).message; }
    }
    if (type === 'RESIGNATION' && (result.transition as { workflowCode: string | null } | undefined)?.workflowCode) {
      // Resignation accepted → the existing clearance workflow (employee entity) takes over, exactly as the manual transition does.
      result.clearanceWorkflowInstanceId = await startWorkflow(db, { code: (result.transition as { workflowCode: string }).workflowCode, entityType: 'employee', entityId: emp, initiatedBy: actorUserId, context: { employeeId: emp, to: 'RESIGNED', reason: r.reason } });
    }
    if (type === 'TRANSFER' && result.reevaluateShiftFrom) {
      // Shift assignments are site/project scoped: re-process attendance from the effective date so the new site's shift rules apply.
      try { await app.queues.enqueueProcessAffected([{ employeeId: emp, date: String(result.reevaluateShiftFrom) }]); } catch { /* queue unavailable in tests */ }
    }
    await db.updateTable('hr_requests').set({ status: 'APPLIED', applied_at: new Date(), result: JSON.stringify({ ...result, changes }), apply_error: null }).where('id', '=', id).execute();
    await app.audit(null, { action: `hr_request.${type.toLowerCase()}.applied`, entityType: 'hr_request', entityId: id, oldValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])), newValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])), reason: r.reason, approvalRef: r.workflow_instance_id, metadata: { employeeId: emp, requestNo: r.request_no, result } });
    return { status: 'APPLIED', result: { ...result, changes } };
  } catch (e) {
    const msg = (e as Error).message;
    await db.updateTable('hr_requests').set({ status: 'FAILED', apply_error: msg }).where('id', '=', id).execute();
    await app.audit(null, { action: `hr_request.${type.toLowerCase()}.failed`, entityType: 'hr_request', entityId: id, newValue: { error: msg }, metadata: { employeeId: emp } });
    return { status: 'FAILED', result: null, error: msg };
  }
}

/** Human-readable "what changed" for a request (proposed vs before). */
export function describeChanges(r: { request_type: string; payload: unknown; before_snapshot: unknown; result: unknown }): { field: string; from: unknown; to: unknown }[] {
  const res = (r.result as any)?.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (res) return Object.entries(res).map(([field, v]) => ({ field, from: v.from, to: v.to }));
  const p = (r.payload ?? {}) as Record<string, any>, b = (r.before_snapshot ?? {}) as Record<string, any>;
  const out: { field: string; from: unknown; to: unknown }[] = [];
  const map: Record<string, string> = { designationId: 'designation', gradeId: 'grade', careerLevelId: 'careerLevel', departmentId: 'department', projectId: 'project', siteId: 'site', costCenterId: 'costCenter', managerEmployeeId: 'manager' };
  for (const [k, label] of Object.entries(map)) if (p[k] && p[k] !== b[k]) out.push({ field: label, from: b[label] ?? b[k], to: p[`${label}Name`] ?? p[k] });
  if (p.newBasic !== undefined) out.push({ field: 'basic', from: b.salary?.basic ?? null, to: p.newBasic });
  if (p.percentage !== undefined && !p.amount) out.push({ field: 'percentage', from: null, to: `${p.percentage}%` });
  if (p.amount !== undefined) out.push({ field: 'amount', from: null, to: p.amount });
  if (p.principal !== undefined) out.push({ field: 'principal', from: null, to: p.principal });
  if (p.lastWorkingDate) out.push({ field: 'lastWorkingDate', from: null, to: p.lastWorkingDate });
  if (p.templateCode) out.push({ field: 'template', from: null, to: p.templateCode });
  return out;
}
