import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam } from '../../lib/pagination.js';
import { badRequest, notFound } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { employeeCreate } from '../employees/schemas.js';
import { nextEmployeeNo } from '../employees/service.js';

/**
 * Legacy data migration framework (Zoho People export, Excel, VYOM exports → Burtplace).
 * Source-agnostic: callers upload NORMALISED rows (already mapped to Burtplace fields). Mappers for specific sources
 * live outside core (see /integrations/zoho) and are removable. Flow: create batch → validate → apply. Idempotent by source_id.
 */
const employeeRow = employeeCreate.extend({ sourceId: z.string().optional(), zohoRecordId: z.string().optional(), departmentCode: z.string().optional(), designationCode: z.string().optional(), siteCode: z.string().optional(), projectCode: z.string().optional(), managerEmployeeNo: z.string().optional(), basicSalary: z.number().optional(), housing: z.number().optional(), transport: z.number().optional(), food: z.number().optional(), otherAllowance: z.number().optional() });
const leaveBalanceRow = z.object({ sourceId: z.string().optional(), employeeNo: z.string(), leaveTypeCode: z.string(), year: z.number().int(), balanceDays: z.number() });

export const migrationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const batchOut = z.object({ id: z.string(), source: z.string(), entityType: z.string(), status: z.string(), totalRows: z.number(), validRows: z.number(), appliedRows: z.number(), errors: z.array(z.unknown()), createdAt: z.string() });
  const bm = (b: any) => ({ id: b.id, source: b.source, entityType: b.entity_type, status: b.status, totalRows: b.total_rows, validRows: b.valid_rows, appliedRows: b.applied_rows, errors: (b.errors ?? []) as unknown[], createdAt: new Date(b.created_at).toISOString() });

  r.get('/batches', { preHandler: requirePermission('migration:run'), schema: { tags: ['integrations'], summary: 'Migration batches', response: { 200: z.array(batchOut) } } }, async () => (await app.db.selectFrom('migration_batches').selectAll().orderBy('created_at', 'desc').limit(100).execute()).map(bm));

  r.post('/batches', { preHandler: requirePermission('migration:run'), schema: { tags: ['integrations'], summary: 'Create and validate a migration batch of normalised rows', body: z.object({ source: z.enum(['ZOHO_PEOPLE', 'EXCEL', 'VYOM_EXPORT', 'OTHER']), entityType: z.enum(['employees', 'leave_balances']), fileName: z.string().optional(), rows: z.array(z.record(z.unknown())).min(1).max(10000) }), response: { 201: batchOut, 400: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const schema = req.body.entityType === 'employees' ? employeeRow : leaveBalanceRow;
    const batch = await app.db.insertInto('migration_batches').values({ source: req.body.source, entity_type: req.body.entityType, file_name: req.body.fileName ?? null, total_rows: req.body.rows.length, created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    let valid = 0;
    const errors: unknown[] = [];
    for (const [i, raw] of req.body.rows.entries()) {
      const parsed = schema.safeParse(raw);
      const ok = parsed.success;
      if (ok) valid++; else errors.push({ row: i + 1, issues: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
      await app.db.insertInto('migration_rows').values({ batch_id: batch.id, row_number: i + 1, source_id: (raw as any).sourceId ?? (raw as any).zohoRecordId ?? null, raw: JSON.stringify(raw), normalized: ok ? JSON.stringify(parsed.data) : null, status: ok ? 'VALID' : 'INVALID', error: ok ? null : parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') }).execute();
    }
    const updated = await app.db.updateTable('migration_batches').set({ status: 'VALIDATED', valid_rows: valid, errors: JSON.stringify(errors.slice(0, 500)) }).where('id', '=', batch.id).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'migration.batch.create', entityType: 'migration_batch', entityId: batch.id, metadata: { source: req.body.source, entityType: req.body.entityType, rows: req.body.rows.length, valid } });
    return reply.status(201).send(bm(updated));
  });

  r.post('/batches/:id/apply', { preHandler: requirePermission('migration:run'), schema: { tags: ['integrations'], summary: 'Apply valid rows (idempotent: rows already applied or matching an existing source id / employee number are updated, not duplicated)', params: idParam, response: { 200: batchOut, 400: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const batch = await app.db.selectFrom('migration_batches').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!batch) throw notFound('Batch', req.params.id);
    if (batch.status === 'APPLIED') throw badRequest('Batch already applied');
    const rows = await app.db.selectFrom('migration_rows').selectAll().where('batch_id', '=', batch.id).where('status', '=', 'VALID').orderBy('row_number').execute();
    const lookups = { dept: new Map((await app.db.selectFrom('departments').select(['id', 'code']).execute()).map((x) => [x.code, x.id])), desig: new Map((await app.db.selectFrom('designations').select(['id', 'code']).execute()).map((x) => [x.code, x.id])), site: new Map((await app.db.selectFrom('sites').select(['id', 'code']).execute()).map((x) => [x.code, x.id])), proj: new Map((await app.db.selectFrom('projects').select(['id', 'code']).execute()).map((x) => [x.code, x.id])), comp: new Map((await app.db.selectFrom('salary_components').select(['id', 'code']).execute()).map((x) => [x.code, x.id])), leave: new Map((await app.db.selectFrom('leave_types').select(['id', 'code']).execute()).map((x) => [x.code, x.id])) };
    let applied = 0;
    const errors: unknown[] = [...((batch.errors as unknown[]) ?? [])];
    for (const row of rows) {
      const n = row.normalized as any;
      try {
        if (batch.entity_type === 'employees') {
          const employeeNo = n.employeeNo ?? (await nextEmployeeNo(app.db));
          const values: any = { employee_no: employeeNo, zoho_record_id: n.zohoRecordId ?? null, matrix_user_id: n.matrixUserId ?? null, first_name: n.firstName, middle_name: n.middleName ?? null, last_name: n.lastName, full_name_ar: n.fullNameAr ?? null, gender: n.gender, date_of_birth: n.dateOfBirth ?? null, nationality: n.nationality ?? null, marital_status: n.maritalStatus, mobile: n.mobile ?? null, work_email: n.workEmail ?? null, personal_email: n.personalEmail ?? null, status: n.status, employment_type: n.employmentType, joining_date: n.joiningDate ?? null, contract_start_date: n.contractStartDate ?? null, contract_end_date: n.contractEndDate ?? null, department_id: lookups.dept.get(n.departmentCode) ?? n.departmentId ?? null, designation_id: lookups.desig.get(n.designationCode) ?? n.designationId ?? null, site_id: lookups.site.get(n.siteCode) ?? n.siteId ?? null, project_id: lookups.proj.get(n.projectCode) ?? n.projectId ?? null, grade: n.grade ?? null, is_office_staff: n.isOfficeStaff ?? false, created_by: p.userId, updated_by: p.userId };
          if (n.managerEmployeeNo) values.manager_employee_id = (await app.db.selectFrom('employees').select('id').where('employee_no', '=', n.managerEmployeeNo).executeTakeFirst())?.id ?? null;
          const e = await app.db.insertInto('employees').values(values).onConflict((oc) => oc.column('employee_no').doUpdateSet(values)).returning('id').executeTakeFirstOrThrow();
          if (n.matrixUserId) await app.db.insertInto('biometric_mappings').values({ employee_id: e.id, external_user_id: String(n.matrixUserId) }).onConflict((oc) => oc.columns(['provider', 'external_user_id']).doUpdateSet({ employee_id: e.id, is_active: true })).execute();
          if (n.basicSalary !== undefined) {
            const exists = await app.db.selectFrom('employee_salary_structures').select('id').where('employee_id', '=', e.id).executeTakeFirst();
            if (!exists) {
              const lines: [string, number][] = [['BASIC', n.basicSalary], ['HOUSING', n.housing ?? 0], ['TRANSPORT', n.transport ?? 0], ['FOOD', n.food ?? 0], ['OTHER_ALW', n.otherAllowance ?? 0]];
              const gross = lines.reduce((s, [, v]) => s + v, 0);
              const ss = await app.db.insertInto('employee_salary_structures').values({ employee_id: e.id, version: 1, effective_from: n.joiningDate ?? new Date().toISOString().slice(0, 10), basic_salary: n.basicSalary, gross_salary: gross, reason: `Migrated from ${batch.source}`, created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
              for (const [code, amt] of lines) if (amt > 0 && lookups.comp.has(code)) await app.db.insertInto('employee_salary_lines').values({ salary_structure_id: ss.id, component_id: lookups.comp.get(code)!, amount: amt }).execute();
            }
          }
          await app.db.updateTable('migration_rows').set({ status: 'APPLIED', target_id: e.id }).where('id', '=', row.id).execute();
        } else {
          const emp = await app.db.selectFrom('employees').select('id').where('employee_no', '=', n.employeeNo).executeTakeFirst();
          const lt = lookups.leave.get(n.leaveTypeCode);
          if (!emp || !lt) throw new Error(`unknown employee ${n.employeeNo} or leave type ${n.leaveTypeCode}`);
          const bal = await app.db.insertInto('leave_balances').values({ employee_id: emp.id, leave_type_id: lt, period_year: n.year, opening_days: n.balanceDays }).onConflict((oc) => oc.columns(['employee_id', 'leave_type_id', 'period_year']).doUpdateSet({ opening_days: n.balanceDays })).returning('id').executeTakeFirstOrThrow();
          await app.db.insertInto('leave_balance_transactions').values({ balance_id: bal.id, txn_type: 'ADJUSTMENT', days: n.balanceDays, note: `Opening balance migrated from ${batch.source}`, created_by: p.userId }).execute();
          await app.db.updateTable('migration_rows').set({ status: 'APPLIED', target_id: bal.id }).where('id', '=', row.id).execute();
        }
        applied++;
      } catch (e) {
        errors.push({ row: row.row_number, issues: [(e as Error).message] });
        await app.db.updateTable('migration_rows').set({ status: 'INVALID', error: (e as Error).message }).where('id', '=', row.id).execute();
      }
    }
    const updated = await app.db.updateTable('migration_batches').set({ status: 'APPLIED', applied_rows: applied, applied_at: new Date(), errors: JSON.stringify(errors.slice(0, 500)) }).where('id', '=', batch.id).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'migration.batch.apply', entityType: 'migration_batch', entityId: batch.id, metadata: { applied, failed: errors.length } });
    return bm(updated);
  });
};
