import { sql, type Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { WORKING_STATUSES, canTransition, nextStatuses } from '@burtplace/core';
import type { EmployeeStatus } from '@burtplace/types';
import type { Principal } from '../../plugins/auth.js';
import { forbidden, notFound, unprocessable } from '../../plugins/errors.js';
import { resolveScope } from '../../plugins/rbac.js';

export type Scope = 'all' | 'team' | 'own' | 'none';

/** Employee ids visible to a principal under 'team' scope: direct reports + their reports (2 levels) + project/department managed. */
export async function teamEmployeeIds(db: Kysely<DB>, p: Principal): Promise<string[]> {
  if (!p.employeeId) return [];
  const rows = await sql<{ id: string }>`
    WITH RECURSIVE reports AS (
      SELECT id, 1 AS depth FROM employees WHERE manager_employee_id = ${p.employeeId} AND deleted_at IS NULL
      UNION ALL
      SELECT e.id, r.depth + 1 FROM employees e JOIN reports r ON e.manager_employee_id = r.id WHERE r.depth < 4 AND e.deleted_at IS NULL
    )
    SELECT id FROM reports
    UNION SELECT e.id FROM employees e JOIN projects pr ON pr.id = e.project_id WHERE pr.manager_employee_id = ${p.employeeId} AND e.deleted_at IS NULL
    UNION SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.manager_employee_id = ${p.employeeId} AND e.deleted_at IS NULL
  `.execute(db);
  return rows.rows.map((r) => r.id);
}

/** Throws unless the principal may see `employeeId` under the given resource's scope. Returns the scope used. */
export async function assertCanSeeEmployee(db: Kysely<DB>, p: Principal, resource: string, employeeId: string): Promise<Scope> {
  const scope = resolveScope(p, resource);
  if (scope === 'all') return scope;
  if (scope === 'own' && p.employeeId === employeeId) return scope;
  if (scope === 'team') {
    if (p.employeeId === employeeId) return scope;
    const ids = await teamEmployeeIds(db, p);
    if (ids.includes(employeeId)) return scope;
  }
  throw forbidden('You do not have access to this employee');
}

export async function nextEmployeeNo(db: Kysely<DB>): Promise<string> {
  const yy = String(new Date().getFullYear()).slice(-2);
  const r = await sql<{ n: number }>`SELECT nextval('employee_no_seq')::int AS n`.execute(db);
  return `BP-${yy}-${String(r.rows[0]!.n).padStart(3, '0')}`;
}

export interface TransitionInput { employeeId: string; to: EmployeeStatus; effectiveDate?: string; reason?: string; lastWorkingDate?: string; actorUserId: string }

/** Execute a lifecycle transition atomically: validate edge, update status, write history, create checklists, return side-effects. */
export async function transitionEmployee(db: Kysely<DB>, input: TransitionInput): Promise<{ from: EmployeeStatus; to: EmployeeStatus; checklistInstanceId: string | null; workflowCode: string | null }> {
  return db.transaction().execute(async (trx) => {
    const emp = await trx.selectFrom('employees').select(['id', 'status', 'is_office_staff', 'joining_date']).where('id', '=', input.employeeId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
    if (!emp) throw notFound('Employee', input.employeeId);
    const rule = canTransition(emp.status, input.to);
    if (!rule) throw unprocessable(`Cannot transition from ${emp.status} to ${input.to}. Allowed: ${nextStatuses(emp.status).join(', ') || 'none'}`);

    const patch: Record<string, unknown> = { status: input.to, updated_by: input.actorUserId };
    if (input.to === 'CONFIRMED') { patch.confirmation_date = input.effectiveDate ?? new Date().toISOString().slice(0, 10); patch.probation_status = 'CONFIRMED'; }
    if (input.to === 'PROBATION') patch.probation_status = 'ON_PROBATION';
    if ((input.to === 'ACTIVE' || input.to === 'PROBATION') && !emp.joining_date) patch.joining_date = input.effectiveDate ?? new Date().toISOString().slice(0, 10);
    if ((input.to === 'RESIGNED' || input.to === 'TERMINATED') && input.lastWorkingDate) patch.last_working_date = input.lastWorkingDate;
    if (input.to === 'ARCHIVED') patch.deleted_at = null; // archived stays queryable; soft-delete is separate
    await trx.updateTable('employees').set(patch).where('id', '=', emp.id).execute();
    await trx.insertInto('employee_status_history').values({ employee_id: emp.id, from_status: emp.status, to_status: input.to, effective_date: input.effectiveDate ?? new Date().toISOString().slice(0, 10), reason: input.reason ?? null, changed_by: input.actorUserId }).execute();

    let checklistInstanceId: string | null = null;
    for (const action of rule.onEnter ?? []) {
      if (action === 'create_onboarding_checklist' || action === 'create_clearance_checklist') {
        const code = action === 'create_onboarding_checklist' ? 'ONBOARDING' : 'CLEARANCE';
        const tpl = await trx.selectFrom('checklist_templates').select(['id', 'items']).where('code', '=', code).where('is_active', '=', true).executeTakeFirst();
        if (tpl) {
          const inst = await trx.insertInto('checklist_instances').values({ template_id: tpl.id, employee_id: emp.id }).returning('id').executeTakeFirstOrThrow();
          checklistInstanceId = inst.id;
          const items = tpl.items as { key: string; title: string; group: string; ownerRole?: string; required?: boolean; condition?: string }[];
          for (const it of items) {
            if (it.condition === 'office_staff' && !emp.is_office_staff) continue;
            await trx.insertInto('checklist_tasks').values({ instance_id: inst.id, item_key: it.key, title: it.title, group_name: it.group, owner_role_code: it.ownerRole ?? null, is_required: it.required ?? true }).execute();
          }
        }
      }
      if (action === 'disable_access') {
        await trx.updateTable('users').set({ is_active: false }).where('id', '=', (eb) => eb.selectFrom('employees').select('user_id').where('id', '=', emp.id)).execute();
        await trx.updateTable('biometric_mappings').set({ is_active: false }).where('employee_id', '=', emp.id).execute();
      }
    }
    // Mobile face recognition: leaving employees are disabled immediately (retention/deletion is a separate configurable policy — REQUIRES HR/LEGAL APPROVAL)
    if (input.to === 'TERMINATED' || input.to === 'ARCHIVED') {
      await trx.updateTable('biometric_face_templates').set({ status: 'DISABLED', disabled_at: new Date(), disabled_reason: `Employee ${input.to.toLowerCase()}` }).where('employee_id', '=', emp.id).where('status', '=', 'ACTIVE').execute();
      await trx.updateTable('biometric_mappings').set({ is_active: false }).where('employee_id', '=', emp.id).where('provider', '=', 'MOBILE_FACE').execute();
    }
    return { from: emp.status, to: input.to, checklistInstanceId, workflowCode: rule.workflowCode ?? null };
  });
}

export const WORKING = WORKING_STATUSES;
