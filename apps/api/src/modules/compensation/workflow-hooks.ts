import type { FastifyInstance } from 'fastify';
import type { Principal } from '../../plugins/auth.js';
import { forbidden } from '../../plugins/errors.js';
import type { StepDef } from '../workflows/service.js';
import { loadPolicy } from './policy.js';
import { logApproval } from './service.js';
import { completeReview } from './reviews.service.js';

/**
 * Glue between the generic workflow engine and compensation entities:
 *   • before a decision: segregation of duties (the preparer/submitter may not approve their own compensation request),
 *   • after a decision: the entity status follows the step (statusOnApprove, or a role-based default) and an immutable
 *     compensation_approval_actions row records user, role, action, comment, previous → new status.
 */
const ROLE_STATUS: Record<string, string> = { HR_MANAGER: 'HR_APPROVED', HR_ADMIN: 'HR_APPROVED', FINANCE: 'FINANCE_APPROVED', FINANCE_MANAGER: 'FINANCE_APPROVED', MANAGEMENT: 'MANAGEMENT_APPROVED' };
export const stepStatus = (s: StepDef | undefined): string => s?.statusOnApprove ?? (s?.roleCode ? ROLE_STATUS[s.roleCode] : undefined) ?? 'UNDER_REVIEW';

type Target = { kind: 'change'; id: string; promotionId: string | null; status: string; requestedBy: string | null } | { kind: 'review'; id: string; status: string; requestedBy: string[] };
async function targetFor(app: FastifyInstance, entityType: string, entityId: string): Promise<Target | null> {
  if (entityType === 'hr_request') {
    const c = await app.db.selectFrom('salary_changes').select(['id', 'status', 'promotion_request_id', 'requested_by']).where('hr_request_id', '=', entityId).where('source', 'in', ['COMPENSATION', 'PROMOTION']).executeTakeFirst();
    return c ? { kind: 'change', id: c.id, promotionId: c.promotion_request_id, status: c.status, requestedBy: c.requested_by } : null;
  }
  if (entityType === 'salary_review') {
    const r = await app.db.selectFrom('salary_reviews').select(['id', 'status', 'created_by', 'submitted_by']).where('id', '=', entityId).executeTakeFirst();
    return r ? { kind: 'review', id: r.id, status: r.status, requestedBy: [r.created_by, r.submitted_by].filter(Boolean) as string[] } : null;
  }
  return null;
}

export async function assertCompensationDecisionAllowed(app: FastifyInstance, taskId: string, p: Principal): Promise<void> {
  const t = await app.db.selectFrom('workflow_tasks as t').innerJoin('workflow_instances as i', 'i.id', 't.instance_id').select(['i.entity_type', 'i.entity_id']).where('t.id', '=', taskId).executeTakeFirst();
  if (!t) return;
  const target = await targetFor(app, t.entity_type, t.entity_id);
  if (!target || !(await loadPolicy(app.db)).segregationOfDuties) return;
  const owners = target.kind === 'change' ? [target.requestedBy] : target.requestedBy;
  if (owners.includes(p.userId)) throw forbidden('Segregation of duties: you cannot approve a compensation request you prepared or submitted');
}

export async function recordCompensationDecision(app: FastifyInstance, d: { taskId: string; principal: Principal; decision: 'APPROVED' | 'REJECTED'; comment: string | null; instanceStatus: string; entityType: string; entityId: string }): Promise<void> {
  const target = await targetFor(app, d.entityType, d.entityId);
  if (!target) return;
  const task = await app.db.selectFrom('workflow_tasks as t').innerJoin('workflow_instances as i', 'i.id', 't.instance_id').innerJoin('workflow_definitions as w', 'w.id', 'i.definition_id')
    .select(['t.step_index', 't.step_key', 't.assignee_role_code', 'w.steps']).where('t.id', '=', d.taskId).executeTakeFirstOrThrow();
  const step = (task.steps as StepDef[])[task.step_index];
  const role = task.assignee_role_code ?? (step?.approverType === 'MANAGER' ? 'LINE_MANAGER' : d.principal.roles[0] ?? null);
  const newStatus = d.decision === 'REJECTED' ? 'REJECTED' : stepStatus(step);
  const final = d.instanceStatus === 'APPROVED';
  await app.db.transaction().execute(async (trx) => {
    if (target.kind === 'change') {
      await trx.updateTable('salary_changes').set({ status: newStatus, ...(final ? { approved_by: d.principal.userId, approved_at: new Date() } : {}) }).where('id', '=', target.id).execute();
      if (target.promotionId) await trx.updateTable('promotion_requests').set({ status: newStatus, ...(final ? { approved_by: d.principal.userId, approved_at: new Date() } : {}) }).where('id', '=', target.promotionId).execute();
    } else {
      await trx.updateTable('salary_reviews').set({ status: newStatus, ...(final ? { approved_by: d.principal.userId, approved_at: new Date() } : {}), ...(d.decision === 'REJECTED' ? { decision_comment: d.comment } : {}) }).where('id', '=', target.id).execute();
    }
    await logApproval(trx, { entityType: target.kind === 'review' ? 'salary_review' : target.promotionId ? 'promotion_request' : 'salary_change', entityId: target.kind === 'change' ? target.promotionId ?? target.id : target.id,
      userId: d.principal.userId, userName: d.principal.displayName, roleCode: role, action: d.decision === 'APPROVED' ? (final ? 'FINAL_APPROVE' : 'APPROVE') : 'REJECT', stepKey: task.step_key, comment: d.comment, previousStatus: target.status, newStatus, taskId: d.taskId });
    await app.audit(null, { action: `compensation.${target.kind === 'review' ? 'review' : 'change'}.${d.decision === 'APPROVED' ? 'approve' : 'reject'}`, entityType: target.kind === 'review' ? 'salary_review' : 'salary_change', entityId: target.id, oldValue: { status: target.status }, newValue: { status: newStatus, step: task.step_key, role, final }, reason: d.comment, approvalRef: d.taskId, metadata: { userId: d.principal.userId } }, 'api', trx);
  });
}

export async function onSalaryReviewApproved(app: FastifyInstance, reviewId: string, userId: string): Promise<void> {
  try { await completeReview(app, reviewId, userId); }
  catch (e) { app.log.warn({ err: e, reviewId }, 'salary review completion deferred'); /* retried via POST /compensation/reviews/:id/complete */ }
}
