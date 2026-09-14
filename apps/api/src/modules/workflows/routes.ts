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
  r.post('/definitions', { preHandler: requirePermission('workflows:write'), schema: { tags: ['workflows'], summary: 'Create a new version of a workflow definition', body: z.object({ code: z.string().min(1), name: z.string().min(1), entityType: z.string().min(1), trigger: z.record(z.unknown()), conditions: z.array(z.unknown()).default([]), steps: z.array(z.object({ key: z.string(), approverType: z.enum(['MANAGER', 'ROLE', 'USER']), roleCode: z.string().optional(), userId: z.string().uuid().optional(), condition: z.object({ field: z.string(), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']), value: z.unknown() }).optional() })).min(1), actions: z.array(z.unknown()).default([]) }), response: { 201: defOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const prev = await app.db.selectFrom('workflow_definitions').select('version').where('code', '=', req.body.code).orderBy('version', 'desc').executeTakeFirst();
    await app.db.updateTable('workflow_definitions').set({ is_active: false }).where('code', '=', req.body.code).execute();
    const d = await app.db.insertInto('workflow_definitions').values({ code: req.body.code, version: (prev?.version ?? 0) + 1, name: req.body.name, entity_type: req.body.entityType, trigger: JSON.stringify(req.body.trigger), conditions: JSON.stringify(req.body.conditions), steps: JSON.stringify(req.body.steps), actions: JSON.stringify(req.body.actions), created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'workflow.definition.create', entityType: 'workflow_definition', entityId: d.id, newValue: req.body });
    return reply.status(201).send({ id: d.id, code: d.code, version: d.version, name: d.name, entityType: d.entity_type, trigger: d.trigger, conditions: d.conditions, steps: d.steps, actions: d.actions, isActive: d.is_active });
  });

  const taskQuery = () => app.db.selectFrom('workflow_tasks as t').innerJoin('workflow_instances as i', 'i.id', 't.instance_id').innerJoin('workflow_definitions as d', 'd.id', 'i.definition_id').selectAll('t').select(['d.code as wf_code', 'd.name as wf_name', 'i.entity_type', 'i.entity_id', 'i.context', 'i.initiated_by']);
  const taskMap = async (t: Record<string, any>) => {
    const empId = (t.context as any)?.employeeId ?? (t.entity_type === 'employee' ? t.entity_id : null);
    const emp = empId ? await app.db.selectFrom('employees').select(['id', 'employee_no', 'full_name_en']).where('id', '=', empId).executeTakeFirst() : null;
    return { id: t.id, instanceId: t.instance_id, stepKey: t.step_key, status: t.status, assigneeUserId: t.assignee_user_id, assigneeRole: t.assignee_role_code, dueAt: t.due_at ? new Date(t.due_at).toISOString() : null, createdAt: new Date(t.created_at).toISOString(), workflowCode: t.wf_code, workflowName: t.wf_name, entityType: t.entity_type, entityId: t.entity_id, context: t.context ?? {}, initiatedBy: t.initiated_by, employee: emp ? { id: emp.id, employeeNo: emp.employee_no, name: emp.full_name_en } : null };
  };
  r.get('/tasks/mine', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'My pending approvals (assigned to me or my roles). all=true (workflows:write) lists every pending task.', querystring: paginationQuery.merge(z.object({ all: z.coerce.boolean().default(false) })), response: { 200: paginated(taskOut) } } }, async (req) => {
    const p = requireAuth(req);
    let base = taskQuery().where('t.status', '=', 'PENDING');
    if (!(req.query.all && p.permissions.has('workflows:write'))) base = base.where((eb) => eb.or([eb('t.assignee_user_id', '=', p.userId), ...(p.roles.length ? [eb('t.assignee_role_code', 'in', p.roles)] : [])]));
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('t.created_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute();
    return { data: await Promise.all(rows.map(taskMap)), meta: pageMeta(req.query, total) };
  });
  r.post('/tasks/:id/decide', { preHandler: requirePermission('workflows:act'), schema: { tags: ['workflows'], summary: 'Approve or reject a task', params: idParam, body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().max(1000).optional() }), response: { 200: z.object({ instanceStatus: z.string(), entityType: z.string(), entityId: z.string() }) } } }, async (req) => {
    const p = requireAuth(req);
    const res = await decideTask(app.db, { taskId: req.params.id, userId: p.userId, userRoles: p.roles, decision: req.body.decision, comment: req.body.comment });
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
      if (res.entityType === 'attendance_correction') { const c = await app.db.selectFrom('attendance_corrections').select(['employee_id', 'attendance_date']).where('id', '=', res.entityId).executeTakeFirst(); if (c) await app.queues.enqueueProcessAffected([{ employeeId: c.employee_id, date: c.attendance_date }]); }
    } else if (res.instanceStatus === 'REJECTED') {
      if (res.entityType === 'leave_request') { const { applyLeaveDecision } = await import('../leave/service.js'); await applyLeaveDecision(app, res.entityId, 'REJECTED'); }
    }
    await app.audit(req, { action: `workflow.task.${req.body.decision.toLowerCase()}`, entityType: res.entityType, entityId: res.entityId, newValue: { taskId: req.params.id, comment: req.body.comment }, approvalRef: req.params.id });
    return { instanceStatus: res.instanceStatus, entityType: res.entityType, entityId: res.entityId };
  });
  r.get('/instances/:id', { preHandler: requirePermission('workflows:read', 'workflows:act'), schema: { tags: ['workflows'], summary: 'Workflow instance with its tasks', params: idParam, response: { 200: z.object({ id: z.string(), status: z.string(), workflowCode: z.string(), entityType: z.string(), entityId: z.string(), context: z.record(z.unknown()), createdAt: z.string(), completedAt: z.string().nullable(), tasks: z.array(z.object({ id: z.string(), stepKey: z.string(), status: z.string(), assigneeRole: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), comment: z.string().nullable() })) }) } } }, async (req) => {
    const i = await app.db.selectFrom('workflow_instances as i').innerJoin('workflow_definitions as d', 'd.id', 'i.definition_id').selectAll('i').select('d.code').where('i.id', '=', req.params.id).executeTakeFirstOrThrow();
    const tasks = await app.db.selectFrom('workflow_tasks as t').leftJoin('users as u', 'u.id', 't.decided_by').selectAll('t').select('u.display_name').where('t.instance_id', '=', i.id).orderBy('t.step_index').execute();
    return { id: i.id, status: i.status, workflowCode: i.code, entityType: i.entity_type, entityId: i.entity_id, context: (i.context ?? {}) as Record<string, unknown>, createdAt: new Date(i.created_at).toISOString(), completedAt: i.completed_at ? new Date(i.completed_at).toISOString() : null, tasks: tasks.map((t) => ({ id: t.id, stepKey: t.step_key, status: t.status, assigneeRole: t.assignee_role_code, decidedBy: t.display_name ?? null, decidedAt: t.decided_at ? new Date(t.decided_at).toISOString() : null, comment: t.comment })) };
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
