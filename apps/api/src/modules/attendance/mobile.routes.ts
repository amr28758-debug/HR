import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { getEnv } from '@burtplace/config';
import { errorSchema } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound, unauthorized, unprocessable } from '../../plugins/errors.js';
import { hasPermission } from '../../plugins/rbac.js';
import { ingestEvents } from './ingest.service.js';
import { analyzeFrame, decodeImage, faceProvider, identify, signTicket, verifyTicket } from '../biometric/face-service.js';
import { loadFaceSettings } from '../biometric/settings.js';
import { hashTerminalToken } from '../biometric/routes.js';
import { evaluateGeofence, type Fence, type Gps } from '../../integrations/face/geo.js';

/**
 * Mobile face attendance — the browser is an attendance TERMINAL, never an identity.
 *
 *   camera → (browser: detection + active liveness challenge, gating only)
 *          → POST /attendance/mobile/recognize  { frame, gps }        server: detect → anti-spoof/liveness → embed → 1:N identify
 *          ← { ticket (HMAC, short-lived), employee card, suggested direction, geofence result }
 *          → POST /attendance/mobile/punch      { ticket, direction, gps }   server: re-validate everything → EXISTING raw ledger
 *
 * Nothing sent by the browser is trusted: employee identity comes from the server's own recognition (bound into the
 * signed ticket), scores are recomputed server-side, the site comes from the terminal or the employee record, and the
 * punch time is the server clock. Modes: EMPLOYEE_MOBILE (anonymous), SUPERVISOR_MOBILE (logged-in manager/HR),
 * SITE_KIOSK (paired terminal token).
 */
type Mode = 'EMPLOYEE_MOBILE' | 'SUPERVISOR_MOBILE' | 'SITE_KIOSK';
const WORKING = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE'];
const gpsSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100000), capturedAt: z.string(), isMocked: z.boolean().nullable().optional() }).nullable().optional();
const RL = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

