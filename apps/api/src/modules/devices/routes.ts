import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { errorSchema, idParam } from '../../lib/pagination.js';
import { notFound } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';

const deviceOut = z.object({
  id: z.string(), deviceCode: z.string(), name: z.string(), vendor: z.string(), model: z.string().nullable(), firmwareVersion: z.string().nullable(), ipAddress: z.string().nullable(), siteId: z.string().nullable(), siteName: z.string().nullable(),
  status: z.string(), connection: z.enum(['ONLINE', 'STALE', 'OFFLINE', 'UNKNOWN']), lastSeenAt: z.string().nullable(), lastSyncAt: z.string().nullable(), lastPunchAt: z.string().nullable(), lastError: z.string().nullable(), enrolledUserCount: z.number().nullable(), eventsToday: z.number(), isActive: z.boolean(),
});
const deviceIn = z.object({ deviceCode: z.string().min(1).max(64), name: z.string().min(1), vendor: z.string().default('MATRIX'), model: z.string().nullable().optional(), firmwareVersion: z.string().nullable().optional(), ipAddress: z.string().ip().nullable().optional(), macAddress: z.string().nullable().optional(), siteId: z.string().uuid().nullable().optional(), timezone: z.string().optional(), enrolledUserCount: z.number().int().nullable().optional(), isActive: z.boolean().optional() });
const ts = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const STALE_MINUTES = 30, OFFLINE_MINUTES = 180;

  const query = () => app.db.selectFrom('devices as d').leftJoin('sites as s', 's.id', 'd.site_id').selectAll('d').select('s.name as site_name')
    .select((eb) => eb.selectFrom('attendance_raw_events as e').select(eb.fn.countAll().as('n')).whereRef('e.device_id', '=', 'd.id').where('e.punched_at', '>=', sql<Date>`date_trunc('day', now() AT TIME ZONE 'Asia/Dubai') AT TIME ZONE 'Asia/Dubai'`).as('events_today')).where('d.deleted_at', 'is', null);
  const map = (d: Record<string, any>) => {
    const ageMin = d.last_seen_at ? (Date.now() - new Date(d.last_seen_at).getTime()) / 60000 : null;
    const connection: 'ONLINE' | 'STALE' | 'OFFLINE' | 'UNKNOWN' = d.status === 'DECOMMISSIONED' || ageMin === null ? 'UNKNOWN' : ageMin <= STALE_MINUTES ? 'ONLINE' : ageMin <= OFFLINE_MINUTES ? 'STALE' : 'OFFLINE';
    return { id: d.id, deviceCode: d.device_code, name: d.name, vendor: d.vendor, model: d.model, firmwareVersion: d.firmware_version, ipAddress: d.ip_address, siteId: d.site_id, siteName: d.site_name ?? null, status: d.status, connection, lastSeenAt: ts(d.last_seen_at), lastSyncAt: ts(d.last_sync_at), lastPunchAt: ts(d.last_punch_at), lastError: d.last_error, enrolledUserCount: d.enrolled_user_count, eventsToday: Number(d.events_today ?? 0), isActive: d.is_active };
  };

  r.get('/', { preHandler: requirePermission('devices:read'), schema: { tags: ['devices'], summary: 'List devices with health', response: { 200: z.array(deviceOut) } } }, async () => (await query().orderBy('d.device_code').execute()).map(map));
  r.get('/health', { preHandler: requirePermission('devices:read'), schema: { tags: ['devices'], summary: 'Device health dashboard summary', response: { 200: z.object({ total: z.number(), online: z.number(), stale: z.number(), offline: z.number(), unknown: z.number(), eventsToday: z.number(), unmappedOpen: z.number() }) } } }, async () => {
    const devs = (await query().execute()).map(map);
    const unmapped = await app.db.selectFrom('attendance_exceptions').select((eb) => eb.fn.countAll<number>().as('n')).where('exception_type', '=', 'UNMAPPED_USER').where('status', '=', 'OPEN').executeTakeFirstOrThrow();
    const c = (k: string) => devs.filter((d) => d.connection === k).length;
    return { total: devs.length, online: c('ONLINE'), stale: c('STALE'), offline: c('OFFLINE'), unknown: c('UNKNOWN'), eventsToday: devs.reduce((s, d) => s + d.eventsToday, 0), unmappedOpen: Number(unmapped.n) };
  });
  r.post('/', { preHandler: requirePermission('devices:write'), schema: { tags: ['devices'], summary: 'Register device', body: deviceIn, response: { 201: deviceOut } } }, async (req, reply) => {
    const b = req.body;
    const d = await app.db.insertInto('devices').values({ device_code: b.deviceCode, name: b.name, vendor: b.vendor, model: b.model ?? null, firmware_version: b.firmwareVersion ?? null, ip_address: b.ipAddress ?? null, mac_address: b.macAddress ?? null, site_id: b.siteId ?? null, timezone: b.timezone ?? 'Asia/Dubai', enrolled_user_count: b.enrolledUserCount ?? null }).returning('id').executeTakeFirstOrThrow();
    if (b.siteId) await app.db.insertInto('device_sites').values({ device_id: d.id, site_id: b.siteId }).execute();
    await app.audit(req, { action: 'device.create', entityType: 'device', entityId: d.id, newValue: b });
    return reply.status(201).send(map(await query().where('d.id', '=', d.id).executeTakeFirstOrThrow()));
  });
  r.patch('/:id', { preHandler: requirePermission('devices:write'), schema: { tags: ['devices'], summary: 'Update device', params: idParam, body: deviceIn.partial(), response: { 200: deviceOut, 404: errorSchema } } }, async (req) => {
    const b = req.body;
    const before = await app.db.selectFrom('devices').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!before) throw notFound('Device', req.params.id);
    await app.db.updateTable('devices').set({ ...(b.deviceCode !== undefined && { device_code: b.deviceCode }), ...(b.name !== undefined && { name: b.name }), ...(b.vendor !== undefined && { vendor: b.vendor }), ...(b.model !== undefined && { model: b.model }), ...(b.firmwareVersion !== undefined && { firmware_version: b.firmwareVersion }), ...(b.ipAddress !== undefined && { ip_address: b.ipAddress }), ...(b.macAddress !== undefined && { mac_address: b.macAddress }), ...(b.siteId !== undefined && { site_id: b.siteId }), ...(b.timezone !== undefined && { timezone: b.timezone }), ...(b.enrolledUserCount !== undefined && { enrolled_user_count: b.enrolledUserCount }), ...(b.isActive !== undefined && { is_active: b.isActive, status: b.isActive ? before.status : 'DECOMMISSIONED' }) }).where('id', '=', req.params.id).execute();
    if (b.siteId && b.siteId !== before.site_id) {
      await app.db.updateTable('device_sites').set({ to_date: new Date().toISOString().slice(0, 10) }).where('device_id', '=', req.params.id).where('to_date', 'is', null).execute();
      await app.db.insertInto('device_sites').values({ device_id: req.params.id, site_id: b.siteId }).onConflict((oc) => oc.doNothing()).execute();
    }
    await app.audit(req, { action: 'device.update', entityType: 'device', entityId: req.params.id, oldValue: before, newValue: b });
    return map(await query().where('d.id', '=', req.params.id).executeTakeFirstOrThrow());
  });
  r.post('/:id/heartbeat', { preHandler: requirePermission('attendance:ingest', 'devices:write'), schema: { tags: ['devices'], summary: 'Gateway heartbeat: mark device seen / report status', params: idParam, body: z.object({ online: z.boolean(), firmwareVersion: z.string().optional(), enrolledUserCount: z.number().int().optional(), error: z.string().optional() }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    requireAuth(req);
    const b = req.body;
    const res = await app.db.updateTable('devices').set({ last_seen_at: new Date(), last_sync_at: new Date(), status: b.online ? 'ONLINE' : b.error ? 'ERROR' : 'OFFLINE', ...(b.firmwareVersion && { firmware_version: b.firmwareVersion }), ...(b.enrolledUserCount !== undefined && { enrolled_user_count: b.enrolledUserCount }), ...(b.error !== undefined && { last_error: b.error, last_error_at: new Date() }) }).where('id', '=', req.params.id).returning('id').executeTakeFirst();
    if (!res) throw notFound('Device', req.params.id);
    return { ok: true };
  });

  // Biometric mappings (external user id ↔ employee). No templates.
  const mapOut = z.object({ id: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), provider: z.string(), externalUserId: z.string(), isActive: z.boolean(), enrolledAt: z.string().nullable() });
  r.get('/mappings', { preHandler: requirePermission('devices:read'), schema: { tags: ['devices'], summary: 'List biometric user mappings', querystring: z.object({ q: z.string().optional() }), response: { 200: z.array(mapOut) } } }, async (req) => {
    let q = app.db.selectFrom('biometric_mappings as m').innerJoin('employees as e', 'e.id', 'm.employee_id').selectAll('m').select(['e.employee_no', 'e.full_name_en']);
    if (req.query.q) q = q.where((eb) => eb.or([eb('m.external_user_id', '=', req.query.q!), eb('e.employee_no', 'ilike', `%${req.query.q}%`), eb('e.full_name_en', 'ilike', `%${req.query.q}%`)]));
    return (await q.orderBy('e.employee_no').limit(500).execute()).map((m) => ({ id: m.id, employeeId: m.employee_id, employeeNo: m.employee_no, employeeName: m.full_name_en, provider: m.provider, externalUserId: m.external_user_id, isActive: m.is_active, enrolledAt: ts(m.enrolled_at) }));
  });
  r.post('/mappings', { preHandler: requirePermission('devices:write'), schema: { tags: ['devices'], summary: 'Map an external (device) user id to an employee; re-processes any unmapped events for that id', body: z.object({ employeeId: z.string().uuid(), externalUserId: z.string().min(1), provider: z.string().default('MATRIX') }), response: { 201: z.object({ id: z.string(), relinkedEvents: z.number() }) } } }, async (req, reply) => {
    const b = req.body;
    const m = await app.db.insertInto('biometric_mappings').values({ employee_id: b.employeeId, external_user_id: b.externalUserId, provider: b.provider, enrolled_at: new Date() }).onConflict((oc) => oc.columns(['provider', 'external_user_id']).doUpdateSet({ employee_id: b.employeeId, is_active: true })).returning('id').executeTakeFirstOrThrow();
    await app.db.updateTable('employees').set({ matrix_user_id: b.externalUserId }).where('id', '=', b.employeeId).execute();
    // Late mapping: attach employee to orphan raw events (allowed by the ledger guard) and resolve UNMAPPED exceptions
    const relinked = await app.db.updateTable('attendance_raw_events').set({ employee_id: b.employeeId }).where('external_user_id', '=', b.externalUserId).where('employee_id', 'is', null).returning(['id', 'punched_at']).execute();
    if (relinked.length) {
      await app.db.updateTable('attendance_exceptions').set({ status: 'RESOLVED', resolved_at: new Date(), resolution_note: 'mapping created' }).where('exception_type', '=', 'UNMAPPED_USER').where('raw_event_id', 'in', relinked.map((x) => x.id)).execute();
      const dates = [...new Set(relinked.map((x) => new Date(x.punched_at).toISOString().slice(0, 10)))];
      await app.queues.enqueueProcessAffected(dates.flatMap((d) => { const prev = new Date(d); prev.setDate(prev.getDate() - 1); return [{ employeeId: b.employeeId, date: prev.toISOString().slice(0, 10) }, { employeeId: b.employeeId, date: d }]; }));
    }
    await app.audit(req, { action: 'device.mapping.upsert', entityType: 'biometric_mapping', entityId: m.id, newValue: b, metadata: { relinkedEvents: relinked.length } });
    return reply.status(201).send({ id: m.id, relinkedEvents: relinked.length });
  });
};
