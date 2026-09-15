import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { getEnv } from '@burtplace/config';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { averageEmbeddings, encryptEmbeddings, templateKeyIsDerived } from '../../integrations/face/crypto.js';
import { addTimeline } from '../hr-requests/timeline.js';
import { analyzeFrame, decodeImage, faceIndex, faceProvider, identify, invalidateFaceIndex } from './face-service.js';
import { DEFAULT_FACE_SETTINGS, faceSettingsSchema, loadFaceSettings, saveFaceSettings } from './settings.js';

/**
 * Biometric administration: face enrollment (RESTRICTED), template lifecycle, self-test, recognition audit,
 * versioned face-attendance settings and attendance terminals (kiosks). Raw templates never leave the server.
 */
export const hashTerminalToken = (token: string) => createHash('sha256').update(`${getEnv().API_KEY_PEPPER}:${token}`).digest('hex');

export const biometricRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.log.info({ derivedKey: templateKeyIsDerived() }, templateKeyIsDerived() ? 'BIOMETRIC_TEMPLATE_KEY not set — using a key derived from API_KEY_PEPPER (development only)' : 'biometric template key configured');

  const statusOut = z.object({ employeeId: z.string(), enrolled: z.boolean(), status: z.string().nullable(), provider: z.string().nullable(), modelVersion: z.string().nullable(), sampleCount: z.number().nullable(), enrolledAt: z.string().nullable(), enrolledBy: z.string().nullable(), updatedAt: z.string().nullable(), disabledAt: z.string().nullable(), disabledReason: z.string().nullable(), quality: z.unknown().nullable(), recognitionEnabled: z.boolean(), lastRecognition: z.object({ at: z.string(), outcome: z.string(), score: z.number().nullable() }).nullable(), history: z.array(z.object({ status: z.string(), enrolledAt: z.string(), deletedAt: z.string().nullable(), by: z.string().nullable() })) });
  const canSeeEmployee = async (p: ReturnType<typeof requireAuth>, employeeId: string) => { if (!hasPermission(p, 'biometric:read') && p.employeeId !== employeeId) throw forbidden(); };

  r.get('/employees/:id/status', { preHandler: requirePermission('biometric:read', 'employees:read:own'), schema: { tags: ['biometric'], summary: 'Face enrollment status for an employee (no template data)', params: idParam, response: { 200: statusOut } } }, async (req) => {
    const p = requireAuth(req); await canSeeEmployee(p, req.params.id);
    const rows = await app.db.selectFrom('biometric_face_templates as t').leftJoin('users as u', 'u.id', 't.enrolled_by').selectAll('t').select('u.display_name').where('t.employee_id', '=', req.params.id).orderBy('t.enrolled_at', 'desc').execute();
    const active = rows.find((x) => x.status === 'ACTIVE') ?? rows[0] ?? null;
    const emp = await app.db.selectFrom('employees').select('status').where('id', '=', req.params.id).executeTakeFirst();
    if (!emp) throw notFound('Employee', req.params.id);
    const last = await app.db.selectFrom('face_recognition_events').select(['occurred_at', 'outcome', 'top_score']).where('employee_id', '=', req.params.id).orderBy('occurred_at', 'desc').executeTakeFirst();
    const cfg = (await loadFaceSettings(app.db)).value;
    return { employeeId: req.params.id, enrolled: !!active && active.status === 'ACTIVE', status: active?.status ?? null, provider: active?.provider ?? null, modelVersion: active?.model_version ?? null, sampleCount: active?.sample_count ?? null, enrolledAt: active ? new Date(active.enrolled_at).toISOString() : null, enrolledBy: active?.display_name ?? null, updatedAt: active ? new Date(active.updated_at).toISOString() : null, disabledAt: active?.disabled_at ? new Date(active.disabled_at).toISOString() : null, disabledReason: active?.disabled_reason ?? null, quality: hasPermission(p, 'biometric:read') ? active?.quality ?? null : null, recognitionEnabled: cfg.enabled && !!active && active.status === 'ACTIVE' && ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE'].includes(emp.status), lastRecognition: last ? { at: new Date(last.occurred_at).toISOString(), outcome: last.outcome, score: last.top_score === null ? null : Number(last.top_score) } : null, history: rows.map((x) => ({ status: x.status, enrolledAt: new Date(x.enrolled_at).toISOString(), deletedAt: x.deleted_at ? new Date(x.deleted_at).toISOString() : null, by: x.display_name ?? null })) };
  });

  const enrollBody = z.object({ frames: z.array(z.string().min(100)).min(1).max(6), consentNote: z.string().max(500).optional(), replace: z.boolean().default(true) });
  r.post('/employees/:id/enroll', { preHandler: requirePermission('biometric:enroll'), schema: { tags: ['biometric'], summary: 'Enroll (or re-enroll) a face template from 1–6 camera frames (frontal, slight left, slight right). Frames are analysed server-side; only the encrypted embeddings (each accepted sample + their average) are stored.', params: idParam, body: enrollBody, response: { 200: z.object({ templateId: z.string(), sampleCount: z.number(), rejectedFrames: z.array(z.object({ index: z.number(), outcome: z.string(), reason: z.string().nullable() })), quality: z.unknown(), consistency: z.number().nullable(), provider: z.string(), modelVersion: z.string() }), 400: errorSchema, 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    if (p.employeeId === req.params.id && !hasPermission(p, 'biometric:delete')) throw forbidden('You cannot enroll your own face; an authorised HR/IT user must perform enrollment');
    const emp = await app.db.selectFrom('employees').select(['id', 'employee_no', 'status', 'full_name_en']).where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!emp) throw notFound('Employee', req.params.id);
    if (['TERMINATED', 'ARCHIVED'].includes(emp.status)) throw unprocessable(`Employee is ${emp.status}; enrollment not allowed`);
    const cfg = (await loadFaceSettings(app.db)).value;
    const provider = await faceProvider();
    const embeddings: Float32Array[] = []; const rejected: { index: number; outcome: string; reason: string | null }[] = []; const qualities: unknown[] = [];
    for (let i = 0; i < req.body.frames.length; i++) {
      const a = await analyzeFrame(decodeImage(req.body.frames[i]!), cfg, 'ENROLL');
      if (a.outcome !== 'OK' || !a.face) { rejected.push({ index: i, outcome: a.outcome, reason: a.reason }); continue; }
      embeddings.push(a.face.embedding); qualities.push(a.quality);
    }
    if (!embeddings.length) throw unprocessable('No usable frame: ' + rejected.map((x) => `${x.outcome}${x.reason ? ` (${x.reason})` : ''}`).join('; '), { rejectedFrames: rejected });
    // Consistency: every accepted frame must resemble the others (guards against two different people in one enrollment)
    let consistency: number | null = null;
    if (embeddings.length > 1) { let min = 1; for (let i = 0; i < embeddings.length; i++) for (let j = i + 1; j < embeddings.length; j++) min = Math.min(min, provider.similarity(embeddings[i]!, embeddings[j]!)); consistency = min; if (min < cfg.thresholds.match) throw unprocessable(`Frames are not consistent with one person (min similarity ${min}); retake the enrollment`, { consistency: min }); }
    const template = averageEmbeddings(embeddings);
    // Guard: the new template must not be a near-duplicate of ANOTHER employee's template (would create ambiguous matches)
    const dup = (await (await faceIndex(app)).search(template, 2)).find((c) => c.employeeId !== emp.id && c.similarity >= cfg.thresholds.match);
    if (dup) throw unprocessable(`This face already matches enrolled employee ${dup.employeeNo} (similarity ${dup.similarity}); enrollment refused`, { conflictEmployeeNo: dup.employeeNo });
    const id = await app.db.transaction().execute(async (trx) => {
      if (req.body.replace) await trx.updateTable('biometric_face_templates').set({ status: 'DELETED', deleted_at: new Date(), deleted_by: p.userId }).where('employee_id', '=', emp.id).where('provider', '=', provider.code).where('status', 'in', ['ACTIVE', 'DISABLED']).execute();
      const t = await trx.insertInto('biometric_face_templates').values({ employee_id: emp.id, provider: provider.code, model_version: provider.modelVersion, embedding_dim: template.length, embedding_enc: encryptEmbeddings([...embeddings, template]), sample_count: embeddings.length, quality: JSON.stringify({ samples: qualities, consistency }), consent_note: req.body.consentNote ?? null, enrolled_by: p.userId }).returning('id').executeTakeFirstOrThrow();
      // Attendance mapping so the raw ledger resolves MOBILE_FACE punches by employee number
      await trx.insertInto('biometric_mappings').values({ employee_id: emp.id, provider: 'MOBILE_FACE', external_user_id: emp.employee_no, enrolled_at: new Date(), is_active: true }).onConflict((oc) => oc.columns(['provider', 'external_user_id']).doUpdateSet({ employee_id: emp.id, is_active: true, enrolled_at: new Date() })).execute();
      return t.id;
    });
    invalidateFaceIndex();
    await addTimeline(app.db, { employeeId: emp.id, type: 'BIOMETRIC', title: 'Face enrolled for mobile attendance', description: `${embeddings.length} frame(s) · ${provider.code}`, refType: 'biometric_face_template', refId: id, actorUserId: p.userId, visibility: 'HR' });
    await app.audit(req, { action: 'biometric.face.enroll', entityType: 'biometric_face_template', entityId: id, newValue: { employeeId: emp.id, provider: provider.code, modelVersion: provider.modelVersion, sampleCount: embeddings.length, rejectedFrames: rejected.length, consistency }, reason: req.body.consentNote });
    return { templateId: id, sampleCount: embeddings.length, rejectedFrames: rejected, quality: qualities, consistency, provider: provider.code, modelVersion: provider.modelVersion };
  });

  r.post('/employees/:id/test', { preHandler: requirePermission('biometric:test'), schema: { tags: ['biometric'], summary: 'Test recognition for an employee with one frame (does not create attendance)', params: idParam, body: z.object({ frame: z.string().min(100) }), response: { 200: z.object({ outcome: z.string(), reason: z.string().nullable(), verifyScore: z.number().nullable(), identified: z.object({ employeeNo: z.string(), similarity: z.number(), isThisEmployee: z.boolean() }).nullable(), antispoof: z.number().nullable(), liveness: z.number().nullable(), quality: z.unknown() }) } } }, async (req) => {
    const cfg = (await loadFaceSettings(app.db)).value;
    const a = await analyzeFrame(decodeImage(req.body.frame), cfg, 'RECOGNIZE');
    await app.audit(req, { action: 'biometric.face.test', entityType: 'employee', entityId: req.params.id, newValue: { outcome: a.outcome } });
    if (a.outcome !== 'OK' || !a.face) return { outcome: a.outcome, reason: a.reason, verifyScore: null, identified: null, antispoof: a.face?.antispoof ?? null, liveness: a.face?.liveness ?? null, quality: a.quality };
    const verify = await (await faceIndex(app)).verify(a.face.embedding, req.params.id);
    const id = await identify(app, a.face.embedding, cfg);
    return { outcome: id.outcome, reason: null, verifyScore: verify, identified: id.top ? { employeeNo: id.top.employeeNo, similarity: id.top.similarity, isThisEmployee: id.top.employeeId === req.params.id } : null, antispoof: a.face.antispoof, liveness: a.face.liveness, quality: a.quality };
  });

  r.post('/employees/:id/disable', { preHandler: requirePermission('biometric:enroll'), schema: { tags: ['biometric'], summary: 'Disable recognition (template kept, per retention policy)', params: idParam, body: z.object({ reason: z.string().max(500) }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const p = requireAuth(req);
    const n = await app.db.updateTable('biometric_face_templates').set({ status: 'DISABLED', disabled_at: new Date(), disabled_reason: req.body.reason }).where('employee_id', '=', req.params.id).where('status', '=', 'ACTIVE').executeTakeFirst();
    if (!Number(n.numUpdatedRows)) throw notFound('Active template');
    await app.db.updateTable('biometric_mappings').set({ is_active: false }).where('employee_id', '=', req.params.id).where('provider', '=', 'MOBILE_FACE').execute();
    invalidateFaceIndex();
    await addTimeline(app.db, { employeeId: req.params.id, type: 'BIOMETRIC', title: 'Face recognition disabled', description: req.body.reason, actorUserId: p.userId, visibility: 'HR' });
    await app.audit(req, { action: 'biometric.face.disable', entityType: 'employee', entityId: req.params.id, reason: req.body.reason });
    return { ok: true };
  });
  r.post('/employees/:id/enable', { preHandler: requirePermission('biometric:enroll'), schema: { tags: ['biometric'], summary: 'Re-enable a disabled template', params: idParam, response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const p = requireAuth(req);
    const emp = await app.db.selectFrom('employees').select('status').where('id', '=', req.params.id).executeTakeFirstOrThrow();
    if (['TERMINATED', 'ARCHIVED'].includes(emp.status)) throw unprocessable('Employee has left; re-enable not allowed');
    const n = await app.db.updateTable('biometric_face_templates').set({ status: 'ACTIVE', disabled_at: null, disabled_reason: null }).where('employee_id', '=', req.params.id).where('status', '=', 'DISABLED').executeTakeFirst();
    if (!Number(n.numUpdatedRows)) throw notFound('Disabled template');
    await app.db.updateTable('biometric_mappings').set({ is_active: true }).where('employee_id', '=', req.params.id).where('provider', '=', 'MOBILE_FACE').execute();
    invalidateFaceIndex();
    await app.audit(req, { action: 'biometric.face.enable', entityType: 'employee', entityId: req.params.id });
    void p; return { ok: true };
  });
  r.delete('/employees/:id/template', { preHandler: requirePermission('biometric:delete'), schema: { tags: ['biometric'], summary: 'Delete the biometric template (irreversible; ciphertext is overwritten). Retention/deletion policy REQUIRES HR/LEGAL APPROVAL.', params: idParam, querystring: z.object({ reason: z.string().max(500).optional() }), response: { 200: z.object({ deleted: z.number() }) } } }, async (req) => {
    const p = requireAuth(req);
    const n = await app.db.updateTable('biometric_face_templates').set({ status: 'DELETED', deleted_at: new Date(), deleted_by: p.userId, embedding_enc: Buffer.alloc(0) }).where('employee_id', '=', req.params.id).where('status', '!=', 'DELETED').executeTakeFirst();
    await app.db.updateTable('biometric_mappings').set({ is_active: false }).where('employee_id', '=', req.params.id).where('provider', '=', 'MOBILE_FACE').execute();
    invalidateFaceIndex();
    await addTimeline(app.db, { employeeId: req.params.id, type: 'BIOMETRIC', title: 'Biometric template deleted', description: req.query.reason ?? null, actorUserId: p.userId, visibility: 'HR' });
    await app.audit(req, { action: 'biometric.face.delete', entityType: 'employee', entityId: req.params.id, reason: req.query.reason, newValue: { deleted: Number(n.numUpdatedRows) } });
    return { deleted: Number(n.numUpdatedRows) };
  });

  // ── Recognition events (audit) ──
  const eventOut = z.object({ id: z.number(), occurredAt: z.string(), mode: z.string(), outcome: z.string(), reason: z.string().nullable(), employee: z.object({ id: z.string(), employeeNo: z.string(), name: z.string() }).nullable(), deviceCode: z.string().nullable(), site: z.string().nullable(), topScore: z.number().nullable(), secondScore: z.number().nullable(), antispoof: z.number().nullable(), liveness: z.number().nullable(), geofence: z.string().nullable(), distanceM: z.number().nullable(), gpsAccuracyM: z.number().nullable(), direction: z.string().nullable(), rawEventId: z.string().nullable(), provider: z.string().nullable(), modelVersion: z.string().nullable(), durationMs: z.number().nullable() });
  r.get('/events', { preHandler: requirePermission('biometric:events:read', 'attendance:read:own'), schema: { tags: ['biometric'], summary: 'Face recognition events (immutable audit)', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), outcome: z.string().optional(), from: z.string().optional(), to: z.string().optional() })), response: { 200: paginated(eventOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = app.db.selectFrom('face_recognition_events as f').leftJoin('employees as e', 'e.id', 'f.employee_id').leftJoin('sites as s', 's.id', 'f.site_id').selectAll('f').select(['e.employee_no', 'e.full_name_en', 's.name as site_name']);
    if (!hasPermission(p, 'biometric:events:read')) q = q.where('f.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (req.query.employeeId) q = q.where('f.employee_id', '=', req.query.employeeId);
    if (req.query.outcome) q = q.where('f.outcome', '=', req.query.outcome.toUpperCase());
    if (req.query.from) q = q.where('f.occurred_at', '>=', new Date(req.query.from));
    if (req.query.to) q = q.where('f.occurred_at', '<=', new Date(`${req.query.to}T23:59:59Z`));
    const total = Number((await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await q.orderBy('f.occurred_at', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute();
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return { data: rows.map((x) => ({ id: Number(x.id), occurredAt: new Date(x.occurred_at).toISOString(), mode: x.attendance_mode, outcome: x.outcome, reason: x.reason, employee: x.employee_id ? { id: x.employee_id, employeeNo: x.employee_no!, name: x.full_name_en! } : null, deviceCode: x.device_code, site: x.site_name ?? null, topScore: num(x.top_score), secondScore: num(x.second_score), antispoof: num(x.antispoof_score), liveness: num(x.liveness_score), geofence: x.geofence_result, distanceM: num(x.distance_m), gpsAccuracyM: num(x.gps_accuracy_m), direction: x.direction, rawEventId: x.raw_event_id, provider: x.provider, modelVersion: x.model_version, durationMs: x.duration_ms })), meta: pageMeta(req.query, total) };
  });

  // ── Settings (versioned) ──
  r.get('/settings', { preHandler: requirePermission('face:config:write', 'biometric:read', 'terminals:manage'), schema: { tags: ['biometric'], summary: 'Face attendance settings (current version + defaults + provider recommendations)', response: { 200: z.object({ value: z.unknown(), version: z.number(), defaults: z.unknown(), recommended: z.unknown(), provider: z.object({ code: z.string(), modelVersion: z.string(), embeddingDim: z.number(), enrolled: z.number() }), history: z.array(z.object({ version: z.number(), changedAt: z.string(), changedBy: z.string().nullable(), reason: z.string().nullable() })) }) } } }, async () => {
    const cur = await loadFaceSettings(app.db, 0);
    const prov = await faceProvider();
    const enrolled = Number((await app.db.selectFrom('biometric_face_templates').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow()).n);
    const history = await app.db.selectFrom('app_settings_history as h').leftJoin('users as u', 'u.id', 'h.changed_by').select(['h.version', 'h.changed_at', 'h.reason', 'u.display_name']).where('h.key', '=', 'attendance.face').orderBy('h.version', 'desc').limit(20).execute();
    return { value: cur.value, version: cur.version, defaults: DEFAULT_FACE_SETTINGS, recommended: prov.recommendedThresholds(), provider: { code: prov.code, modelVersion: prov.modelVersion, embeddingDim: prov.embeddingDim, enrolled }, history: history.map((h) => ({ version: h.version, changedAt: new Date(h.changed_at).toISOString(), changedBy: h.display_name ?? null, reason: h.reason })) };
  });
  r.put('/settings', { preHandler: requirePermission('face:config:write'), schema: { tags: ['biometric'], summary: 'Update face attendance settings (new version, audited)', body: z.object({ value: faceSettingsSchema, reason: z.string().max(500).optional() }), response: { 200: z.object({ version: z.number() }) } } }, async (req) => {
    const p = requireAuth(req);
    const before = await loadFaceSettings(app.db, 0);
    const res = await saveFaceSettings(app.db, req.body.value, p.userId, req.body.reason);
    await app.audit(req, { action: 'face.settings.update', entityType: 'app_settings', entityId: 'attendance.face', oldValue: before.value, newValue: req.body.value, reason: req.body.reason });
    return res;
  });

  // ── Attendance terminals (kiosks) ──
  const termOut = z.object({ id: z.string(), deviceId: z.string(), deviceCode: z.string(), name: z.string(), terminalType: z.string(), status: z.string(), site: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), pairingCode: z.string().nullable(), pairingExpiresAt: z.string().nullable(), pairedAt: z.string().nullable(), lastSeenAt: z.string().nullable(), pairedUserAgent: z.string().nullable(), createdAt: z.string() });
  const termQ = () => app.db.selectFrom('attendance_terminals as t').innerJoin('devices as d', 'd.id', 't.device_id').leftJoin('sites as s', 's.id', 'd.site_id').selectAll('t').select(['d.device_code', 'd.name', 's.id as site_id', 's.code as site_code', 's.name as site_name']);
  const termMap = (t: any) => ({ id: t.id, deviceId: t.device_id, deviceCode: t.device_code, name: t.name, terminalType: t.terminal_type, status: t.status, site: t.site_id ? { id: t.site_id, code: t.site_code, name: t.site_name } : null, pairingCode: t.status === 'PENDING' ? t.pairing_code : null, pairingExpiresAt: t.pairing_expires_at ? new Date(t.pairing_expires_at).toISOString() : null, pairedAt: t.paired_at ? new Date(t.paired_at).toISOString() : null, lastSeenAt: t.last_seen_at ? new Date(t.last_seen_at).toISOString() : null, pairedUserAgent: t.paired_user_agent, createdAt: new Date(t.created_at).toISOString() });
  r.get('/terminals', { preHandler: requirePermission('terminals:manage', 'devices:read'), schema: { tags: ['biometric'], summary: 'Attendance terminals (mobile/tablet kiosks)', response: { 200: z.array(termOut) } } }, async () => (await termQ().orderBy('t.created_at', 'desc').execute()).map(termMap));
  r.post('/terminals', { preHandler: requirePermission('terminals:manage'), schema: { tags: ['biometric'], summary: 'Register a terminal: creates a MOBILE_FACE device + a one-time pairing code (valid 24h). The kiosk enters the code at /kiosk/pair and receives its secret token.', body: z.object({ name: z.string().min(2).max(100), siteId: z.string().uuid(), terminalType: z.enum(['MOBILE_KIOSK', 'TABLET_KIOSK', 'SUPERVISOR_MOBILE']).default('TABLET_KIOSK'), deviceCode: z.string().regex(/^[A-Z0-9-]{3,30}$/).optional() }), response: { 201: termOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const site = await app.db.selectFrom('sites').select(['id', 'code', 'timezone']).where('id', '=', req.body.siteId).executeTakeFirst();
    if (!site) throw notFound('Site', req.body.siteId);
    const code = req.body.deviceCode ?? `MF-${site.code}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const pairing = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = await app.db.transaction().execute(async (trx) => {
      const d = await trx.insertInto('devices').values({ device_code: code, name: req.body.name, vendor: 'MOBILE_FACE', model: req.body.terminalType, site_id: site.id, timezone: site.timezone, status: 'UNKNOWN', config: JSON.stringify({ terminal: true }) }).returning('id').executeTakeFirstOrThrow();
      const t = await trx.insertInto('attendance_terminals').values({ device_id: d.id, terminal_type: req.body.terminalType, pairing_code: pairing, pairing_expires_at: new Date(Date.now() + 24 * 3600e3), status: 'PENDING', created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
      return t.id;
    });
    await app.audit(req, { action: 'terminal.create', entityType: 'attendance_terminal', entityId: id, newValue: { name: req.body.name, siteId: site.id, deviceCode: code, terminalType: req.body.terminalType } });
    return reply.status(201).send(termMap(await termQ().where('t.id', '=', id).executeTakeFirstOrThrow()));
  });
  r.post('/terminals/:id/revoke', { preHandler: requirePermission('terminals:manage'), schema: { tags: ['biometric'], summary: 'Revoke a terminal (its token stops working immediately)', params: idParam, body: z.object({ reason: z.string().max(500).optional() }).default({}), response: { 200: termOut } } }, async (req) => {
    const p = requireAuth(req);
    const t = await termQ().where('t.id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Terminal', req.params.id);
    await app.db.updateTable('attendance_terminals').set({ status: 'REVOKED', token_hash: null, pairing_code: null, revoked_at: new Date(), revoked_by: p.userId }).where('id', '=', t.id).execute();
    await app.db.updateTable('devices').set({ status: 'DECOMMISSIONED' }).where('id', '=', t.device_id).execute();
    await app.audit(req, { action: 'terminal.revoke', entityType: 'attendance_terminal', entityId: t.id, reason: req.body.reason });
    return termMap(await termQ().where('t.id', '=', t.id).executeTakeFirstOrThrow());
  });
  r.post('/terminals/:id/reissue', { preHandler: requirePermission('terminals:manage'), schema: { tags: ['biometric'], summary: 'Issue a new pairing code (old token is invalidated)', params: idParam, response: { 200: termOut } } }, async (req) => {
    const t = await termQ().where('t.id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Terminal', req.params.id);
    const pairing = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await app.db.updateTable('attendance_terminals').set({ status: 'PENDING', token_hash: null, pairing_code: pairing, pairing_expires_at: new Date(Date.now() + 24 * 3600e3), paired_at: null }).where('id', '=', t.id).execute();
    await app.db.updateTable('devices').set({ status: 'UNKNOWN' }).where('id', '=', t.device_id).execute();
    await app.audit(req, { action: 'terminal.reissue', entityType: 'attendance_terminal', entityId: t.id });
    return termMap(await termQ().where('t.id', '=', t.id).executeTakeFirstOrThrow());
  });

  // ── Site geofences ──
  const fenceOut = z.object({ id: z.string(), siteId: z.string(), name: z.string(), latitude: z.number(), longitude: z.number(), radiusM: z.number(), isActive: z.boolean() });
  r.get('/geofences', { preHandler: requirePermission('org:read'), schema: { tags: ['biometric'], summary: 'Sites with their primary fence and additional geofences', response: { 200: z.array(z.object({ siteId: z.string(), code: z.string(), name: z.string(), latitude: z.number().nullable(), longitude: z.number().nullable(), radiusM: z.number().nullable(), extra: z.array(fenceOut) })) } } }, async () => {
    const sites = await app.db.selectFrom('sites').select(['id', 'code', 'name', 'latitude', 'longitude', 'geofence_radius_m']).where('deleted_at', 'is', null).where('is_active', '=', true).orderBy('code').execute();
    const fences = await app.db.selectFrom('site_geofences').selectAll().execute();
    return sites.map((s) => ({ siteId: s.id, code: s.code, name: s.name, latitude: s.latitude === null ? null : Number(s.latitude), longitude: s.longitude === null ? null : Number(s.longitude), radiusM: s.geofence_radius_m, extra: fences.filter((f) => f.site_id === s.id).map((f) => ({ id: f.id, siteId: f.site_id, name: f.name, latitude: Number(f.latitude), longitude: Number(f.longitude), radiusM: f.radius_m, isActive: f.is_active })) }));
  });
  r.post('/geofences', { preHandler: requirePermission('org:write'), schema: { tags: ['biometric'], summary: 'Add an additional geofence to a site', body: z.object({ siteId: z.string().uuid(), name: z.string().min(1), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radiusM: z.number().int().min(10).max(20000) }), response: { 201: fenceOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const f = await app.db.insertInto('site_geofences').values({ site_id: req.body.siteId, name: req.body.name, latitude: req.body.latitude, longitude: req.body.longitude, radius_m: req.body.radiusM, created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'geofence.create', entityType: 'site_geofence', entityId: f.id, newValue: req.body });
    return reply.status(201).send({ id: f.id, siteId: f.site_id, name: f.name, latitude: Number(f.latitude), longitude: Number(f.longitude), radiusM: f.radius_m, isActive: f.is_active });
  });
  r.patch('/geofences/:id', { preHandler: requirePermission('org:write'), schema: { tags: ['biometric'], summary: 'Update / deactivate a geofence', params: idParam, body: z.object({ name: z.string().optional(), latitude: z.number().optional(), longitude: z.number().optional(), radiusM: z.number().int().min(10).optional(), isActive: z.boolean().optional() }), response: { 200: fenceOut } } }, async (req) => {
    const b = req.body;
    const f = await app.db.updateTable('site_geofences').set({ ...(b.name && { name: b.name }), ...(b.latitude !== undefined && { latitude: b.latitude }), ...(b.longitude !== undefined && { longitude: b.longitude }), ...(b.radiusM && { radius_m: b.radiusM }), ...(b.isActive !== undefined && { is_active: b.isActive }) }).where('id', '=', req.params.id).returningAll().executeTakeFirst();
    if (!f) throw notFound('Geofence', req.params.id);
    await app.audit(req, { action: 'geofence.update', entityType: 'site_geofence', entityId: f.id, newValue: b });
    return { id: f.id, siteId: f.site_id, name: f.name, latitude: Number(f.latitude), longitude: Number(f.longitude), radiusM: f.radius_m, isActive: f.is_active };
  });
  void badRequest;
};
