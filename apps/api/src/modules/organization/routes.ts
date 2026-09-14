import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idParam, errorSchema } from '../../lib/pagination.js';
import { notFound } from '../../plugins/errors.js';
import { requirePermission } from '../../plugins/rbac.js';

const nullableStr = z.string().max(300).nullable().optional();

/** Generic CRUD for simple master-data tables with code/name. */
export const organizationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Departments ──
  const deptOut = z.object({ id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), parentId: z.string().nullable(), managerEmployeeId: z.string().nullable(), costCenterId: z.string().nullable(), isActive: z.boolean(), headcount: z.number() });
  const deptIn = z.object({ code: z.string().min(1).max(20), name: z.string().min(1), nameAr: nullableStr, parentId: z.string().uuid().nullable().optional(), managerEmployeeId: z.string().uuid().nullable().optional(), costCenterId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional() });
  const deptMap = (d: any) => ({ id: d.id, code: d.code, name: d.name, nameAr: d.name_ar, parentId: d.parent_id, managerEmployeeId: d.manager_employee_id, costCenterId: d.cost_center_id, isActive: d.is_active, headcount: Number(d.headcount ?? 0) });
  const deptQuery = () => app.db.selectFrom('departments as d').selectAll('d').select((eb) => eb.selectFrom('employees as e').select(eb.fn.countAll().as('n')).whereRef('e.department_id', '=', 'd.id').where('e.deleted_at', 'is', null).where('e.status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED']).as('headcount')).where('d.deleted_at', 'is', null);
  r.get('/departments', { preHandler: requirePermission('org:read'), schema: { tags: ['organization'], summary: 'List departments', response: { 200: z.array(deptOut) } } }, async () => (await deptQuery().orderBy('d.name').execute()).map(deptMap));
  r.post('/departments', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Create department', body: deptIn, response: { 201: deptOut } } }, async (req, reply) => {
    const b = req.body;
    const d = await app.db.insertInto('departments').values({ code: b.code, name: b.name, name_ar: b.nameAr ?? null, parent_id: b.parentId ?? null, manager_employee_id: b.managerEmployeeId ?? null, cost_center_id: b.costCenterId ?? null }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'org.department.create', entityType: 'department', entityId: d.id, newValue: b });
    return reply.status(201).send(deptMap(await deptQuery().where('d.id', '=', d.id).executeTakeFirstOrThrow()));
  });
  r.patch('/departments/:id', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Update department', params: idParam, body: deptIn.partial(), response: { 200: deptOut, 404: errorSchema } } }, async (req) => {
    const b = req.body;
    const before = await app.db.selectFrom('departments').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!before) throw notFound('Department', req.params.id);
    await app.db.updateTable('departments').set({ ...(b.code !== undefined && { code: b.code }), ...(b.name !== undefined && { name: b.name }), ...(b.nameAr !== undefined && { name_ar: b.nameAr }), ...(b.parentId !== undefined && { parent_id: b.parentId }), ...(b.managerEmployeeId !== undefined && { manager_employee_id: b.managerEmployeeId }), ...(b.costCenterId !== undefined && { cost_center_id: b.costCenterId }), ...(b.isActive !== undefined && { is_active: b.isActive }) }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'org.department.update', entityType: 'department', entityId: req.params.id, oldValue: before, newValue: b });
    return deptMap(await deptQuery().where('d.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── Designations ──
  const desigOut = z.object({ id: z.string(), code: z.string(), title: z.string(), titleAr: z.string().nullable(), grade: z.string().nullable(), isActive: z.boolean() });
  const desigIn = z.object({ code: z.string().min(1).max(20), title: z.string().min(1), titleAr: nullableStr, grade: nullableStr, isActive: z.boolean().optional() });
  const desigMap = (d: any) => ({ id: d.id, code: d.code, title: d.title, titleAr: d.title_ar, grade: d.grade, isActive: d.is_active });
  r.get('/designations', { preHandler: requirePermission('org:read'), schema: { tags: ['organization'], summary: 'List designations', response: { 200: z.array(desigOut) } } }, async () => (await app.db.selectFrom('designations').selectAll().where('deleted_at', 'is', null).orderBy('grade').orderBy('title').execute()).map(desigMap));
  r.post('/designations', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Create designation', body: desigIn, response: { 201: desigOut } } }, async (req, reply) => {
    const d = await app.db.insertInto('designations').values({ code: req.body.code, title: req.body.title, title_ar: req.body.titleAr ?? null, grade: req.body.grade ?? null }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'org.designation.create', entityType: 'designation', entityId: d.id, newValue: req.body });
    return reply.status(201).send(desigMap(d));
  });
  r.patch('/designations/:id', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Update designation', params: idParam, body: desigIn.partial(), response: { 200: desigOut } } }, async (req) => {
    const b = req.body;
    const d = await app.db.updateTable('designations').set({ ...(b.code !== undefined && { code: b.code }), ...(b.title !== undefined && { title: b.title }), ...(b.titleAr !== undefined && { title_ar: b.titleAr }), ...(b.grade !== undefined && { grade: b.grade }), ...(b.isActive !== undefined && { is_active: b.isActive }) }).where('id', '=', req.params.id).returningAll().executeTakeFirst();
    if (!d) throw notFound('Designation', req.params.id);
    await app.audit(req, { action: 'org.designation.update', entityType: 'designation', entityId: d.id, newValue: b });
    return desigMap(d);
  });

  // ── Cost centers ──
  const ccOut = z.object({ id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), isActive: z.boolean() });
  r.get('/cost-centers', { preHandler: requirePermission('org:read'), schema: { tags: ['organization'], summary: 'List cost centers', response: { 200: z.array(ccOut) } } }, async () => (await app.db.selectFrom('cost_centers').selectAll().where('deleted_at', 'is', null).orderBy('code').execute()).map((c) => ({ id: c.id, code: c.code, name: c.name, nameAr: c.name_ar, isActive: c.is_active })));
  r.post('/cost-centers', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Create cost center', body: z.object({ code: z.string().min(1), name: z.string().min(1), nameAr: nullableStr }), response: { 201: ccOut } } }, async (req, reply) => {
    const c = await app.db.insertInto('cost_centers').values({ code: req.body.code, name: req.body.name, name_ar: req.body.nameAr ?? null }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'org.cost_center.create', entityType: 'cost_center', entityId: c.id, newValue: req.body });
    return reply.status(201).send({ id: c.id, code: c.code, name: c.name, nameAr: c.name_ar, isActive: c.is_active });
  });

  // ── Projects ──
  const projOut = z.object({ id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), clientName: z.string().nullable(), status: z.string(), startDate: z.string().nullable(), endDate: z.string().nullable(), costCenterId: z.string().nullable(), managerEmployeeId: z.string().nullable(), managerName: z.string().nullable(), headcount: z.number(), siteCount: z.number() });
  const projIn = z.object({ code: z.string().min(1).max(20), name: z.string().min(1), nameAr: nullableStr, clientName: nullableStr, status: z.enum(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(), startDate: z.string().nullable().optional(), endDate: z.string().nullable().optional(), costCenterId: z.string().uuid().nullable().optional(), managerEmployeeId: z.string().uuid().nullable().optional() });
  const projQuery = () => app.db.selectFrom('projects as p').leftJoin('employees as m', 'm.id', 'p.manager_employee_id').selectAll('p').select('m.full_name_en as manager_name')
    .select((eb) => eb.selectFrom('employees as e').select(eb.fn.countAll().as('n')).whereRef('e.project_id', '=', 'p.id').where('e.deleted_at', 'is', null).where('e.status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED']).as('headcount'))
    .select((eb) => eb.selectFrom('sites as s').select(eb.fn.countAll().as('n')).whereRef('s.project_id', '=', 'p.id').where('s.deleted_at', 'is', null).as('site_count')).where('p.deleted_at', 'is', null);
  const projMap = (p: any) => ({ id: p.id, code: p.code, name: p.name, nameAr: p.name_ar, clientName: p.client_name, status: p.status, startDate: p.start_date, endDate: p.end_date, costCenterId: p.cost_center_id, managerEmployeeId: p.manager_employee_id, managerName: p.manager_name ?? null, headcount: Number(p.headcount ?? 0), siteCount: Number(p.site_count ?? 0) });
  r.get('/projects', { preHandler: requirePermission('org:read'), schema: { tags: ['organization'], summary: 'List projects', response: { 200: z.array(projOut) } } }, async () => (await projQuery().orderBy('p.code').execute()).map(projMap));
  r.post('/projects', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Create project', body: projIn, response: { 201: projOut } } }, async (req, reply) => {
    const b = req.body;
    const p = await app.db.insertInto('projects').values({ code: b.code, name: b.name, name_ar: b.nameAr ?? null, client_name: b.clientName ?? null, status: b.status ?? 'ACTIVE', start_date: b.startDate ?? null, end_date: b.endDate ?? null, cost_center_id: b.costCenterId ?? null, manager_employee_id: b.managerEmployeeId ?? null }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'org.project.create', entityType: 'project', entityId: p.id, newValue: b });
    return reply.status(201).send(projMap(await projQuery().where('p.id', '=', p.id).executeTakeFirstOrThrow()));
  });
  r.patch('/projects/:id', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Update project', params: idParam, body: projIn.partial(), response: { 200: projOut } } }, async (req) => {
    const b = req.body;
    const res = await app.db.updateTable('projects').set({ ...(b.code !== undefined && { code: b.code }), ...(b.name !== undefined && { name: b.name }), ...(b.nameAr !== undefined && { name_ar: b.nameAr }), ...(b.clientName !== undefined && { client_name: b.clientName }), ...(b.status !== undefined && { status: b.status }), ...(b.startDate !== undefined && { start_date: b.startDate }), ...(b.endDate !== undefined && { end_date: b.endDate }), ...(b.costCenterId !== undefined && { cost_center_id: b.costCenterId }), ...(b.managerEmployeeId !== undefined && { manager_employee_id: b.managerEmployeeId }) }).where('id', '=', req.params.id).returning('id').executeTakeFirst();
    if (!res) throw notFound('Project', req.params.id);
    await app.audit(req, { action: 'org.project.update', entityType: 'project', entityId: req.params.id, newValue: b });
    return projMap(await projQuery().where('p.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── Sites ──
  const siteOut = z.object({ id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), siteType: z.string(), projectId: z.string().nullable(), projectCode: z.string().nullable(), address: z.string().nullable(), emirate: z.string().nullable(), latitude: z.number().nullable(), longitude: z.number().nullable(), geofenceRadiusM: z.number().nullable(), timezone: z.string(), isActive: z.boolean(), headcount: z.number(), deviceCount: z.number() });
  const siteIn = z.object({ code: z.string().min(1).max(20), name: z.string().min(1), nameAr: nullableStr, siteType: z.enum(['OFFICE', 'SITE', 'CAMP', 'WAREHOUSE']).optional(), projectId: z.string().uuid().nullable().optional(), address: nullableStr, emirate: nullableStr, latitude: z.number().nullable().optional(), longitude: z.number().nullable().optional(), geofenceRadiusM: z.number().int().nullable().optional(), timezone: z.string().optional(), isActive: z.boolean().optional() });
  const siteQuery = () => app.db.selectFrom('sites as s').leftJoin('projects as p', 'p.id', 's.project_id').selectAll('s').select('p.code as project_code')
    .select((eb) => eb.selectFrom('employees as e').select(eb.fn.countAll().as('n')).whereRef('e.site_id', '=', 's.id').where('e.deleted_at', 'is', null).where('e.status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED']).as('headcount'))
    .select((eb) => eb.selectFrom('devices as d').select(eb.fn.countAll().as('n')).whereRef('d.site_id', '=', 's.id').where('d.deleted_at', 'is', null).as('device_count')).where('s.deleted_at', 'is', null);
  const siteMap = (s: any) => ({ id: s.id, code: s.code, name: s.name, nameAr: s.name_ar, siteType: s.site_type, projectId: s.project_id, projectCode: s.project_code ?? null, address: s.address, emirate: s.emirate, latitude: s.latitude === null ? null : Number(s.latitude), longitude: s.longitude === null ? null : Number(s.longitude), geofenceRadiusM: s.geofence_radius_m, timezone: s.timezone, isActive: s.is_active, headcount: Number(s.headcount ?? 0), deviceCount: Number(s.device_count ?? 0) });
  r.get('/sites', { preHandler: requirePermission('org:read'), schema: { tags: ['organization'], summary: 'List sites', response: { 200: z.array(siteOut) } } }, async () => (await siteQuery().orderBy('s.code').execute()).map(siteMap));
  r.post('/sites', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Create site', body: siteIn, response: { 201: siteOut } } }, async (req, reply) => {
    const b = req.body;
    const s = await app.db.insertInto('sites').values({ code: b.code, name: b.name, name_ar: b.nameAr ?? null, site_type: b.siteType ?? 'SITE', project_id: b.projectId ?? null, address: b.address ?? null, emirate: b.emirate ?? null, latitude: b.latitude ?? null, longitude: b.longitude ?? null, geofence_radius_m: b.geofenceRadiusM ?? null, timezone: b.timezone ?? 'Asia/Dubai' }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'org.site.create', entityType: 'site', entityId: s.id, newValue: b });
    return reply.status(201).send(siteMap(await siteQuery().where('s.id', '=', s.id).executeTakeFirstOrThrow()));
  });
  r.patch('/sites/:id', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Update site', params: idParam, body: siteIn.partial(), response: { 200: siteOut } } }, async (req) => {
    const b = req.body;
    const res = await app.db.updateTable('sites').set({ ...(b.code !== undefined && { code: b.code }), ...(b.name !== undefined && { name: b.name }), ...(b.nameAr !== undefined && { name_ar: b.nameAr }), ...(b.siteType !== undefined && { site_type: b.siteType }), ...(b.projectId !== undefined && { project_id: b.projectId }), ...(b.address !== undefined && { address: b.address }), ...(b.emirate !== undefined && { emirate: b.emirate }), ...(b.latitude !== undefined && { latitude: b.latitude }), ...(b.longitude !== undefined && { longitude: b.longitude }), ...(b.geofenceRadiusM !== undefined && { geofence_radius_m: b.geofenceRadiusM }), ...(b.timezone !== undefined && { timezone: b.timezone }), ...(b.isActive !== undefined && { is_active: b.isActive }) }).where('id', '=', req.params.id).returning('id').executeTakeFirst();
    if (!res) throw notFound('Site', req.params.id);
    await app.audit(req, { action: 'org.site.update', entityType: 'site', entityId: req.params.id, newValue: b });
    return siteMap(await siteQuery().where('s.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── Holidays ──
  const holOut = z.object({ id: z.string(), name: z.string(), nameAr: z.string().nullable(), holidayDate: z.string(), endDate: z.string().nullable(), isPaid: z.boolean(), appliesToSiteId: z.string().nullable() });
  r.get('/holidays', { preHandler: requirePermission('org:read', 'shifts:read', 'attendance:read:own'), schema: { tags: ['organization'], summary: 'List holidays', querystring: z.object({ year: z.coerce.number().int().optional() }), response: { 200: z.array(holOut) } } }, async (req) => {
    let q = app.db.selectFrom('holidays').selectAll();
    if (req.query.year) q = q.where('year', '=', req.query.year);
    return (await q.orderBy('holiday_date').execute()).map((h) => ({ id: h.id, name: h.name, nameAr: h.name_ar, holidayDate: h.holiday_date, endDate: h.end_date, isPaid: h.is_paid, appliesToSiteId: h.applies_to_site_id }));
  });
  r.post('/holidays', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Create holiday', body: z.object({ name: z.string().min(1), nameAr: nullableStr, holidayDate: z.string(), endDate: z.string().nullable().optional(), isPaid: z.boolean().default(true), appliesToSiteId: z.string().uuid().nullable().optional() }), response: { 201: holOut } } }, async (req, reply) => {
    const b = req.body;
    const h = await app.db.insertInto('holidays').values({ name: b.name, name_ar: b.nameAr ?? null, holiday_date: b.holidayDate, end_date: b.endDate ?? null, is_paid: b.isPaid, applies_to_site_id: b.appliesToSiteId ?? null }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'org.holiday.create', entityType: 'holiday', entityId: h.id, newValue: b });
    return reply.status(201).send({ id: h.id, name: h.name, nameAr: h.name_ar, holidayDate: h.holiday_date, endDate: h.end_date, isPaid: h.is_paid, appliesToSiteId: h.applies_to_site_id });
  });
  r.delete('/holidays/:id', { preHandler: requirePermission('org:write'), schema: { tags: ['organization'], summary: 'Delete holiday', params: idParam, response: { 204: z.null() } } }, async (req, reply) => {
    await app.db.deleteFrom('holidays').where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'org.holiday.delete', entityType: 'holiday', entityId: req.params.id });
    return reply.status(204).send(null);
  });
};
