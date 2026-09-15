import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { forbidden, notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission, resolveScope } from '../../plugins/rbac.js';
import { teamEmployeeIds } from '../employees/service.js';
import { HR_REQUEST_TYPES, WORKFLOW_CODE, applyHrRequest, createHrRequest, describeChanges, type HrRequestType } from './service.js';

const requestOut = z.object({
  id: z.string(), requestNo: z.string(), type: z.string(), title: z.string(), status: z.string(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), designation: z.string().nullable(), department: z.string().nullable() }),
  effectiveDate: z.string().nullable(), reason: z.string().nullable(), requestedBy: z.string().nullable(), requestedAt: z.string(), decidedAt: z.string().nullable(), appliedAt: z.string().nullable(), applyError: z.string().nullable(),
  workflowInstanceId: z.string().nullable(), currentStep: z.string().nullable(), changes: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
});
const requestDetail = requestOut.extend({ payload: z.record(z.unknown()), before: z.record(z.unknown()).nullable(), result: z.record(z.unknown()).nullable(), tasks: z.array(z.object({ id: z.string(), stepKey: z.string(), status: z.string(), assigneeRole: z.string().nullable(), assigneeUserId: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), comment: z.string().nullable() })) });

/** Payload fields that must never leave the API for callers without compensation/disciplinary rights. */
const RESTRICTED_TYPES = new Set(['SALARY_CHANGE', 'INCREMENT', 'PROMOTION', 'LOAN', 'ADVANCE', 'BONUS', 'DEDUCTION', 'DISCIPLINARY', 'TERMINATION']);

