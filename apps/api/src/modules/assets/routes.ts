import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { addTimeline } from '../hr-requests/timeline.js';

/** Asset register: assign / return company assets to employees; feeds the clearance checklist and asset-damage deductions. */
export const assetRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const assetOut = z.object({ id: z.string(), assetTag: z.string(), category: z.string(), name: z.string(), serialNumber: z.string().nullable(), status: z.string(), site: z.string().nullable(), purchaseDate: z.string().nullable(), notes: z.string().nullable(), holder: z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), assignedAt: z.string() }).nullable() });
  const q = () => app.db.selectFrom('assets as a').leftJoin('sites as s', 's.id', 'a.site_id').leftJoin('employee_assets as ea', (j) => j.onRef('ea.asset_id', '=', 'a.id').on('ea.returned_at', 'is', null)).leftJoin('employees as e', 'e.id', 'ea.employee_id').selectAll('a').select(['s.name as site', 'e.id as holder_id', 'e.employee_no', 'e.full_name_en', 'ea.assigned_at', 'ea.id as ea_id']).where('a.deleted_at', 'is', null);
  const map = (a: any) => ({ id: a.id, assetTag: a.asset_tag, category: a.category, name: a.name, serialNumber: a.serial_number, status: a.status, site: a.site ?? null, purchaseDate: a.purchase_date, notes: a.notes, holder: a.holder_id ? { id: a.holder_id, employeeNo: a.employee_no, name: a.full_name_en, assignedAt: String(a.assigned_at) } : null });
  r.get('/', { preHandler: requirePermission('assets:read'), schema: { tags: ['assets'], summary: 'Asset register', querystring: paginationQuery.merge(z.object({ q: z.string().optional(), category: z.string().optional(), status: z.string().optional(), assigned: z.coerce.boolean().optional() })), response: { 200: paginated(assetOut) } } }, async (req) => {
    let b = q();
    if (req.query.q) b = b.where((eb) => eb.or([eb('a.asset_tag', 'ilike', `%${req.query.q}%`), eb('a.name', 'ilike', `%${req.query.q}%`), eb('a.serial_number', 'ilike', `%${req.query.q}%`)]));
    if (req.query.category) b = b.where('a.category', '=', req.query.category.toUpperCase());
    if (req.query.status) b = b.where('a.status', '=', req.query.status.toUpperCase());
    if (req.query.assigned === true) b = b.where('ea.id', 'is not', null);
    if (req.query.assigned === false) b = b.where('ea.id', 'is', null);
    const total = Number((await b.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return { data: (await b.orderBy('a.asset_tag').limit(req.query.pageSize).offset(offset(req.query)).execute()).map(map), meta: pageMeta(req.query, total) };
  });
  r.post('/', { preHandler: requirePermission('assets:write'), schema: { tags: ['assets'], summary: 'Register an asset', body: z.object({ assetTag: z.string().min(1), category: z.string().min(1), name: z.string().min(1), serialNumber: z.string().optional(), siteId: z.string().uuid().optional(), purchaseDate: z.string().optional(), notes: z.string().optional() }), response: { 201: assetOut } } }, async (req, reply) => {
    const a = await app.db.insertInto('assets').values({ asset_tag: req.body.assetTag.toUpperCase(), category: req.body.category.toUpperCase(), name: req.body.name, serial_number: req.body.serialNumber ?? null, site_id: req.body.siteId ?? null, purchase_date: req.body.purchaseDate ?? null, notes: req.body.notes ?? null }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'asset.create', entityType: 'asset', entityId: a.id, newValue: req.body });
    return reply.status(201).send(map(await q().where('a.id', '=', a.id).executeTakeFirstOrThrow()));
  });
  r.post('/:id/assign', { preHandler: requirePermission('assets:write'), schema: { tags: ['assets'], summary: 'Assign asset to an employee', params: idParam, body: z.object({ employeeId: z.string().uuid(), conditionOut: z.string().optional(), assignedAt: z.string().optional() }), response: { 200: assetOut, 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const a = await q().where('a.id', '=', req.params.id).executeTakeFirst();
    if (!a) throw notFound('Asset', req.params.id);
    if (a.holder_id) throw unprocessable(`Asset is currently held by ${a.full_name_en}; return it first`);
    await app.db.transaction().execute(async (trx) => {
      await trx.insertInto('employee_assets').values({ asset_id: a.id, employee_id: req.body.employeeId, condition_out: req.body.conditionOut ?? null, assigned_by: p.userId, ...(req.body.assignedAt && { assigned_at: req.body.assignedAt }) }).execute();
      await trx.updateTable('assets').set({ status: 'ASSIGNED' }).where('id', '=', a.id).execute();
      await addTimeline(trx, { employeeId: req.body.employeeId, type: 'ASSET', title: `Asset assigned: ${a.name}`, description: a.asset_tag, refType: 'asset', refId: a.id, actorUserId: p.userId, visibility: 'EMPLOYEE' });
    });
    await app.audit(req, { action: 'asset.assign', entityType: 'asset', entityId: a.id, newValue: req.body });
    return map(await q().where('a.id', '=', a.id).executeTakeFirstOrThrow());
  });
  r.post('/:id/return', { preHandler: requirePermission('assets:write'), schema: { tags: ['assets'], summary: 'Return an asset (optionally flag damage for a deduction request)', params: idParam, body: z.object({ conditionIn: z.string().optional(), returnedAt: z.string().optional(), damaged: z.boolean().default(false) }), response: { 200: assetOut, 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const a = await q().where('a.id', '=', req.params.id).executeTakeFirst();
    if (!a) throw notFound('Asset', req.params.id);
    if (!a.holder_id) throw unprocessable('Asset is not assigned');
    await app.db.transaction().execute(async (trx) => {
      await trx.updateTable('employee_assets').set({ returned_at: req.body.returnedAt ?? new Date().toISOString().slice(0, 10), condition_in: req.body.conditionIn ?? null }).where('asset_id', '=', a.id).where('returned_at', 'is', null).execute();
      await trx.updateTable('assets').set({ status: req.body.damaged ? 'DAMAGED' : 'AVAILABLE' }).where('id', '=', a.id).execute();
      await addTimeline(trx, { employeeId: a.holder_id!, type: 'ASSET', title: `Asset returned: ${a.name}${req.body.damaged ? ' (damaged)' : ''}`, description: [a.asset_tag, req.body.conditionIn].filter(Boolean).join(' · '), refType: 'asset', refId: a.id, actorUserId: p.userId, visibility: 'EMPLOYEE' });
    });
    await app.audit(req, { action: 'asset.return', entityType: 'asset', entityId: a.id, newValue: { ...req.body, employeeId: a.holder_id } });
    return map(await q().where('a.id', '=', a.id).executeTakeFirstOrThrow());
  });
  r.get('/employee/:employeeId', { preHandler: requirePermission('assets:read', 'employees:read:own'), schema: { tags: ['assets'], summary: 'Assets held (and previously held) by an employee', params: z.object({ employeeId: z.string().uuid() }), response: { 200: z.array(z.object({ id: z.string(), assetId: z.string(), assetTag: z.string(), name: z.string(), category: z.string(), assignedAt: z.string(), returnedAt: z.string().nullable(), conditionOut: z.string().nullable(), conditionIn: z.string().nullable() })) } } }, async (req) => {
    const p = requireAuth(req);
    if (!hasPermission(p, 'assets:read') && p.employeeId !== req.params.employeeId) throw notFound('Employee', req.params.employeeId);
    return (await app.db.selectFrom('employee_assets as ea').innerJoin('assets as a', 'a.id', 'ea.asset_id').select(['ea.id', 'a.id as asset_id', 'a.asset_tag', 'a.name', 'a.category', 'ea.assigned_at', 'ea.returned_at', 'ea.condition_out', 'ea.condition_in']).where('ea.employee_id', '=', req.params.employeeId).orderBy('ea.assigned_at', 'desc').execute()).map((x) => ({ id: x.id, assetId: x.asset_id, assetTag: x.asset_tag, name: x.name, category: x.category, assignedAt: String(x.assigned_at), returnedAt: x.returned_at ? String(x.returned_at) : null, conditionOut: x.condition_out, conditionIn: x.condition_in }));
  });
};
