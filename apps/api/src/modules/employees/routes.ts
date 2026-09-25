import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { nextStatuses } from '@burtplace/core';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery, sortColumn } from '../../lib/pagination.js';
import { badRequest, notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission, resolveScope } from '../../plugins/rbac.js';
import { assertCanSeeEmployee, nextEmployeeNo, teamEmployeeIds, transitionEmployee, WORKING } from './service.js';
import { bankingSchema, documentCreate, documentOut, employeeCreate, employeeDetail, employeeListQuery, employeeSummary, employeeUpdate, historyOut, salaryCreate, salaryOut, transitionBody } from './schemas.js';

const SORTS = ['employee_no', 'full_name_en', 'joining_date', 'status', 'created_at'] as const;

function toSummary(r: Record<string, any>) {
  return {
    id: r.id, employeeNo: r.employee_no, fullNameEn: r.full_name_en, fullNameAr: r.full_name_ar, status: r.status, employmentType: r.employment_type, joiningDate: r.joining_date,
    probationStatus: r.probation_status, photoObjectKey: r.photo_object_key, mobile: r.mobile, workEmail: r.work_email, matrixUserId: r.matrix_user_id, isOfficeStaff: r.is_office_staff,
    department: r.department_id ? { id: r.department_id, name: r.department_name } : null, designation: r.designation_id ? { id: r.designation_id, title: r.designation_title } : null,
    site: r.site_id ? { id: r.site_id, name: r.site_name } : null, project: r.project_id ? { id: r.project_id, code: r.project_code, name: r.project_name } : null,
    manager: r.manager_id ? { id: r.manager_id, name: r.manager_name, employeeNo: r.manager_employee_no } : null,
  };
}