export const hrRequestRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const base = () => app.db.selectFrom('hr_requests as h').innerJoin('employees as e', 'e.id', 'h.employee_id').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('users as u', 'u.id', 'h.requested_by')
    .selectAll('h').select(['e.employee_no', 'e.full_name_en', 'g.title as designation', 'd.name as department', 'u.display_name as requested_by_name']);

  async function currentStep(instanceId: string | null): Promise<string | null> {
    if (!instanceId) return null;
    const t = await app.db.selectFrom('workflow_tasks').select('step_key').where('instance_id', '=', instanceId).where('status', '=', 'PENDING').orderBy('step_index').executeTakeFirst();
    return t?.step_key ?? null;
  }
  const canSeeRestricted = (p: ReturnType<typeof requireAuth>) => hasPermission(p, 'compensation:read') || hasPermission(p, 'disciplinary:read');
  const mapRow = async (x: any, p: ReturnType<typeof requireAuth>) => {
    const own = p.employeeId === x.employee_id;
    const changes = RESTRICTED_TYPES.has(x.request_type) && !canSeeRestricted(p) && !own ? [] : describeChanges(x);
    return {
      id: x.id, requestNo: x.request_no, type: x.request_type, title: x.title, status: x.status, employee: { id: x.employee_id, employeeNo: x.employee_no, name: x.full_name_en, designation: x.designation, department: x.department },
      effectiveDate: x.effective_date, reason: x.reason, requestedBy: x.requested_by_name, requestedAt: new Date(x.created_at).toISOString(), decidedAt: x.decided_at ? new Date(x.decided_at).toISOString() : null, appliedAt: x.applied_at ? new Date(x.applied_at).toISOString() : null,
      applyError: x.apply_error, workflowInstanceId: x.workflow_instance_id, currentStep: await currentStep(x.workflow_instance_id), changes,
    };
  };

  r.get('/types', { preHandler: requirePermission('requests:create:own', 'requests:create:any', 'requests:read', 'requests:read:team', 'requests:read:own'), schema: { tags: ['hr-requests'], summary: 'Request types with their approval chains', response: { 200: z.array(z.object({ type: z.string(), workflowCode: z.string(), steps: z.array(z.string()), autoApply: z.boolean() })) } } }, async () => {
    const defs = await app.db.selectFrom('workflow_definitions').select(['code', 'steps']).where('is_active', '=', true).where('entity_type', '=', 'hr_request').execute();
    const byCode = new Map(defs.map((d) => [d.code, (d.steps as { key: string }[]).map((s) => s.key)]));
    return HR_REQUEST_TYPES.map((t) => { const code = WORKFLOW_CODE[t] ?? t; return { type: t, workflowCode: code, steps: byCode.get(code) ?? [], autoApply: !byCode.has(code) }; });
  });

  r.get('/', { preHandler: requirePermission('requests:read', 'requests:read:team', 'requests:read:own'), schema: { tags: ['hr-requests'], summary: 'HR requests (scoped)', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), type: z.string().optional(), status: z.string().optional(), q: z.string().optional() })), response: { 200: paginated(requestOut) } } }, async (req) => {
    const p = requireAuth(req);
    const scope = resolveScope(p, 'requests');
    let q = base();
    if (scope === 'own') q = q.where('h.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    else if (scope === 'team') q = q.where('h.employee_id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (scope !== 'all' && !canSeeRestricted(p)) q = q.where((eb) => eb.or([eb('h.request_type', 'not in', [...RESTRICTED_TYPES]), eb('h.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000')]));
    if (req.query.employeeId) q = q.where('h.employee_id', '=', req.query.employeeId);
    if (req.query.type) q = q.where('h.request_type', '=', req.query.type.toUpperCase());
    if (req.query.status) q = q.where('h.status', '=', req.query.status.toUpperCase());
    if (req.query.q) q = q.where((eb) => eb.or([eb('h.request_no', 'ilike', `%${req.query.q}%`), eb('h.title', 'ilike', `%${req.query.q}%`), eb('e.full_name_en', 'ilike', `%${req.query.q}%`), eb('e.employee_no', 'ilike', `%${req.query.q}%`)]));
    const total = Number((await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await q.orderBy('h.created_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute();
    return { data: await Promise.all(rows.map((x) => mapRow(x, p))), meta: pageMeta(req.query, total) };
  });

  r.get('/:id', { preHandler: requirePermission('requests:read', 'requests:read:team', 'requests:read:own', 'workflows:act'), schema: { tags: ['hr-requests'], summary: 'HR request detail with what-changed and approval trail', params: idParam, response: { 200: requestDetail, 404: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const x = await base().where('h.id', '=', req.params.id).executeTakeFirst();
    if (!x) throw notFound('HR request', req.params.id);
    const scope = resolveScope(p, 'requests');
    const own = p.employeeId === x.employee_id;
    // Approvers may open the request they are asked to decide on even without requests:read.
    const isApprover = x.workflow_instance_id ? !!(await app.db.selectFrom('workflow_tasks').select('id').where('instance_id', '=', x.workflow_instance_id).where((eb) => eb.or([eb('assignee_user_id', '=', p.userId), ...(p.roles.length ? [eb('assignee_role_code', 'in', p.roles)] : [])])).executeTakeFirst()) : false;
    if (scope === 'none' && !isApprover) throw forbidden();
    if (scope === 'own' && !own && !isApprover) throw forbidden();
    if (scope === 'team' && !own && !isApprover && !(await teamEmployeeIds(app.db, p)).includes(x.employee_id)) throw forbidden();
    const hide = RESTRICTED_TYPES.has(x.request_type) && !canSeeRestricted(p) && !own && !isApprover;
    const tasks = x.workflow_instance_id ? await app.db.selectFrom('workflow_tasks as t').leftJoin('users as u', 'u.id', 't.decided_by').selectAll('t').select('u.display_name').where('t.instance_id', '=', x.workflow_instance_id).orderBy('t.step_index').execute() : [];
    return { ...(await mapRow(x, p)), payload: hide ? {} : (x.payload as Record<string, unknown>), before: hide ? null : (x.before_snapshot as Record<string, unknown> | null), result: hide ? null : (x.result as Record<string, unknown> | null), tasks: tasks.map((t) => ({ id: t.id, stepKey: t.step_key, status: t.status, assigneeRole: t.assignee_role_code, assigneeUserId: t.assignee_user_id, decidedBy: t.display_name ?? null, decidedAt: t.decided_at ? new Date(t.decided_at).toISOString() : null, comment: t.comment })) };
  });

  const createBody = z.object({ type: z.enum(HR_REQUEST_TYPES), employeeId: z.string().uuid(), title: z.string().max(200).optional(), payload: z.record(z.unknown()).default({}), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reason: z.string().max(2000).optional() });
  r.post('/', { preHandler: requirePermission('requests:create:any', 'requests:create:own'), schema: { tags: ['hr-requests'], summary: 'Create an HR request (starts its approval workflow; applied automatically on approval)', body: createBody, response: { 201: z.object({ id: z.string(), requestNo: z.string(), status: z.string(), workflowInstanceId: z.string().nullable() }), 400: errorSchema, 403: errorSchema, 422: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const b = req.body;
    if (!hasPermission(p, 'requests:create:any')) {
      if (p.employeeId !== b.employeeId) throw forbidden('You can only raise requests for yourself');
      if (!['LETTER', 'DOCUMENT', 'LOAN', 'ADVANCE', 'TRAINING', 'RESIGNATION', 'OTHER'].includes(b.type)) throw forbidden(`Employees cannot raise ${b.type} requests`);
    }
    if (['PROMOTION', 'TRANSFER', 'SALARY_CHANGE', 'INCREMENT', 'BONUS', 'DEDUCTION'].includes(b.type) && !hasPermission(p, 'compensation:write') && !hasPermission(p, 'employees:update')) throw forbidden(`${b.type} requests need compensation:write`);
    if (b.type === 'DISCIPLINARY' && !hasPermission(p, 'disciplinary:write')) throw forbidden('DISCIPLINARY requests need disciplinary:write');
    if (b.type === 'TERMINATION' && !hasPermission(p, 'employees:transition')) throw forbidden('TERMINATION requests need employees:transition');
    const res = await createHrRequest(app, { type: b.type as HrRequestType, employeeId: b.employeeId, title: b.title, payload: b.payload as Record<string, any>, effectiveDate: b.effectiveDate, reason: b.reason, requestedBy: p.userId });
    await app.audit(req, { action: `hr_request.${b.type.toLowerCase()}.create`, entityType: 'hr_request', entityId: res.id, newValue: { employeeId: b.employeeId, requestNo: res.requestNo, effectiveDate: b.effectiveDate, ...(RESTRICTED_TYPES.has(b.type) ? {} : { payload: b.payload }) }, reason: b.reason, approvalRef: res.workflowInstanceId });
    return reply.status(201).send(res);
  });

  r.post('/:id/cancel', { preHandler: requirePermission('requests:create:any', 'requests:create:own'), schema: { tags: ['hr-requests'], summary: 'Cancel a pending request (requester or HR)', params: idParam, body: z.object({ reason: z.string().max(500).optional() }).default({}), response: { 200: z.object({ status: z.string() }), 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const x = await app.db.selectFrom('hr_requests').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!x) throw notFound('HR request', req.params.id);
    if (x.requested_by !== p.userId && !hasPermission(p, 'requests:create:any')) throw forbidden();
    if (x.status !== 'PENDING') throw unprocessable(`Request is ${x.status}; only PENDING requests can be cancelled`);
    await app.db.transaction().execute(async (trx) => {
      await trx.updateTable('hr_requests').set({ status: 'CANCELLED', decided_by: p.userId, decided_at: new Date() }).where('id', '=', x.id).execute();
      if (x.workflow_instance_id) { await trx.updateTable('workflow_instances').set({ status: 'CANCELLED', completed_at: new Date() }).where('id', '=', x.workflow_instance_id).execute(); await trx.updateTable('workflow_tasks').set({ status: 'CANCELLED' }).where('instance_id', '=', x.workflow_instance_id).where('status', '=', 'PENDING').execute(); }
    });
    await app.audit(req, { action: 'hr_request.cancel', entityType: 'hr_request', entityId: x.id, reason: req.body.reason });
    return { status: 'CANCELLED' };
  });

  r.post('/:id/apply', { preHandler: requirePermission('config:write'), schema: { tags: ['hr-requests'], summary: 'Re-apply an APPROVED/FAILED request (after fixing the cause)', params: idParam, response: { 200: z.object({ status: z.string(), error: z.string().optional() }), 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const x = await app.db.selectFrom('hr_requests').select('status').where('id', '=', req.params.id).executeTakeFirst();
    if (!x) throw notFound('HR request', req.params.id);
    if (x.status === 'FAILED') await app.db.updateTable('hr_requests').set({ status: 'APPROVED' }).where('id', '=', req.params.id).execute();
    const res = await applyHrRequest(app, req.params.id, p.userId);
    await app.audit(req, { action: 'hr_request.reapply', entityType: 'hr_request', entityId: req.params.id, newValue: { status: res.status } });
    return { status: res.status, error: res.error };
  });
};