export const mobileAttendanceRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function terminalFromRequest(req: FastifyRequest) {
    const tok = req.headers['x-terminal-token'];
    if (typeof tok !== 'string' || !tok) return null;
    const t = await app.db.selectFrom('attendance_terminals as t').innerJoin('devices as d', 'd.id', 't.device_id').leftJoin('sites as s', 's.id', 'd.site_id').select(['t.id', 't.status', 't.terminal_type', 'd.id as device_id', 'd.device_code', 'd.name', 's.id as site_id', 's.code as site_code', 's.name as site_name', 's.timezone']).where('t.token_hash', '=', hashTerminalToken(tok)).executeTakeFirst();
    if (!t || t.status !== 'ACTIVE') throw unauthorized('Terminal token is invalid or revoked');
    void app.db.updateTable('attendance_terminals').set({ last_seen_at: new Date(), last_ip: req.ip }).where('id', '=', t.id).execute().catch(() => undefined);
    void app.db.updateTable('devices').set({ last_seen_at: new Date(), status: 'ONLINE' }).where('id', '=', t.device_id).execute().catch(() => undefined);
    return t;
  }
  function modeOf(req: FastifyRequest, terminal: { id: string } | null): Mode {
    if (terminal) return 'SITE_KIOSK';
    const p = req.principal;
    if (p && (hasPermission(p, 'attendance:read:team') || hasPermission(p, 'attendance:read') || hasPermission(p, 'employees:read:team'))) return 'SUPERVISOR_MOBILE';
    return 'EMPLOYEE_MOBILE';
  }
  async function fencesForSites(siteIds: string[]): Promise<Fence[]> {
    if (!siteIds.length) return [];
    const sites = await app.db.selectFrom('sites').select(['id', 'code', 'name', 'latitude', 'longitude', 'geofence_radius_m']).where('id', 'in', siteIds).where('is_active', '=', true).execute();
    const extra = await app.db.selectFrom('site_geofences').selectAll().where('site_id', 'in', siteIds).where('is_active', '=', true).execute();
    const out: Fence[] = [];
    for (const s of sites) if (s.latitude !== null && s.longitude !== null && s.geofence_radius_m) out.push({ name: `${s.code} · ${s.name}`, latitude: Number(s.latitude), longitude: Number(s.longitude), radiusM: s.geofence_radius_m });
    for (const f of extra) out.push({ name: f.name, latitude: Number(f.latitude), longitude: Number(f.longitude), radiusM: f.radius_m });
    return out;
  }
  /** Sites where this employee may punch: assigned site + sites of the assigned project. */
  async function employeeSiteIds(emp: { site_id: string | null; project_id: string | null }): Promise<string[]> {
    const ids = new Set<string>(); if (emp.site_id) ids.add(emp.site_id);
    if (emp.project_id) for (const s of await app.db.selectFrom('sites').select('id').where('project_id', '=', emp.project_id).where('is_active', '=', true).execute()) ids.add(s.id);
    return [...ids];
  }
  async function lastPunch(employeeId: string) {
    return app.db.selectFrom('attendance_raw_events').select(['punched_at', 'direction', 'source']).where('employee_id', '=', employeeId).where('punched_at', '>=', new Date(Date.now() - 20 * 3600e3)).orderBy('punched_at', 'desc').executeTakeFirst();
  }
  async function ensureVirtualDevice(): Promise<string> {
    const code = 'MOBILE-WEB';
    const d = await app.db.selectFrom('devices').select('id').where('device_code', '=', code).executeTakeFirst();
    if (!d) await app.db.insertInto('devices').values({ device_code: code, name: 'Mobile web attendance (employee / supervisor phones)', vendor: 'MOBILE_FACE', model: 'BROWSER', status: 'ONLINE', config: JSON.stringify({ virtual: true }) }).execute();
    return code;
  }
  const logEvent = async (e: Record<string, unknown>) => (await app.db.insertInto('face_recognition_events').values(e as any).returning('id').executeTakeFirstOrThrow()).id;
  const publicCard = (e: { id: string; employee_no: string; full_name_en: string; full_name_ar: string | null; designation: string | null; site_name: string | null; project_name: string | null; photo_object_key: string | null }, showPhoto: boolean) => ({ id: e.id, employeeNo: e.employee_no, name: e.full_name_en, nameAr: e.full_name_ar, designation: e.designation, site: e.site_name, project: e.project_name, photoObjectKey: showPhoto ? e.photo_object_key : null });

  // ── Public config for the attendance page (no secrets) ──
  r.get('/mobile/config', { config: RL(120), schema: { tags: ['attendance'], summary: 'Mobile face attendance: public runtime configuration (modes, client-side gating thresholds, provider)', security: [], querystring: z.object({ siteCode: z.string().optional() }), response: { 200: z.object({ enabled: z.boolean(), modes: z.object({ employeeMobile: z.boolean(), supervisorMobile: z.boolean(), siteKiosk: z.boolean() }), mode: z.string(), provider: z.string(), thresholds: z.object({ faceQuality: z.number(), minFaceSizePx: z.number(), maxYawRad: z.number(), antispoof: z.number(), liveness: z.number() }), liveness: z.object({ required: z.boolean(), activeChallenge: z.boolean(), challengeTimeoutSeconds: z.number() }), gps: z.object({ required: z.boolean(), geofenceRequired: z.boolean(), accuracyLimitM: z.number() }), duplicateWindowSeconds: z.number(), ticketTtlSeconds: z.number(), showPhoto: z.boolean(), terminal: z.object({ name: z.string(), deviceCode: z.string(), site: z.object({ code: z.string(), name: z.string() }).nullable() }).nullable(), site: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), serverTime: z.string(), offline: z.object({ queueEnabled: z.boolean() }) }) } } }, async (req) => {
    const cfg = (await loadFaceSettings(app.db)).value;
    const terminal = await terminalFromRequest(req);
    const mode = modeOf(req, terminal);
    const site = req.query.siteCode ? await app.db.selectFrom('sites').select(['id', 'code', 'name']).where('code', '=', req.query.siteCode.toUpperCase()).where('is_active', '=', true).executeTakeFirst() : null;
    const prov = await faceProvider();
    const gpsRequired = mode === 'SITE_KIOSK' ? cfg.gps.kioskGpsRequired : cfg.gps.required;
    return { enabled: cfg.enabled, modes: cfg.modes, mode, provider: prov.code, thresholds: { faceQuality: cfg.thresholds.faceQuality, minFaceSizePx: cfg.thresholds.minFaceSizePx, maxYawRad: cfg.thresholds.maxYawRad, antispoof: cfg.thresholds.antispoof, liveness: cfg.thresholds.liveness }, liveness: cfg.liveness, gps: { required: gpsRequired, geofenceRequired: gpsRequired && cfg.gps.geofenceRequired, accuracyLimitM: cfg.gps.accuracyLimitM }, duplicateWindowSeconds: cfg.duplicateWindowSeconds, ticketTtlSeconds: cfg.ticketTtlSeconds, showPhoto: cfg.privacy.showPhotoOnKiosk, terminal: terminal ? { name: terminal.name, deviceCode: terminal.device_code, site: terminal.site_id ? { code: terminal.site_code!, name: terminal.site_name! } : null } : null, site: site ?? null, serverTime: new Date().toISOString(), offline: { queueEnabled: cfg.offline.queueEnabled } };
  });

  // ── Terminal pairing (one-time code → secret token) ──
  r.post('/mobile/terminals/pair', { config: RL(10), schema: { tags: ['attendance'], summary: 'Pair a kiosk device with a one-time pairing code; returns the terminal token (shown once, stored on the device only)', security: [], body: z.object({ pairingCode: z.string().regex(/^\d{6}$/), userAgent: z.string().max(300).optional() }), response: { 200: z.object({ token: z.string(), terminal: z.object({ id: z.string(), name: z.string(), deviceCode: z.string(), site: z.object({ code: z.string(), name: z.string() }).nullable() }) }), 401: errorSchema } } }, async (req) => {
    const t = await app.db.selectFrom('attendance_terminals as t').innerJoin('devices as d', 'd.id', 't.device_id').leftJoin('sites as s', 's.id', 'd.site_id').select(['t.id', 't.pairing_expires_at', 'd.device_code', 'd.name', 's.code as site_code', 's.name as site_name']).where('t.pairing_code', '=', req.body.pairingCode).where('t.status', '=', 'PENDING').executeTakeFirst();
    if (!t || !t.pairing_expires_at || new Date(t.pairing_expires_at) < new Date()) throw unauthorized('Pairing code is invalid or expired');
    const token = `bpt_${randomBytes(24).toString('base64url')}`;
    await app.db.updateTable('attendance_terminals').set({ token_hash: hashTerminalToken(token), pairing_code: null, status: 'ACTIVE', paired_at: new Date(), paired_user_agent: (req.body.userAgent ?? req.headers['user-agent'] ?? '').toString().slice(0, 300), last_seen_at: new Date(), last_ip: req.ip }).where('id', '=', t.id).execute();
    await app.audit(req, { action: 'terminal.pair', entityType: 'attendance_terminal', entityId: t.id, newValue: { deviceCode: t.device_code, ip: req.ip } });
    return { token, terminal: { id: t.id, name: t.name, deviceCode: t.device_code, site: t.site_code ? { code: t.site_code, name: t.site_name! } : null } };
  });

  // ── Step 1: recognise ──
  const cardOut = z.object({ id: z.string(), employeeNo: z.string(), name: z.string(), nameAr: z.string().nullable(), designation: z.string().nullable(), site: z.string().nullable(), project: z.string().nullable(), photoObjectKey: z.string().nullable() });
  r.post('/mobile/recognize', { config: RL(40), schema: { tags: ['attendance'], summary: '1:N face identification of one camera frame (server-side detection, anti-spoof, liveness, embedding, index search). Returns a short-lived signed ticket on success.', security: [], body: z.object({ frame: z.string().min(100), gps: gpsSchema, siteCode: z.string().optional(), clientSignals: z.object({ activeChallengePassed: z.boolean().optional(), challenge: z.string().optional(), userAgent: z.string().max(300).optional() }).optional() }), response: { 200: z.object({ outcome: z.string(), reason: z.string().nullable(), ticket: z.string().nullable(), expiresAt: z.string().nullable(), employee: cardOut.nullable(), suggestedDirection: z.enum(['IN', 'OUT']).nullable(), lastPunch: z.object({ at: z.string(), direction: z.string() }).nullable(), geofence: z.object({ result: z.string(), distanceM: z.number().nullable(), fence: z.string().nullable() }), scores: z.object({ match: z.number().nullable(), antispoof: z.number().nullable(), liveness: z.number().nullable() }), mode: z.string(), serverTime: z.string() }), 403: errorSchema, 503: errorSchema } } }, async (req) => {
    const t0 = Date.now();
    const cfg = (await loadFaceSettings(app.db)).value;
    if (!cfg.enabled) throw Object.assign(new Error('Mobile face attendance is disabled'), { statusCode: 503 });
    const terminal = await terminalFromRequest(req);
    const mode = modeOf(req, terminal);
    if ((mode === 'EMPLOYEE_MOBILE' && !cfg.modes.employeeMobile) || (mode === 'SUPERVISOR_MOBILE' && !cfg.modes.supervisorMobile) || (mode === 'SITE_KIOSK' && !cfg.modes.siteKiosk)) throw forbidden(`${mode} is disabled by configuration`);
    const gps = req.body.gps ? (req.body.gps as Gps) : null;
    const base = { attendance_mode: mode, terminal_id: terminal?.id ?? null, device_code: terminal?.device_code ?? 'MOBILE-WEB', site_id: terminal?.site_id ?? null, latitude: gps?.latitude ?? null, longitude: gps?.longitude ?? null, gps_accuracy_m: gps?.accuracyM ?? null, actor_user_id: req.principal?.userId ?? null, ip_address: req.ip, user_agent: (req.body.clientSignals?.userAgent ?? req.headers['user-agent'] ?? '').toString().slice(0, 300) };
    const prov = await faceProvider();
    const fail = async (outcome: string, reason: string, extra: Record<string, unknown> = {}) => {
      await logEvent({ ...base, outcome, reason, provider: prov.code, model_version: prov.modelVersion, duration_ms: Date.now() - t0, ...extra });
      return { outcome, reason, ticket: null, expiresAt: null, employee: null, suggestedDirection: null, lastPunch: null, geofence: { result: 'NOT_REQUIRED', distanceM: null, fence: null }, scores: { match: (extra.top_score as number) ?? null, antispoof: (extra.antispoof_score as number) ?? null, liveness: (extra.liveness_score as number) ?? null }, mode, serverTime: new Date().toISOString() };
    };
    // Active challenge: when required, the browser must report it passed (server still recomputes passive scores)
    if (cfg.liveness.required && cfg.liveness.activeChallenge && !req.body.clientSignals?.activeChallengePassed) return fail('LIVENESS_FAILED', 'Live person verification not completed (blink or turn your head when asked)');
    const a = await analyzeFrame(decodeImage(req.body.frame), cfg, 'RECOGNIZE');
    if (a.outcome !== 'OK' || !a.face) return fail(a.outcome, a.reason ?? a.outcome, { quality: JSON.stringify(a.quality), antispoof_score: a.face?.antispoof ?? null, liveness_score: a.face?.liveness ?? null });
    const id = await identify(app, a.face.embedding, cfg);
    const scores = { antispoof_score: a.face.antispoof, liveness_score: a.face.liveness, top_score: id.top?.similarity ?? null, second_score: id.second?.similarity ?? null, quality: JSON.stringify(a.quality) };
    if (id.outcome !== 'MATCHED' || !id.top) return fail(id.outcome, id.outcome === 'AMBIGUOUS' ? 'Unable to confidently identify employee' : id.outcome === 'LOW_CONFIDENCE' ? 'Face not recognized (low confidence)' : 'Face not recognized', scores);
    // Employee eligibility
    const emp = await app.db.selectFrom('employees as e').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('sites as s', 's.id', 'e.site_id').leftJoin('projects as pr', 'pr.id', 'e.project_id').select(['e.id', 'e.employee_no', 'e.full_name_en', 'e.full_name_ar', 'e.status', 'e.site_id', 'e.project_id', 'e.photo_object_key', 'g.title as designation', 's.name as site_name', 'pr.name as project_name']).where('e.id', '=', id.top.employeeId).where('e.deleted_at', 'is', null).executeTakeFirst();
    if (!emp) return fail('REJECTED', 'Employee record not found', { ...scores, employee_id: id.top.employeeId });
    if (!WORKING.includes(emp.status)) return fail('REJECTED', `Employee is ${emp.status.toLowerCase()} — attendance not allowed`, { ...scores, employee_id: emp.id });
    // Kiosk site restriction: employee must belong to the terminal's site/project (unless HR permits any site later via config)
    if (terminal?.site_id) { const allowed = await employeeSiteIds(emp); if (allowed.length && !allowed.includes(terminal.site_id)) return fail('REJECTED', 'Employee is not assigned to this site', { ...scores, employee_id: emp.id }); }
    // Geofence (employee/supervisor modes use the employee's sites; kiosk uses the terminal site)
    const gpsRequired = mode === 'SITE_KIOSK' ? cfg.gps.kioskGpsRequired : cfg.gps.required;
    const fences = await fencesForSites(terminal?.site_id ? [terminal.site_id] : await employeeSiteIds(emp));
    const prevEv = await app.db.selectFrom('face_recognition_events').select(['latitude', 'longitude', 'occurred_at']).where('employee_id', '=', emp.id).where('latitude', 'is not', null).orderBy('occurred_at', 'desc').executeTakeFirst();
    const geo = evaluateGeofence(gps, fences, { gpsRequired, geofenceRequired: gpsRequired && cfg.gps.geofenceRequired, gpsAccuracyLimitM: cfg.gps.accuracyLimitM, maxFixAgeSeconds: cfg.gps.maxFixAgeSeconds }, prevEv?.latitude !== null && prevEv ? { latitude: Number(prevEv.latitude), longitude: Number(prevEv.longitude), at: new Date(prevEv.occurred_at).toISOString() } : null);
    const geoOut = { result: geo.result, distanceM: geo.distanceM, fence: geo.fence };
    const hardReject = (geo.result === 'NO_GPS' && gpsRequired) || (geo.result === 'OUTSIDE' && cfg.behaviour.outsideGeofence === 'REJECT') || (geo.result === 'LOW_ACCURACY' && cfg.behaviour.lowAccuracy === 'REJECT') || (geo.result === 'SUSPICIOUS' && cfg.behaviour.suspiciousGps === 'REJECT') || (geo.result === 'NO_FENCE' && cfg.gps.geofenceRequired && gpsRequired);
    const reasonFor: Record<string, string> = { NO_GPS: 'Location is required for attendance', OUTSIDE: 'You are outside the permitted attendance area', LOW_ACCURACY: 'GPS accuracy is insufficient', SUSPICIOUS: 'Location could not be trusted', NO_FENCE: 'No geofence is configured for your site — contact HR' };
    const last = await lastPunch(emp.id);
    const dupWindow = last && Date.now() - new Date(last.punched_at).getTime() < cfg.duplicateWindowSeconds * 1000;
    const eventId = await logEvent({ ...base, site_id: terminal?.site_id ?? emp.site_id, outcome: hardReject ? 'REJECTED' : dupWindow ? 'REJECTED' : 'MATCHED', reason: hardReject ? reasonFor[geo.result] : dupWindow ? 'Attendance already recorded' : null, employee_id: emp.id, ...scores, geofence_result: geo.result, distance_m: geo.distanceM, provider: prov.code, model_version: prov.modelVersion, duration_ms: Date.now() - t0 });
    const card = publicCard(emp, mode !== 'SITE_KIOSK' || cfg.privacy.showPhotoOnKiosk);
    if (hardReject) return { outcome: 'REJECTED', reason: reasonFor[geo.result] ?? 'Location check failed', ticket: null, expiresAt: null, employee: card, suggestedDirection: null, lastPunch: last ? { at: new Date(last.punched_at).toISOString(), direction: last.direction } : null, geofence: geoOut, scores: { match: id.top.similarity, antispoof: a.face.antispoof, liveness: a.face.liveness }, mode, serverTime: new Date().toISOString() };
    if (dupWindow) return { outcome: 'DUPLICATE', reason: `Attendance already recorded at ${new Date(last!.punched_at).toISOString()}`, ticket: null, expiresAt: null, employee: card, suggestedDirection: null, lastPunch: { at: new Date(last!.punched_at).toISOString(), direction: last!.direction }, geofence: geoOut, scores: { match: id.top.similarity, antispoof: a.face.antispoof, liveness: a.face.liveness }, mode, serverTime: new Date().toISOString() };
    const exp = Math.floor(Date.now() / 1000) + cfg.ticketTtlSeconds;
    const ticket = signTicket({ employeeId: emp.id, mode, terminalId: terminal?.id ?? null, siteId: terminal?.site_id ?? emp.site_id ?? null, eventId: Number(eventId), iat: Math.floor(Date.now() / 1000), exp, score: id.top.similarity, live: a.face.liveness ?? 0, spoof: a.face.antispoof ?? 0 });
    return { outcome: 'MATCHED', reason: null, ticket, expiresAt: new Date(exp * 1000).toISOString(), employee: card, suggestedDirection: (last && last.direction === 'IN' ? 'OUT' : 'IN') as 'IN' | 'OUT', lastPunch: last ? { at: new Date(last.punched_at).toISOString(), direction: last.direction } : null, geofence: geoOut, scores: { match: id.top.similarity, antispoof: a.face.antispoof, liveness: a.face.liveness }, mode, serverTime: new Date().toISOString() };
  });

  // ── Step 2: punch ──
  r.post('/mobile/punch', { config: RL(40), schema: { tags: ['attendance'], summary: 'Create the attendance punch for a recognised employee (ticket from /recognize). Enters the EXISTING immutable raw ledger with source MOBILE_FACE and triggers the attendance engine.', security: [], body: z.object({ ticket: z.string().min(20), direction: z.enum(['IN', 'OUT']), gps: gpsSchema, capturedAt: z.string().datetime().optional() }), response: { 200: z.object({ outcome: z.string(), reason: z.string().nullable(), rawEventId: z.string().nullable(), punchedAt: z.string(), direction: z.string(), employee: cardOut, site: z.string().nullable(), geofence: z.string(), flagged: z.array(z.string()) }), 401: errorSchema, 409: errorSchema, 422: errorSchema } } }, async (req) => {
    const cfg = (await loadFaceSettings(app.db)).value;
    const tk = verifyTicket(req.body.ticket);
    if (!tk) throw unauthorized('Recognition ticket is invalid or expired — look at the camera again');
    const terminal = await terminalFromRequest(req);
    const mode = modeOf(req, terminal);
    if (tk.mode !== mode || (tk.terminalId ?? null) !== (terminal?.id ?? null)) throw unauthorized('Ticket was issued for a different terminal/mode');
    const emp = await app.db.selectFrom('employees as e').leftJoin('designations as g', 'g.id', 'e.designation_id').leftJoin('sites as s', 's.id', 'e.site_id').leftJoin('projects as pr', 'pr.id', 'e.project_id').select(['e.id', 'e.employee_no', 'e.full_name_en', 'e.full_name_ar', 'e.status', 'e.site_id', 'e.project_id', 'e.photo_object_key', 'g.title as designation', 's.name as site_name', 'pr.name as project_name']).where('e.id', '=', tk.employeeId).where('e.deleted_at', 'is', null).executeTakeFirst();
    if (!emp) throw notFound('Employee');
    if (!WORKING.includes(emp.status)) throw unprocessable(`Employee is ${emp.status.toLowerCase()} — attendance not allowed`);
    // Re-validate GPS at punch time (the fix may have changed since recognition)
    const gps = req.body.gps ? (req.body.gps as Gps) : null;
    const gpsRequired = mode === 'SITE_KIOSK' ? cfg.gps.kioskGpsRequired : cfg.gps.required;
    const fences = await fencesForSites(terminal?.site_id ? [terminal.site_id] : await employeeSiteIds(emp));
    const geo = evaluateGeofence(gps, fences, { gpsRequired, geofenceRequired: gpsRequired && cfg.gps.geofenceRequired, gpsAccuracyLimitM: cfg.gps.accuracyLimitM, maxFixAgeSeconds: cfg.gps.maxFixAgeSeconds });
    const flagged: string[] = [];
    const reject = (reason: string) => { throw unprocessable(reason); };
    if (geo.result === 'NO_GPS' && gpsRequired) reject('Location is required for attendance');
    if (geo.result === 'OUTSIDE') { if (cfg.behaviour.outsideGeofence === 'REJECT') reject('You are outside the permitted attendance area'); flagged.push('OUTSIDE_SITE'); }
    if (geo.result === 'LOW_ACCURACY') { if (cfg.behaviour.lowAccuracy === 'REJECT') reject('GPS accuracy is insufficient'); flagged.push('LOW_ACCURACY'); }
    if (geo.result === 'SUSPICIOUS') { if (cfg.behaviour.suspiciousGps === 'REJECT') reject('Location could not be trusted'); flagged.push('LOCATION_SUSPICIOUS'); }
    if (geo.result === 'NO_FENCE' && gpsRequired && cfg.gps.geofenceRequired) reject('No geofence is configured for your site — contact HR');
    // Duplicate / too-fast protection (server clock)
    const last = await lastPunch(emp.id);
    if (last && Date.now() - new Date(last.punched_at).getTime() < cfg.duplicateWindowSeconds * 1000) throw Object.assign(new Error(`Attendance already recorded at ${new Date(last.punched_at).toISOString()}`), { statusCode: 409 });
    // Offline queue: honour the original capture time only when enabled and within the allowed age
    let punchedAt = new Date();
    if (req.body.capturedAt && cfg.offline.queueEnabled) { const c = new Date(req.body.capturedAt); if (c.getTime() < Date.now() && Date.now() - c.getTime() <= cfg.offline.maxQueueAgeHours * 3600e3) punchedAt = c; }
    const deviceCode = terminal?.device_code ?? (await ensureVirtualDevice());
    const res = await ingestEvents(app.db, [{ externalUserId: emp.employee_no, deviceCode, punchedAt, direction: req.body.direction, verificationMethod: 'FACE', vendorPayload: { source: 'MOBILE_FACE', mode, terminalId: terminal?.id ?? null, recognitionEventId: tk.eventId, faceMatchScore: tk.score, livenessScore: tk.live, antispoofScore: tk.spoof, provider: (await faceProvider()).code, geofence: geo.result, gpsAccuracyM: gps?.accuracyM ?? null } }], 'MOBILE_FACE', req.principal?.userId ?? null);
    const rawEventId = res.rawEventIds[0] ?? null;
    if (!rawEventId) throw Object.assign(new Error('Duplicate event'), { statusCode: 409 });
    for (const f of flagged) await app.db.insertInto('attendance_exceptions').values({ employee_id: emp.id, attendance_date: punchedAt.toISOString().slice(0, 10), exception_type: f === 'OUTSIDE_SITE' ? 'OUTSIDE_SITE' : 'INVALID_PUNCH', severity: f === 'LOCATION_SUSPICIOUS' ? 'HIGH' : 'MEDIUM', details: JSON.stringify({ flag: f, geofence: geo.result, distanceM: geo.distanceM, gpsAccuracyM: gps?.accuracyM ?? null, suspicious: geo.suspiciousReasons, source: 'MOBILE_FACE' }), raw_event_id: rawEventId }).execute();
    await app.queues.enqueueProcessAffected(res.affectedEmployeeDates);
    const prov = await faceProvider();
    await logEvent({ attendance_mode: mode, terminal_id: terminal?.id ?? null, device_code: deviceCode, site_id: terminal?.site_id ?? emp.site_id ?? null, outcome: 'PUNCHED', reason: flagged.length ? flagged.join(',') : null, employee_id: emp.id, top_score: tk.score, antispoof_score: tk.spoof, liveness_score: tk.live, latitude: gps?.latitude ?? null, longitude: gps?.longitude ?? null, gps_accuracy_m: gps?.accuracyM ?? null, geofence_result: geo.result, distance_m: geo.distanceM, direction: req.body.direction, raw_event_id: rawEventId, provider: prov.code, model_version: prov.modelVersion, actor_user_id: req.principal?.userId ?? null, ip_address: req.ip, user_agent: (req.headers['user-agent'] ?? '').toString().slice(0, 300) });
    await app.audit(req, { action: 'attendance.mobile.punch', entityType: 'attendance_raw_event', entityId: rawEventId, newValue: { employeeId: emp.id, employeeNo: emp.employee_no, direction: req.body.direction, mode, deviceCode, site: terminal?.site_code ?? emp.site_name, geofence: geo.result, gpsAccuracyM: gps?.accuracyM ?? null, faceMatchScore: tk.score, livenessScore: tk.live, provider: prov.code, modelVersion: prov.modelVersion, flagged } });
    return { outcome: 'PUNCHED', reason: flagged.length ? `Recorded with review flags: ${flagged.join(', ')}` : null, rawEventId, punchedAt: punchedAt.toISOString(), direction: req.body.direction, employee: publicCard(emp, mode !== 'SITE_KIOSK' || cfg.privacy.showPhotoOnKiosk), site: terminal?.site_name ?? emp.site_name ?? null, geofence: geo.result, flagged };
  });
  void badRequest; void getEnv;
};
