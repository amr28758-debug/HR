import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';

/**
 * Generic workflow engine.
 *   Trigger (event) → Conditions → Steps (sequential approvals; each step may have a condition) → Actions → Notifications.
 * Definitions live in workflow_definitions (JSON), so modules never hard-code approval chains.
 */
export interface StepDef { key: string; approverType: 'MANAGER' | 'ROLE' | 'USER'; roleCode?: string; userId?: string; condition?: Condition }
export interface Condition { field: string; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'; value: unknown }
export interface ActionDef { type: 'set_status' | 'transition_employee'; onApprove?: string; onReject?: string }

export function evalCondition(c: Condition | undefined, ctx: Record<string, unknown>): boolean {
  if (!c) return true;
  const v = ctx[c.field] as any;
  switch (c.op) {
    case 'eq': return v === c.value; case 'ne': return v !== c.value; case 'gt': return Number(v) > Number(c.value); case 'gte': return Number(v) >= Number(c.value);
    case 'lt': return Number(v) < Number(c.value); case 'lte': return Number(v) <= Number(c.value); case 'in': return Array.isArray(c.value) && c.value.includes(v);
  }
}

async function managerUserIdFor(db: Kysely<DB>, employeeId: string | undefined): Promise<string | null> {
  if (!employeeId) return null;
  const row = await db.selectFrom('employees as e').leftJoin('employees as m', 'm.id', 'e.manager_employee_id').select('m.user_id').where('e.id', '=', employeeId).executeTakeFirst();
  return row?.user_id ?? null;
}

/** Start a workflow for an entity. Returns the instance id, or null if no active definition / conditions not met. */
export async function startWorkflow(db: Kysely<DB>, input: { code: string; entityType: string; entityId: string; initiatedBy: string | null; context: Record<string, unknown> }): Promise<string | null> {
  const def = await db.selectFrom('workflow_definitions').selectAll().where('code', '=', input.code).where('is_active', '=', true).orderBy('version', 'desc').executeTakeFirst();
  if (!def) return null;
  const conditions = (def.conditions ?? []) as Condition[];
  if (!conditions.every((c) => evalCondition(c, input.context))) return null;
  const steps = def.steps as StepDef[];
  const applicable = steps.map((s, i) => ({ s, i })).filter(({ s }) => evalCondition(s.condition, input.context));
  const inst = await db.insertInto('workflow_instances').values({ definition_id: def.id, entity_type: input.entityType, entity_id: input.entityId, status: applicable.length ? 'IN_PROGRESS' : 'APPROVED', current_step: applicable[0]?.i ?? 0, context: JSON.stringify(input.context), initiated_by: input.initiatedBy, completed_at: applicable.length ? null : new Date() }).returning('id').executeTakeFirstOrThrow();
  if (applicable.length) await createTask(db, inst.id, applicable[0]!.i, applicable[0]!.s, input.context);
  else await applyActions(db, def.actions as ActionDef[], input.entityType, input.entityId, 'APPROVED');
  return inst.id;
}

async function createTask(db: Kysely<DB>, instanceId: string, stepIndex: number, step: StepDef, ctx: Record<string, unknown>) {
  let assignee: string | null = null, role: string | null = null;
  if (step.approverType === 'MANAGER') {
    assignee = await managerUserIdFor(db, ctx.employeeId as string | undefined);
    if (!assignee) role = 'HR_ADMIN'; // fallback when no manager with a login exists
  } else if (step.approverType === 'ROLE') role = step.roleCode ?? null;
  else assignee = step.userId ?? null;
  const task = await db.insertInto('workflow_tasks').values({ instance_id: instanceId, step_index: stepIndex, step_key: step.key, assignee_user_id: assignee, assignee_role_code: role, due_at: new Date(Date.now() + 3 * 864e5) }).returning('id').executeTakeFirstOrThrow();
  // Notify assignees (in-app)
  const targets = assignee ? [assignee] : role ? (await db.selectFrom('user_roles').innerJoin('roles', 'roles.id', 'user_roles.role_id').select('user_roles.user_id').where('roles.code', '=', role).execute()).map((u) => u.user_id) : [];
  for (const uid of targets) await db.insertInto('notifications').values({ user_id: uid, type: 'approval.pending', title: 'Approval required', body: `Step "${step.key}" is waiting for your decision`, link: `/approvals/${task.id}`, payload: JSON.stringify({ taskId: task.id, instanceId }) }).execute();
  return task.id;
}

async function applyActions(db: Kysely<DB>, actions: ActionDef[], entityType: string, entityId: string, outcome: 'APPROVED' | 'REJECTED') {
  for (const a of actions) {
    const value = outcome === 'APPROVED' ? a.onApprove : a.onReject;
    if (!value) continue;
    if (a.type === 'set_status') {
      const table = ({ overtime_request: 'overtime_requests', leave_request: 'leave_requests', attendance_correction: 'attendance_corrections', employee_salary_structure: null, payroll_adjustment: 'payroll_adjustments' } as Record<string, string | null>)[entityType];
      if (table) await (db as any).updateTable(table).set({ status: value, ...(table !== 'attendance_corrections' && table !== 'payroll_adjustments' ? { decided_at: new Date() } : {}), ...(table === 'attendance_corrections' && value === 'APPROVED' ? { approved_at: new Date() } : {}) }).where('id', '=', entityId).execute();
    }
    // transition_employee handled by the employees module listener (see decideTask) to keep lifecycle logic in one place
  }
}

export interface DecideInput { taskId: string; userId: string; userRoles: string[]; decision: 'APPROVED' | 'REJECTED'; comment?: string }

/** Approve/reject a task; advance to next applicable step or complete. Returns { instanceStatus, entityType, entityId }. */
export async function decideTask(db: Kysely<DB>, input: DecideInput): Promise<{ instanceStatus: string; entityType: string; entityId: string; actions: ActionDef[]; sideEffects: string[] }> {
  return db.transaction().execute(async (trx) => {
    const task = await trx.selectFrom('workflow_tasks').selectAll().where('id', '=', input.taskId).forUpdate().executeTakeFirst();
    if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
    if (task.status !== 'PENDING') throw Object.assign(new Error('Task already decided'), { statusCode: 409 });
    const allowed = task.assignee_user_id === input.userId || (task.assignee_role_code && input.userRoles.includes(task.assignee_role_code)) || input.userRoles.includes('SUPER_ADMIN');
    if (!allowed) throw Object.assign(new Error('You are not an assignee of this task'), { statusCode: 403 });
    await trx.updateTable('workflow_tasks').set({ status: input.decision, decided_by: input.userId, decided_at: new Date(), comment: input.comment ?? null }).where('id', '=', task.id).execute();
    const inst = await trx.selectFrom('workflow_instances').selectAll().where('id', '=', task.instance_id).forUpdate().executeTakeFirstOrThrow();
    const def = await trx.selectFrom('workflow_definitions').selectAll().where('id', '=', inst.definition_id).executeTakeFirstOrThrow();
    const steps = def.steps as StepDef[];
    const actions = def.actions as ActionDef[];
    const ctx = inst.context as Record<string, unknown>;
    const sideEffects: string[] = [];
    if (input.decision === 'REJECTED') {
      await trx.updateTable('workflow_instances').set({ status: 'REJECTED', completed_at: new Date() }).where('id', '=', inst.id).execute();
      await trx.updateTable('workflow_tasks').set({ status: 'CANCELLED' }).where('instance_id', '=', inst.id).where('status', '=', 'PENDING').execute();
      await applyActions(trx, actions, inst.entity_type, inst.entity_id, 'REJECTED');
      if (inst.initiated_by) await trx.insertInto('notifications').values({ user_id: inst.initiated_by, type: 'approval.rejected', title: 'Request rejected', body: input.comment ?? null, link: null }).execute();
      return { instanceStatus: 'REJECTED', entityType: inst.entity_type, entityId: inst.entity_id, actions, sideEffects };
    }
    const next = steps.map((s, i) => ({ s, i })).find(({ s, i }) => i > task.step_index && evalCondition(s.condition, ctx));
    if (next) {
      await trx.updateTable('workflow_instances').set({ current_step: next.i }).where('id', '=', inst.id).execute();
      await createTask(trx, inst.id, next.i, next.s, ctx);
      return { instanceStatus: 'IN_PROGRESS', entityType: inst.entity_type, entityId: inst.entity_id, actions, sideEffects };
    }
    await trx.updateTable('workflow_instances').set({ status: 'APPROVED', completed_at: new Date() }).where('id', '=', inst.id).execute();
    await applyActions(trx, actions, inst.entity_type, inst.entity_id, 'APPROVED');
    if (inst.initiated_by) await trx.insertInto('notifications').values({ user_id: inst.initiated_by, type: 'approval.approved', title: 'Request approved', body: null, link: null }).execute();
    return { instanceStatus: 'APPROVED', entityType: inst.entity_type, entityId: inst.entity_id, actions, sideEffects };
  });
}
