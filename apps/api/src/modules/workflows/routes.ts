import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { decideTask } from './service.js';
import { transitionEmployee } from '../employees/service.js';

const taskOut = z.object({ id: z.string(), instanceId: z.string(), stepKey: z.string(), status: z.string(), assigneeUserId: z.string().nullable(), assigneeRole: z.string().nullable(), dueAt: z.string().nullable(), createdAt: z.string(), workflowCode: z.string(), workflowName: z.string(), entityType: z.string(), entityId: z.string(), context: z.record(z.unknown()), initiatedBy: z.string().nullable(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string() }).nullable() });

export const workflowRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const defOut = z.object({ id: z.string(), code: z.string(), version: z.number(), name: z.string(), entityType: z.string(), trigger: z.unknown(), conditions: z.unknown(), steps: z.unknown(), actions: z.unknown(), isActive: z.boolean() });
  r.get('/definitions', { preHandler: requirePermission('workflows:read'), schema: { tags: ['workflows'], summary: 'Workflow definitions', response: { 200: z.array(defOut) } } }, async () => (await app.db.selectFrom('workflow_definitions').selectAll().orderBy('code').orderBy('version', 'desc').execute()).map((d) => ({ id: d.id, code: d.code, version: d.version, name: d.name, entityType: d.entity_type, trigger: d.trigger, conditions: d.conditions, steps: d.steps, actions: d.actions, isActive: d.is_active })));
  r.post('/definitions', { preHandler: requirePermission('workflows:write'), schema: { tags: ['workflows'], summary: 'Create a new version of a workflow definition', body: z.object({ code: z.string().min(1), name: z.string().min(1), entityType: z.string().min(1), trigger: z.record(z.unknown()), conditions: z.array(z.unknown()).default([]), steps: z.array(z.object({ key: z.string(), approverType: z.enum(['MANAGER', 'ROLE', 'USER']), roleCode: z.string().optional(), userId: z.string().uuid().optional(), condition: z.object({ field: z.string(), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']), value: z.unknown() }).optional(), statusOnApprove: z.string().max(40).optional() })).min(1), actions: z.array(z.unknown()).default([]) }), response: { 201: defOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const prev = await app.db.selectFrom('workflow_definitions').select('version').where('code', '=', req.body.code).orderBy('version', 'desc').executeTakeFirst();
    await app.db.updateTable('workflow_definitions').set({ is_active: false }).where('code', '=', req.body.code).execute();
    const d = await app.db.insertInto('workflow_definitions').values({ code: req.body.code, version: (prev?.version ?? 0) + 1, name: req.body.name, entity_type: req.body.entityType, trigger: JSON.stringify(req.body.trigger), conditions: JSON.stringify(req.body.conditions), steps: JSON.stringify(req.body.steps), actions: JSON.stringify(req.body.actions), created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'workflow.definition.create', entityType: 'workflow_definition', entityId: d.id, newValue: req.body });
    return reply.status(201).send({ id: d.id, code: d.code, version: d.version, name: d.name, entityType: d.entity_type, trigger: d.trigger, conditions: d.conditions, steps: d.steps, actions: d.actions, isActive: d.is_active });
  });

  /** Users who currently delegate their approvals to `userId` (workflow_delegations, active and within dates). */
  async function activeDelegatorsFor(userId: string): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    return (await app.db.selectFrom('workflow_delegations').select('from_user_id').where('to_user_id', '=', userId).where('is_active', '=', true).where('from_date', '<=', today).where('to_date', '>=', today).execute()).map((d) => d.from_user_id);
  }
  const taskQuery = () => app.db.selectFrom('workflow_tasks as t').innerJoin('workflow_instances as i', 'i.id', 't.instance_id').innerJoin('workflow_definitions as d', 'd.id', 'i.definition_id').selectAll('t').select(['d.code as wf_code', 'd.name as wf_name', 'i.entity_type', 'i.entity_id', 'i.context', 'i.initiated_by']);
  const taskMap = async (t: Record<string, any>) => {
    const empId = (t.context as any)?.employeeId ?? (t.entity_type === 'employee' ? t.entity_id : null);
    const emp = empId ? await app.db.selectFrom('employees').select(['id', 'employee_no', 'full_name_en']).where('id', '=', empId).executeTakeFirst() : null;
    return { id: t.id, instanceId: t.instance_id, stepKey: t.step_key, status: t.status, assigneeUserId: t.assignee_user_id, assigneeRole: t.assignee_role_code, dueAt: t.due_at ? new Date(t.due_at).toISOString() : null, createdAt: new Date(t.created_at).toISOString(), workflowCode: t.wf_code, workflowName: t.wf_name, entityType: t.entity_type, entityId: t.entity_id, context: t.context ?? {}, initiatedBy: t.initiated_by, employee: emp ? { id: emp.id, employeeNo: emp.employee_no, name: emp.full_name_en } : null };
  };
  r.get('/tasks/mine', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'My pending approvals (assigned to me or my roles). all=true (workflows:write) lists every pending task.', querystring: paginationQuery.merge(z.object({ all: z.coerce.boolean().default(false) })), response: { 200: paginated(taskOut) } } }, async (req) => {
    const p = requireAuth(req);
    let base = taskQuery().where('t.status', '=', 'PENDING');
    if (!(req.query.all && p.permissions.has('workflows:write'))) {
      const delegators = await activeDelegatorsFor(p.userId);
      base = base.where((eb) => eb.or([eb('t.assignee_user_id', 'in', [p.userId, ...delegators]), ...(p.roles.length ? [eb('t.assignee_role_code', 'in', p.roles)] : [])]));
    }
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('t.created_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute();
    return { data: await Promise.all(rows.map(taskMap)), meta: pageMeta(req.query, total) };
  });
  r.post('/tasks/:id/decide', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'Approve or reject a task', params: idParam, body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().max(1000).optional() }), response: { 200: z.object({ instanceStatus: z.string(), entityType: z.string(), entityId: z.string() }) } } }, async (req) => {
    const p = requireAuth(req);
    const comp = await import('../compensation/workflow-hooks.js');
    await comp.assertCompensationDecisionAllowed(app, req.params.id, p);
    const res = await decideTask(app.db, { taskId: req.params.id, userId: p.userId, userRoles: p.roles, decision: req.body.decision, comment: req.body.comment, actingFor: await activeDelegatorsFor(p.userId) });
    // Compensation entities mirror every decision (role, previous → new status) before any side effect runs.
    await comp.recordCompensationDecision(app, { taskId: req.params.id, principal: p, decision: req.body.decision, comment: req.body.comment ?? null, instanceStatus: res.instanceStatus, entityType: res.entityType, entityId: res.entityId });
    // Post-completion hooks that need module services
    if (res.instanceStatus === 'APPROVED') {
      for (const a of res.actions) {
        if (a.type === 'transition_employee' && a.onApprove && res.entityType === 'employee') {
          const emp = await app.db.selectFrom('employees').select('status').where('id', '=', res.entityId).executeTakeFirst();
          if (emp && emp.status === 'RESIGNED') await transitionEmployee(app.db, { employeeId: res.entityId, to: 'CLEARANCE', reason: 'Resignation approved', actorUserId: p.userId });
        }
      }
      if (res.entityType === 'overtime_request') { const { applyApprovedOvertime } = await import('../overtime/service.js'); await applyApprovedOvertime(app.db, res.entityId); }
      if (res.entityType === 'leave_request') { const { applyLeaveDecision } = await import('../leave/service.js'); await applyLeaveDecision(app, res.entityId, 'APPROVED'); }
      if (res.entityType === 'hr_request') { const { applyHrRequest } = await import('../hr-requests/service.js'); await app.db.updateTable('hr_requests').set({ status: 'APPROVED', decided_by: p.userId, decided_at: new Date() }).where('id', '=', res.entityId).where('status', '=', 'PENDING').execute(); await applyHrRequest(app, res.entityId, p.userId); }
      if (res.entityType === 'salary_review') await comp.onSalaryReviewApproved(app, res.entityId, p.userId);
      if (res.entityType === 'attendance_correction') { const c = await app.db.selectFrom('attendance_corrections').select(['employee_id', 'attendance_date']).where('id', '=', res.entityId).executeTakeFirst(); if (c) await app.queues.enqueueProcessAffected([{ employeeId: c.employee_id, date: c.attendance_date }]); }
    } else if (res.instanceStatus === 'REJECTED') {
      if (res.entityType === 'hr_request') { const { rejectHrRequest } = await import('../hr-requests/service.js'); await rejectHrRequest(app.db, res.entityId, p.userId, req.body.comment); }
      if (res.entityType === 'leave_request') { const { applyLeaveDecision } = await import('../leave/service.js'); await applyLeaveDecision(app, res.entityId, 'REJECTED'); }
    }
    void app.queues.add('notifications.deliver', {}).catch(() => undefined);
    await app.audit(req, { action: `workflow.task.${req.body.decision.toLowerCase()}`, entityType: res.entityType, entityId: res.entityId, newValue: { taskId: req.params.id, comment: req.body.comment }, approvalRef: req.params.id });
    return { instanceStatus: res.instanceStatus, entityType: res.entityType, entityId: res.entityId };
  });
  r.get('/instances/:id', { preHandler: requirePermission('workflows:read', 'workflows:act'), schema: { tags: ['workflows'], summary: 'Workflow instance with its tasks', params: idParam, response: { 200: z.object({ id: z.string(), status: z.string(), workflowCode: z.string(), entityType: z.string(), entityId: z.string(), context: z.record(z.unknown()), createdAt: z.string(), completedAt: z.string().nullable(), tasks: z.array(z.object({ id: z.string(), stepKey: z.string(), status: z.string(), assigneeRole: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), comment: z.string().nullable() })) }) } } }, async (req) => {
    const i = await app.db.selectFrom('workflow_instances as i').innerJoin('workflow_definitions as d', 'd.id', 'i.definition_id').selectAll('i').select('d.code').where('i.id', '=', req.params.id).executeTakeFirstOrThrow();
    const tasks = await app.db.selectFrom('workflow_tasks as t').leftJoin('users as u', 'u.id', 't.decided_by').selectAll('t').select('u.display_name').where('t.instance_id', '=', i.id).orderBy('t.step_index').execute();
    return { id: i.id, status: i.status, workflowCode: i.code, entityType: i.entity_type, entityId: i.entity_id, context: (i.context ?? {}) as Record<string, unknown>, createdAt: new Date(i.created_at).toISOString(), completedAt: i.completed_at ? new Date(i.completed_at).toISOString() : null, tasks: tasks.map((t) => ({ id: t.id, stepKey: t.step_key, status: t.status, assigneeRole: t.assignee_role_code, decidedBy: t.display_name ?? null, decidedAt: t.decided_at ? new Date(t.decided_at).toISOString() : null, comment: t.comment })) };
  });

  // Delegation of approvals (out of office)
  const delegOut = z.object({ id: z.string(), fromUserId: z.string(), fromUser: z.string().nullable(), toUserId: z.string(), toUser: z.string().nullable(), fromDate: z.string(), toDate: z.string(), reason: z.string().nullable(), isActive: z.boolean() });
  const delegMap = (d: any) => ({ id: d.id, fromUserId: d.from_user_id, fromUser: d.from_name ?? null, toUserId: d.to_user_id, toUser: d.to_name ?? null, fromDate: d.from_date, toDate: d.to_date, reason: d.reason, isActive: d.is_active });
  const delegQ = () => app.db.selectFrom('workflow_delegations as w').leftJoin('users as f', 'f.id', 'w.from_user_id').leftJoin('users as t', 't.id', 'w.to_user_id').selectAll('w').select(['f.display_name as from_name', 't.display_name as to_name']);
  r.get('/delegations', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'My delegations (given and received); all=true with delegation:manage', querystring: z.object({ all: z.coerce.boolean().default(false) }), response: { 200: z.array(delegOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = delegQ();
    if (!(req.query.all && p.permissions.has('delegation:manage'))) q = q.where((eb) => eb.or([eb('w.from_user_id', '=', p.userId), eb('w.to_user_id', '=', p.userId)]));
    return (await q.orderBy('w.from_date', 'desc').execute()).map(delegMap);
  });
  r.post('/delegations', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'Delegate my approvals to another user for a period (delegation:manage may delegate on behalf of others)', body: z.object({ fromUserId: z.string().uuid().optional(), toUserId: z.string().uuid(), fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(500).optional() }), response: { 201: delegOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const from = req.body.fromUserId && p.permissions.has('delegation:manage') ? req.body.fromUserId : p.userId;
    if (from === req.body.toUserId) throw app.httpErrors.badRequest('Cannot delegate to yourself');
    const d = await app.db.insertInto('workflow_delegations').values({ from_user_id: from, to_user_id: req.body.toUserId, from_date: req.body.fromDate, to_date: req.body.toDate, reason: req.body.reason ?? null }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'workflow.delegation.create', entityType: 'workflow_delegation', entityId: d.id, newValue: { from, ...req.body } });
    return reply.status(201).send(delegMap(await delegQ().where('w.id', '=', d.id).executeTakeFirstOrThrow()));
  });
  r.delete('/delegations/:id', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'Revoke a delegation', params: idParam, response: { 204: z.null() } } }, async (req, reply) => {
    const p = requireAuth(req);
    const d = await app.db.selectFrom('workflow_delegations').select('from_user_id').where('id', '=', req.params.id).executeTakeFirst();
    if (!d) throw app.httpErrors.notFound('Delegation not found');
    if (d.from_user_id !== p.userId && !p.permissions.has('delegation:manage')) throw app.httpErrors.forbidden();
    await app.db.updateTable('workflow_delegations').set({ is_active: false }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'workflow.delegation.revoke', entityType: 'workflow_delegation', entityId: req.params.id });
    return reply.status(204).send(null);
  });

  // Notifications (in-app)
  r.get('/notifications', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'My notifications', querystring: z.object({ unreadOnly: z.coerce.boolean().default(false) }), response: { 200: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), body: z.string().nullable(), link: z.string().nullable(), readAt: z.string().nullable(), createdAt: z.string() })) } } }, async (req) => {
    const p = requireAuth(req);
    let q = app.db.selectFrom('notifications').selectAll().where('user_id', '=', p.userId).where('channel', '=', 'IN_APP');
    if (req.query.unreadOnly) q = q.where('read_at', 'is', null);
    return (await q.orderBy('created_at', 'desc').limit(100).execute()).map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, readAt: n.read_at ? new Date(n.read_at).toISOString() : null, createdAt: new Date(n.created_at).toISOString() }));
  });
  r.post('/notifications/read', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'Mark notifications read', body: z.object({ ids: z.array(z.string().uuid()).optional() }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const p = requireAuth(req);
    let q = app.db.updateTable('notifications').set({ read_at: new Date() }).where('user_id', '=', p.userId).where('read_at', 'is', null);
    if (req.body.ids?.length) q = q.where('id', 'in', req.body.ids);
    await q.execute();
    return { ok: true };
  });
};