const camel: Record<string, string> = {
  matrixUserId: 'matrix_user_id', firstName: 'first_name', middleName: 'middle_name', lastName: 'last_name', fullNameAr: 'full_name_ar', gender: 'gender', dateOfBirth: 'date_of_birth', nationality: 'nationality',
  maritalStatus: 'marital_status', mobile: 'mobile', workEmail: 'work_email', personalEmail: 'personal_email', emergencyContactName: 'emergency_contact_name', emergencyContactPhone: 'emergency_contact_phone',
  emergencyContactRelation: 'emergency_contact_relation', employmentType: 'employment_type', joiningDate: 'joining_date', probationEndDate: 'probation_end_date', contractStartDate: 'contract_start_date',
  contractEndDate: 'contract_end_date', departmentId: 'department_id', designationId: 'designation_id', siteId: 'site_id', projectId: 'project_id', costCenterId: 'cost_center_id', managerEmployeeId: 'manager_employee_id',
  grade: 'grade', isOfficeStaff: 'is_office_staff', bankName: 'bank_name', bankAccountName: 'bank_account_name', bankAccountNumber: 'bank_account_number', bankIban: 'bank_iban', bankSwift: 'bank_swift', wpsPersonId: 'wps_person_id',
};
function toRow(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (k in camel && v !== undefined) out[camel[k]!] = v;
  return out;
}
const ORG_FIELDS = ['department_id', 'designation_id', 'site_id', 'project_id', 'cost_center_id', 'manager_employee_id', 'grade', 'employment_type'];

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/', {
    preHandler: requirePermission('employees:read', 'employees:read:team', 'employees:read:own'),
    schema: { tags: ['employees'], summary: 'List employees (scoped to caller)', querystring: paginationQuery.merge(employeeListQuery), response: { 200: paginated(employeeSummary) } },
  }, async (req) => {
    const p = requireAuth(req);
    const q = req.query;
    const scope = resolveScope(p, 'employees');
    let base = app.db.selectFrom('v_employee_directory as v').selectAll();
    if (scope === 'own') base = base.where('v.id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (scope === 'team') { const ids = await teamEmployeeIds(app.db, p); base = base.where('v.id', 'in', [...ids, p.employeeId ?? '00000000-0000-0000-0000-000000000000']); }
    if (q.status) base = base.where('v.status', '=', q.status);
    if (q.working) base = base.where('v.status', 'in', WORKING);
    if (q.departmentId) base = base.where('v.department_id', '=', q.departmentId);
    if (q.siteId) base = base.where('v.site_id', '=', q.siteId);
    if (q.projectId) base = base.where('v.project_id', '=', q.projectId);
    if (q.managerId) base = base.where('v.manager_id', '=', q.managerId);
    if (q.employmentType) base = base.where('v.employment_type', '=', q.employmentType);
    if (q.costCenterId) base = base.where('v.cost_center_id', '=', q.costCenterId);
    if (q.gradeId || q.careerLevelId || q.jobFamilyId || q.nationality || q.probation || q.contract || q.missing) {
      base = base.where('v.id', 'in', (eb) => {
        let sub = eb.selectFrom('employees as e').select('e.id');
        if (q.gradeId) sub = sub.where('e.grade_id', '=', q.gradeId);
        if (q.careerLevelId) sub = sub.where('e.career_level_id', '=', q.careerLevelId);
        if (q.jobFamilyId) sub = sub.where('e.job_family_id', '=', q.jobFamilyId);
        if (q.nationality) sub = sub.where('e.nationality', '=', q.nationality.toUpperCase());
        if (q.probation === 'on') sub = sub.where('e.probation_status', '=', 'ON_PROBATION');
        if (q.probation === 'due') sub = sub.where('e.probation_status', '=', 'ON_PROBATION').where('e.probation_end_date', '<=', sql<string>`(CURRENT_DATE + interval '14 days')::date`).where('e.probation_end_date', '>=', sql<string>`CURRENT_DATE`);
        if (q.probation === 'overdue') sub = sub.where('e.probation_status', '=', 'ON_PROBATION').where('e.probation_end_date', '<', sql<string>`CURRENT_DATE`);
        if (q.contract === 'expiring') sub = sub.where('e.contract_end_date', '<=', sql<string>`(CURRENT_DATE + interval '90 days')::date`);
        if (q.missing === 'iban') sub = sub.where('e.bank_iban', 'is', null);
        if (q.missing === 'biometric') sub = sub.where('e.matrix_user_id', 'is', null);
        if (q.missing === 'salary') sub = sub.where('e.id', 'not in', eb.selectFrom('employee_salary_structures').select('employee_id'));
        return sub;
      });
    }
    if (q.q) {
      const term = `%${q.q}%`;
      base = base.where((eb) => eb.or([eb('v.employee_no', 'ilike', term), eb('v.full_name_en', 'ilike', term), eb('v.full_name_ar', 'ilike', term), eb('v.mobile', 'ilike', term), eb('v.work_email', 'ilike', term), eb('v.matrix_user_id', '=', q.q!)]));
    }
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy(sortColumn(q, SORTS, 'employee_no'), q.order).limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(toSummary), meta: pageMeta(q, total) };
  });

  r.post('/', {
    preHandler: requirePermission('employees:create'),
    schema: { tags: ['employees'], summary: 'Create employee', body: employeeCreate, response: { 201: employeeDetail, 400: errorSchema, 409: errorSchema } },
  }, async (req, reply) => {
    const p = requireAuth(req);
    const employeeNo = req.body.employeeNo ?? (await nextEmployeeNo(app.db));
    const row = toRow(req.body);
    const created = await app.db.transaction().execute(async (trx) => {
      const e = await trx.insertInto('employees').values({ ...(row as any), employee_no: employeeNo, status: req.body.status, created_by: p.userId, updated_by: p.userId }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('employee_status_history').values({ employee_id: e.id, from_status: null, to_status: req.body.status, reason: 'created', changed_by: p.userId }).execute();
      await trx.insertInto('employment_history').values({ employee_id: e.id, effective_from: req.body.joiningDate ?? new Date().toISOString().slice(0, 10), change_type: 'JOIN', department_id: req.body.departmentId ?? null, designation_id: req.body.designationId ?? null, site_id: req.body.siteId ?? null, project_id: req.body.projectId ?? null, cost_center_id: req.body.costCenterId ?? null, manager_employee_id: req.body.managerEmployeeId ?? null, grade: req.body.grade ?? null, employment_type: req.body.employmentType, changed_by: p.userId }).execute();
      if (req.body.matrixUserId) await trx.insertInto('biometric_mappings').values({ employee_id: e.id, external_user_id: req.body.matrixUserId }).execute();
      return e;
    });
    await app.audit(req, { action: 'employee.create', entityType: 'employee', entityId: created.id, newValue: { ...row, employee_no: employeeNo } });
    return reply.status(201).send(await loadDetail(created.id, p));
  });

  async function loadDetail(id: string, p: { permissions: Set<string> }) {
    const v = await app.db.selectFrom('v_employee_directory').selectAll().where('id', '=', id).executeTakeFirst();
    if (!v) throw notFound('Employee', id);
    const e = await app.db.selectFrom('employees').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const cc = e.cost_center_id ? await app.db.selectFrom('cost_centers').select(['id', 'code']).where('id', '=', e.cost_center_id).executeTakeFirst() : null;
    return {
      ...toSummary(v), firstName: e.first_name, middleName: e.middle_name, lastName: e.last_name, gender: e.gender, dateOfBirth: e.date_of_birth, nationality: e.nationality, maritalStatus: e.marital_status,
      personalEmail: e.personal_email, emergencyContactName: e.emergency_contact_name, emergencyContactPhone: e.emergency_contact_phone, emergencyContactRelation: e.emergency_contact_relation,
      probationEndDate: e.probation_end_date, confirmationDate: e.confirmation_date, contractStartDate: e.contract_start_date, contractEndDate: e.contract_end_date, lastWorkingDate: e.last_working_date,
      costCenter: cc ?? null, grade: e.grade, userId: e.user_id, zohoRecordId: e.zoho_record_id,
      banking: p.permissions.has('employees:banking:read') ? { bankName: e.bank_name, bankAccountName: e.bank_account_name, bankAccountNumber: e.bank_account_number, bankIban: e.bank_iban, bankSwift: e.bank_swift, wpsPersonId: e.wps_person_id } : null,
      allowedTransitions: nextStatuses(e.status), createdAt: String(e.created_at), updatedAt: String(e.updated_at),
    };
  }

  r.get('/:id', { preHandler: requirePermission('employees:read', 'employees:read:team', 'employees:read:own'), schema: { tags: ['employees'], summary: 'Employee profile', params: idParam, response: { 200: employeeDetail, 404: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    await assertCanSeeEmployee(app.db, p, 'employees', req.params.id);
    return loadDetail(req.params.id, p);
  });

  r.get('/by-number/:employeeNo', { preHandler: requirePermission('employees:read', 'employees:read:team', 'employees:read:own'), schema: { tags: ['employees'], summary: 'Employee by employee number', params: z.object({ employeeNo: z.string() }), response: { 200: employeeDetail, 404: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const e = await app.db.selectFrom('employees').select('id').where('employee_no', '=', req.params.employeeNo.toUpperCase()).where('deleted_at', 'is', null).executeTakeFirst();
    if (!e) throw notFound('Employee', req.params.employeeNo);
    await assertCanSeeEmployee(app.db, p, 'employees', e.id);
    return loadDetail(e.id, p);
  });

  r.patch('/:id', { preHandler: requirePermission('employees:update'), schema: { tags: ['employees'], summary: 'Update employee (audited; org changes create employment history)', params: idParam, body: employeeUpdate, response: { 200: employeeDetail, 404: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const before = await app.db.selectFrom('employees').selectAll().where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!before) throw notFound('Employee', req.params.id);
    const { reason, ...rest } = req.body;
    const row = toRow(rest);
    if (Object.keys(row).length === 0) throw badRequest('No updatable fields supplied');
    const changed = Object.fromEntries(Object.entries(row).filter(([k, v]) => (before as any)[k] !== v));
    await app.db.transaction().execute(async (trx) => {
      await trx.updateTable('employees').set({ ...(row as any), updated_by: p.userId }).where('id', '=', req.params.id).execute();
      const orgChanged = ORG_FIELDS.filter((f) => f in changed);
      if (orgChanged.length) {
        const today = new Date().toISOString().slice(0, 10);
        await trx.updateTable('employment_history').set({ effective_to: today }).where('employee_id', '=', req.params.id).where('effective_to', 'is', null).execute();
        const after = { ...before, ...row } as any;
        const changeType = 'designation_id' in changed ? 'PROMOTION' : 'site_id' in changed || 'project_id' in changed || 'department_id' in changed ? 'TRANSFER' : 'manager_employee_id' in changed ? 'MANAGER_CHANGE' : 'OTHER';
        await trx.insertInto('employment_history').values({ employee_id: req.params.id, effective_from: today, change_type: changeType, department_id: after.department_id, designation_id: after.designation_id, site_id: after.site_id, project_id: after.project_id, cost_center_id: after.cost_center_id, manager_employee_id: after.manager_employee_id, grade: after.grade, employment_type: after.employment_type, reason: reason ?? null, changed_by: p.userId }).execute();
      }
      if ('matrix_user_id' in changed && row.matrix_user_id) {
        await trx.insertInto('biometric_mappings').values({ employee_id: req.params.id, external_user_id: String(row.matrix_user_id) }).onConflict((oc) => oc.columns(['provider', 'external_user_id']).doUpdateSet({ employee_id: req.params.id, is_active: true })).execute();
      }
    });
    await app.audit(req, { action: 'employee.update', entityType: 'employee', entityId: req.params.id, oldValue: Object.fromEntries(Object.keys(changed).map((k) => [k, (before as any)[k]])), newValue: changed, reason });
    return loadDetail(req.params.id, p);
  });

  r.delete('/:id', { preHandler: requirePermission('employees:delete'), schema: { tags: ['employees'], summary: 'Soft-delete employee (only CANDIDATE/OFFER/ARCHIVED)', params: idParam, response: { 204: z.null(), 422: errorSchema } } }, async (req, reply) => {
    const e = await app.db.selectFrom('employees').select(['status']).where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!e) throw notFound('Employee', req.params.id);
    if (!['CANDIDATE', 'OFFER', 'ARCHIVED'].includes(e.status)) throw badRequest('Only CANDIDATE, OFFER or ARCHIVED employees can be deleted; use lifecycle transitions instead');
    await app.db.updateTable('employees').set({ deleted_at: new Date() }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'employee.delete', entityType: 'employee', entityId: req.params.id });
    return reply.status(204).send(null);
  });

  r.post('/:id/transition', { preHandler: requirePermission('employees:transition'), schema: { tags: ['employees'], summary: 'Lifecycle transition (state machine, audited, creates onboarding/clearance checklists)', params: idParam, body: transitionBody, response: { 200: z.object({ from: z.string(), to: z.string(), checklistInstanceId: z.string().nullable(), workflowInstanceId: z.string().nullable() }), 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const result = await transitionEmployee(app.db, { employeeId: req.params.id, to: req.body.to, effectiveDate: req.body.effectiveDate, reason: req.body.reason, lastWorkingDate: req.body.lastWorkingDate, actorUserId: p.userId });
    let workflowInstanceId: string | null = null;
    if (result.workflowCode) {
      const { startWorkflow } = await import('../workflows/service.js');
      workflowInstanceId = await startWorkflow(app.db, { code: result.workflowCode, entityType: 'employee', entityId: req.params.id, initiatedBy: p.userId, context: { to: req.body.to, reason: req.body.reason } });
    }
    await app.audit(req, { action: 'employee.transition', entityType: 'employee', entityId: req.params.id, oldValue: { status: result.from }, newValue: { status: result.to }, reason: req.body.reason, approvalRef: workflowInstanceId });
    return { ...result, workflowInstanceId };
  });

  r.get('/:id/history', { preHandler: requirePermission('employees:read', 'employees:read:team', 'employees:read:own'), schema: { tags: ['employees'], summary: 'Status and employment history', params: idParam, response: { 200: historyOut } } }, async (req) => {
    await assertCanSeeEmployee(app.db, requireAuth(req), 'employees', req.params.id);
    const status = await app.db.selectFrom('employee_status_history as h').leftJoin('users as u', 'u.id', 'h.changed_by').select(['h.from_status', 'h.to_status', 'h.effective_date', 'h.reason', 'u.display_name', 'h.created_at']).where('h.employee_id', '=', req.params.id).orderBy('h.created_at', 'desc').execute();
    const employment = await app.db.selectFrom('employment_history as h').leftJoin('departments as d', 'd.id', 'h.department_id').leftJoin('designations as g', 'g.id', 'h.designation_id').leftJoin('sites as s', 's.id', 'h.site_id').leftJoin('projects as pr', 'pr.id', 'h.project_id')
      .select(['h.effective_from', 'h.effective_to', 'h.change_type', 'd.name as department', 'g.title as designation', 's.name as site', 'pr.name as project', 'h.reason', 'h.created_at']).where('h.employee_id', '=', req.params.id).orderBy('h.effective_from', 'desc').orderBy('h.id', 'desc').execute();
    return {
      status: status.map((s) => ({ fromStatus: s.from_status, toStatus: s.to_status, effectiveDate: s.effective_date, reason: s.reason, changedBy: s.display_name, createdAt: String(s.created_at) })),
      employment: employment.map((h) => ({ effectiveFrom: h.effective_from, effectiveTo: h.effective_to, changeType: h.change_type, department: h.department, designation: h.designation, site: h.site, project: h.project, reason: h.reason, createdAt: String(h.created_at) })),
    };
  });

  // ── Banking (restricted) ──
  r.put('/:id/banking', { preHandler: requirePermission('employees:banking:write'), schema: { tags: ['employees'], summary: 'Update banking details (restricted, audited)', params: idParam, body: bankingSchema, response: { 200: bankingSchema } } }, async (req) => {
    const before = await app.db.selectFrom('employees').select(['bank_name', 'bank_account_name', 'bank_account_number', 'bank_iban', 'bank_swift', 'wps_person_id']).where('id', '=', req.params.id).executeTakeFirst();
    if (!before) throw notFound('Employee', req.params.id);
    const row = toRow(req.body);
    await app.db.updateTable('employees').set({ ...(row as any), updated_by: req.principal!.userId }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'employee.banking.update', entityType: 'employee', entityId: req.params.id, oldValue: before, newValue: row });
    return req.body;
  });

  // ── Documents ──
  const docToOut = (d: Record<string, any>) => ({
    id: d.id, employeeId: d.employee_id, documentType: d.document_type, documentNumber: d.document_number, issueDate: d.issue_date, expiryDate: d.expiry_date, issuingAuthority: d.issuing_authority,
    objectKey: d.object_key, fileName: d.file_name, status: d.status, reminderDaysBefore: d.reminder_days_before, notes: d.notes, createdAt: String(d.created_at),
    daysToExpiry: d.expiry_date ? Math.round((new Date(d.expiry_date).getTime() - Date.now()) / 864e5) : null,
  });
  r.get('/:id/documents', { preHandler: requirePermission('employees:documents:read', 'employees:read:own'), schema: { tags: ['employees'], summary: 'Employee documents', params: idParam, response: { 200: z.array(documentOut) } } }, async (req) => {
    const p = requireAuth(req);
    if (!hasPermission(p, 'employees:documents:read')) await assertCanSeeEmployee(app.db, p, 'employees', req.params.id);
    const docs = await app.db.selectFrom('employee_documents').selectAll().where('employee_id', '=', req.params.id).where('deleted_at', 'is', null).orderBy('document_type').execute();
    return docs.map(docToOut);
  });
  r.post('/:id/documents', { preHandler: requirePermission('employees:documents:write'), schema: { tags: ['employees'], summary: 'Add document (file uploaded separately to object storage; pass objectKey)', params: idParam, body: documentCreate, response: { 201: documentOut } } }, async (req, reply) => {
    const b = req.body;
    const status = b.expiryDate ? (new Date(b.expiryDate) < new Date() ? 'EXPIRED' : (new Date(b.expiryDate).getTime() - Date.now()) / 864e5 <= b.reminderDaysBefore ? 'EXPIRING' : 'VALID') : 'PENDING';
    const d = await app.db.insertInto('employee_documents').values({ employee_id: req.params.id, document_type: b.documentType, document_number: b.documentNumber ?? null, issue_date: b.issueDate ?? null, expiry_date: b.expiryDate ?? null, issuing_authority: b.issuingAuthority ?? null, object_key: b.objectKey ?? null, file_name: b.fileName ?? null, mime_type: b.mimeType ?? null, file_size_bytes: b.fileSizeBytes ?? null, status, reminder_days_before: b.reminderDaysBefore, notes: b.notes ?? null, created_by: req.principal!.userId }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'employee.document.create', entityType: 'employee_document', entityId: d.id, newValue: { employeeId: req.params.id, documentType: b.documentType, expiryDate: b.expiryDate } });
    return reply.status(201).send(docToOut(d));
  });
  r.delete('/:id/documents/:docId', { preHandler: requirePermission('employees:documents:write'), schema: { tags: ['employees'], summary: 'Remove document (soft)', params: idParam.extend({ docId: z.string().uuid() }), response: { 204: z.null() } } }, async (req, reply) => {
    await app.db.updateTable('employee_documents').set({ deleted_at: new Date() }).where('id', '=', req.params.docId).where('employee_id', '=', req.params.id).execute();
    await app.audit(req, { action: 'employee.document.delete', entityType: 'employee_document', entityId: req.params.docId });
    return reply.status(204).send(null);
  });

  // ── Salary (restricted) ──
  async function loadSalary(structureId: string) {
    const s = await app.db.selectFrom('employee_salary_structures').selectAll().where('id', '=', structureId).executeTakeFirstOrThrow();
    const lines = await app.db.selectFrom('employee_salary_lines as l').innerJoin('salary_components as c', 'c.id', 'l.component_id').select(['c.code', 'c.name', 'c.kind', 'l.amount', 'c.sort_order']).where('l.salary_structure_id', '=', structureId).orderBy('c.sort_order').execute();
    return { id: s.id, version: s.version, effectiveFrom: s.effective_from, effectiveTo: s.effective_to, currency: s.currency, basicSalary: Number(s.basic_salary), grossSalary: Number(s.gross_salary), reason: s.reason, createdAt: String(s.created_at), lines: lines.map((l) => ({ componentCode: l.code, componentName: l.name, kind: l.kind, amount: Number(l.amount) })) };
  }
  r.get('/:id/salary', { preHandler: requirePermission('salary:read', 'salary:read:own'), schema: { tags: ['employees'], summary: 'Salary structure versions (restricted)', params: idParam, response: { 200: z.array(salaryOut) } } }, async (req) => {
    const p = requireAuth(req);
    if (!hasPermission(p, 'salary:read') && p.employeeId !== req.params.id) throw notFound('Employee', req.params.id);
    const versions = await app.db.selectFrom('employee_salary_structures').select('id').where('employee_id', '=', req.params.id).orderBy('version', 'desc').execute();
    return Promise.all(versions.map((v) => loadSalary(v.id)));
  });
  r.post('/:id/salary', { preHandler: requirePermission('salary:write'), schema: { tags: ['employees'], summary: 'Create a new salary structure version (supersedes the current one; audited)', params: idParam, body: salaryCreate, response: { 201: salaryOut, 400: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const comps = await app.db.selectFrom('salary_components').select(['id', 'code', 'kind', 'is_fixed_pay']).where('is_active', '=', true).execute();
    const byCode = new Map(comps.map((c) => [c.code, c]));
    for (const l of req.body.lines) if (!byCode.has(l.componentCode)) throw badRequest(`Unknown salary component ${l.componentCode}`);
    const basic = req.body.lines.find((l) => l.componentCode === 'BASIC')?.amount;
    if (basic === undefined) throw badRequest('A BASIC line is required');
    const gross = req.body.lines.filter((l) => byCode.get(l.componentCode)!.is_fixed_pay && byCode.get(l.componentCode)!.kind === 'EARNING').reduce((s, l) => s + l.amount, 0);
    const created = await app.db.transaction().execute(async (trx) => {
      const prev = await trx.selectFrom('employee_salary_structures').select(['id', 'version', 'gross_salary', 'basic_salary']).where('employee_id', '=', req.params.id).orderBy('version', 'desc').limit(1).forUpdate().executeTakeFirst();
      if (prev) await trx.updateTable('employee_salary_structures').set({ effective_to: sql`(${req.body.effectiveFrom}::date - interval '1 day')::date` }).where('id', '=', prev.id).execute();
      const s = await trx.insertInto('employee_salary_structures').values({ employee_id: req.params.id, version: (prev?.version ?? 0) + 1, effective_from: req.body.effectiveFrom, currency: req.body.currency, basic_salary: basic, gross_salary: gross, reason: req.body.reason ?? null, created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
      for (const l of req.body.lines) await trx.insertInto('employee_salary_lines').values({ salary_structure_id: s.id, component_id: byCode.get(l.componentCode)!.id, amount: l.amount }).execute();
      // Compensation ledger: joining salary, or a flagged correction made outside the compensation workflow.
      const { loadPolicy } = await import('../compensation/policy.js');
      if (prev && (await loadPolicy(trx)).directSalaryEntry === 'INITIAL_ONLY') throw unprocessable('Salary changes after the initial salary must go through Compensation (salary change / review / promotion) — direct entry is disabled by policy');
      const { recordDirectSalaryEntry } = await import('../compensation/ledger.js');
      await recordDirectSalaryEntry(trx, { employeeId: req.params.id, structureId: s.id, reason: req.body.reason ?? null, userId: p.userId });
      return { id: s.id, prev };
    });
    await app.audit(req, { action: 'employee.salary.update', entityType: 'employee', entityId: req.params.id, oldValue: created.prev ? { basic: Number(created.prev.basic_salary), gross: Number(created.prev.gross_salary) } : null, newValue: { basic, gross, lines: req.body.lines }, reason: req.body.reason });
    return reply.status(201).send(await loadSalary(created.id));
  });

  // ── Checklists (onboarding / clearance) ──
  r.get('/:id/checklists', { preHandler: requirePermission('employees:read', 'employees:read:team', 'employees:read:own'), schema: { tags: ['employees'], summary: 'Onboarding / clearance checklists', params: idParam, response: { 200: z.array(z.object({ id: z.string(), template: z.string(), status: z.string(), createdAt: z.string(), completedAt: z.string().nullable(), tasks: z.array(z.object({ id: z.string(), key: z.string(), title: z.string(), group: z.string(), ownerRole: z.string().nullable(), required: z.boolean(), status: z.string(), completedAt: z.string().nullable(), note: z.string().nullable() })) })) } } }, async (req) => {
    await assertCanSeeEmployee(app.db, requireAuth(req), 'employees', req.params.id);
    const insts = await app.db.selectFrom('checklist_instances as i').innerJoin('checklist_templates as t', 't.id', 'i.template_id').select(['i.id', 't.code', 'i.status', 'i.created_at', 'i.completed_at']).where('i.employee_id', '=', req.params.id).orderBy('i.created_at', 'desc').execute();
    return Promise.all(insts.map(async (i) => ({
      id: i.id, template: i.code, status: i.status, createdAt: String(i.created_at), completedAt: i.completed_at ? String(i.completed_at) : null,
      tasks: (await app.db.selectFrom('checklist_tasks').selectAll().where('instance_id', '=', i.id).orderBy('group_name').orderBy('created_at').execute()).map((t) => ({ id: t.id, key: t.item_key, title: t.title, group: t.group_name, ownerRole: t.owner_role_code, required: t.is_required, status: t.status, completedAt: t.completed_at ? String(t.completed_at) : null, note: t.note })),
    })));
  });
  r.post('/checklist-tasks/:taskId/complete', { preHandler: requirePermission('employees:update', 'devices:write', 'payroll:run', 'users:write', 'assets:write'), schema: { tags: ['employees'], summary: 'Complete a checklist task (role-owned)', params: z.object({ taskId: z.string().uuid() }), body: z.object({ status: z.enum(['DONE', 'NOT_APPLICABLE']).default('DONE'), note: z.string().max(500).optional() }), response: { 200: z.object({ instanceStatus: z.string() }) } } }, async (req) => {
    const p = requireAuth(req);
    const task = await app.db.selectFrom('checklist_tasks').select(['id', 'instance_id', 'owner_role_code']).where('id', '=', req.params.taskId).executeTakeFirst();
    if (!task) throw notFound('Checklist task', req.params.taskId);
    if (task.owner_role_code && !p.roles.includes(task.owner_role_code) && !p.roles.includes('SUPER_ADMIN') && !p.roles.includes('HR_MANAGER')) throw badRequest(`This task is owned by role ${task.owner_role_code}`);
    await app.db.updateTable('checklist_tasks').set({ status: req.body.status, completed_by: p.userId, completed_at: new Date(), note: req.body.note ?? null }).where('id', '=', task.id).execute();
    const open = await app.db.selectFrom('checklist_tasks').select((eb) => eb.fn.countAll<number>().as('n')).where('instance_id', '=', task.instance_id).where('status', '=', 'PENDING').where('is_required', '=', true).executeTakeFirstOrThrow();
    let instanceStatus = 'OPEN';
    if (Number(open.n) === 0) { instanceStatus = 'COMPLETED'; await app.db.updateTable('checklist_instances').set({ status: 'COMPLETED', completed_at: new Date() }).where('id', '=', task.instance_id).execute(); }
    await app.audit(req, { action: 'checklist.task.complete', entityType: 'checklist_task', entityId: task.id, newValue: req.body });
    return { instanceStatus };
  });
};
