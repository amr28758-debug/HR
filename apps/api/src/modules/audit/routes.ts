import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { requirePermission } from '../../plugins/rbac.js';

const out = z.object({ id: z.number(), occurredAt: z.string(), actorUserId: z.string().nullable(), actorLabel: z.string().nullable(), action: z.string(), entityType: z.string(), entityId: z.string().nullable(), oldValue: z.unknown().nullable(), newValue: z.unknown().nullable(), reason: z.string().nullable(), ipAddress: z.string().nullable(), source: z.string(), approvalRef: z.string().nullable(), requestId: z.string().nullable() });

export const auditRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/', { preHandler: requirePermission('audit:read'), schema: { tags: ['audit'], summary: 'Immutable audit trail', querystring: paginationQuery.merge(z.object({ entityType: z.string().optional(), entityId: z.string().optional(), action: z.string().optional(), actorUserId: z.string().uuid().optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() })), response: { 200: paginated(out) } } }, async (req) => {
    const q = req.query;
    let base = app.db.selectFrom('audit_logs').selectAll();
    if (q.entityType) base = base.where('entity_type', '=', q.entityType);
    if (q.entityId) base = base.where('entity_id', '=', q.entityId);
    if (q.action) base = base.where('action', 'like', `${q.action}%`);
    if (q.actorUserId) base = base.where('actor_user_id', '=', q.actorUserId);
    if (q.from) base = base.where('occurred_at', '>=', new Date(q.from));
    if (q.to) base = base.where('occurred_at', '<=', new Date(q.to));
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('occurred_at', 'desc').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map((a) => ({ id: Number(a.id), occurredAt: new Date(a.occurred_at).toISOString(), actorUserId: a.actor_user_id, actorLabel: a.actor_label, action: a.action, entityType: a.entity_type, entityId: a.entity_id, oldValue: a.old_value, newValue: a.new_value, reason: a.reason, ipAddress: a.ip_address, source: a.source, approvalRef: a.approval_ref, requestId: a.request_id })), meta: pageMeta(q, total) };
  });
};
