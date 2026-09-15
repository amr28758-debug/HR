import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { login, testApp, type App, type Client } from './helpers.js';
import { evaluateGeofence, haversineM } from '../src/integrations/face/geo.js';
import { decideIdentification } from '../src/integrations/face/index-service.js';
import { invalidateFaceIndex } from '../src/modules/biometric/face-service.js';

/**
 * Mobile face attendance: enrollment → 1:N recognition → GPS/geofence → punch into the existing raw ledger.
 * Uses three AI-generated sample images of ONE synthetic person shipped with @vladmandic/human (MIT) as fixtures.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const frame = (n: string) => `data:image/jpeg;base64,${readFileSync(path.join(dir, 'fixtures', n)).toString('base64')}`;
const FRONT = frame('ai-face.jpg'), LEFT = frame('ai-upper.jpg'), RIGHT = frame('ai-body.jpg');
const SITE = { latitude: 24.4539, longitude: 54.3773 }; // example coordinates used only for tests
const gpsInside = () => ({ ...SITE, accuracyM: 12, capturedAt: new Date().toISOString() });
const signals = { activeChallengePassed: true, challenge: 'blink' };

let app: App, hrm: Client, it_: Client, self: Client, payroll: Client, anon: Client;
let emp: { id: string; no: string; siteId: string }, other: { id: string };
let settingsV1: any;
const settings = async (patch: (v: any) => void) => { const cur = (await hrm.get('/api/v1/biometric/settings')).body.value; patch(cur); const r = await hrm.put('/api/v1/biometric/settings', { value: cur, reason: 'test' }); expect(r.status, JSON.stringify(r.body)).toBe(200); };

beforeAll(async () => {
  app = await testApp(); await app.ready();
  hrm = await login(app, 'hr.manager@burtplace.local'); it_ = await login(app, 'it.admin@burtplace.local'); self = await login(app, 'employee@burtplace.local'); payroll = await login(app, 'payroll@burtplace.local');
  anon = { get: (u) => app.inject({ method: 'GET', url: u }).then((r) => ({ status: r.statusCode, body: r.json(), text: r.body })), post: (u, b) => app.inject({ method: 'POST', url: u, payload: b }).then((r) => ({ status: r.statusCode, body: (() => { try { return r.json(); } catch { return null; } })(), text: r.body })), patch: async () => { throw new Error('n/a'); }, put: async () => { throw new Error('n/a'); }, del: async () => { throw new Error('n/a'); } };
  const e = await app.db.selectFrom('employees').select(['id', 'employee_no', 'site_id']).where('employee_no', '=', 'BP-26-150').executeTakeFirstOrThrow();
  emp = { id: e.id, no: e.employee_no, siteId: e.site_id! };
  other = { id: (await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-151').executeTakeFirstOrThrow()).id };
  await app.db.updateTable('sites').set({ latitude: SITE.latitude, longitude: SITE.longitude, geofence_radius_m: 150 }).where('id', '=', emp.siteId).execute();
  settingsV1 = (await hrm.get('/api/v1/biometric/settings')).body;
}, 120_000);
afterAll(async () => {
  // Restore shared seed state for the other suites (suites share one database and run in an arbitrary order)
  await app.db.updateTable('employees').set({ status: 'ACTIVE', last_working_date: null }).where('employee_no', 'in', ['BP-26-150', 'BP-26-152']).execute();
  await app.close();
});

describe('geofence & identification decision logic (pure)', () => {
  it('haversine and fence evaluation with accuracy slack, low accuracy, stale/mocked fixes', () => {
    expect(Math.round(haversineM(24.4539, 54.3773, 24.4539, 54.3873))).toBeGreaterThan(1000);
    const cfg = { gpsRequired: true, geofenceRequired: true, gpsAccuracyLimitM: 100, maxFixAgeSeconds: 90 };
    const fences = [{ name: 'C55', ...SITE, radiusM: 150 }];
    expect(evaluateGeofence(gpsInside(), fences, cfg).result).toBe('INSIDE');
    expect(evaluateGeofence({ ...gpsInside(), latitude: 24.46 }, fences, cfg).result).toBe('OUTSIDE');
    expect(evaluateGeofence({ ...gpsInside(), accuracyM: 500 }, fences, cfg).result).toBe('LOW_ACCURACY');
    expect(evaluateGeofence(null, fences, cfg).result).toBe('NO_GPS');
    expect(evaluateGeofence({ ...gpsInside(), isMocked: true }, fences, cfg).result).toBe('SUSPICIOUS');
    expect(evaluateGeofence({ ...gpsInside(), capturedAt: new Date(Date.now() - 600e3).toISOString() }, fences, cfg).suspiciousReasons).toContain('STALE_FIX');
    expect(evaluateGeofence(gpsInside(), fences, cfg, { latitude: 25.2, longitude: 55.3, at: new Date(Date.now() - 60e3).toISOString() }).suspiciousReasons).toContain('IMPOSSIBLE_TRAVEL');
    expect(evaluateGeofence(gpsInside(), [], cfg).result).toBe('NO_FENCE');
    expect(evaluateGeofence(null, fences, { ...cfg, gpsRequired: false, geofenceRequired: false }).result).toBe('NOT_REQUIRED');
  });
  it('threshold / ambiguity decisions', () => {
    const c = (employeeId: string, similarity: number) => ({ employeeId, employeeNo: employeeId, templateId: 't', similarity });
    const cfg = { matchThreshold: 0.5, ambiguityMargin: 0.05 };
    expect(decideIdentification([], cfg).outcome).toBe('NO_MATCH');
    expect(decideIdentification([c('a', 0.3)], cfg).outcome).toBe('NO_MATCH');
    expect(decideIdentification([c('a', 0.42)], cfg).outcome).toBe('LOW_CONFIDENCE');
    expect(decideIdentification([c('a', 0.7), c('b', 0.68)], cfg).outcome).toBe('AMBIGUOUS');
    expect(decideIdentification([c('a', 0.7), c('b', 0.4)], cfg).outcome).toBe('MATCHED');
  });
});

describe('enrollment (RBAC, quality, consistency)', () => {
  it('HR manager enrolls from frontal + slight-left frames; template is encrypted and index refreshed', async () => {
    const r = await hrm.post(`/api/v1/biometric/employees/${emp.id}/enroll`, { frames: [FRONT, LEFT], consentNote: 'Consent form BF-01 signed (test)' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sampleCount).toBe(2);
    expect(r.body.provider).toBe('HUMAN');
    expect(r.body.consistency).toBeGreaterThanOrEqual(0.5);
    const row = await app.db.selectFrom('biometric_face_templates').select(['embedding_enc', 'embedding_dim', 'status']).where('employee_id', '=', emp.id).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
    expect(row.embedding_dim).toBe(1024);
    expect(Buffer.from(row.embedding_enc as any).length).toBe(28 + 1024 * 4 * 3); // iv + tag + ciphertext(2 samples + average)
    const st = await hrm.get(`/api/v1/biometric/employees/${emp.id}/status`);
    expect(st.body.enrolled).toBe(true); expect(st.body.recognitionEnabled).toBe(true); expect(st.body.modelVersion).toMatch(/^human-/);
    const map = await app.db.selectFrom('biometric_mappings').select('is_active').where('employee_id', '=', emp.id).where('provider', '=', 'MOBILE_FACE').executeTakeFirstOrThrow();
    expect(map.is_active).toBe(true);
  }, 60_000);
  it('rejects a frame with no face and a second employee whose face duplicates an enrolled one', async () => {
    const blank = `data:image/jpeg;base64,${Buffer.from(readFileSync(path.join(dir, 'fixtures', 'ai-face.jpg'))).subarray(0, 600).toString('base64')}`;
    const r = await hrm.post(`/api/v1/biometric/employees/${other.id}/enroll`, { frames: [blank] });
    expect([400, 422]).toContain(r.status);
    const dup = await hrm.post(`/api/v1/biometric/employees/${other.id}/enroll`, { frames: [FRONT] });
    expect(dup.status, JSON.stringify(dup.body)).toBe(422);
    expect(dup.body.error.message).toMatch(/already matches enrolled employee/);
  }, 60_000);
  it('RBAC: employees cannot enroll (even themselves), payroll cannot enroll, only biometric:delete may delete, self-status is own-only', async () => {
    const selfEmp = (await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-020').executeTakeFirstOrThrow()).id;
    expect((await self.post(`/api/v1/biometric/employees/${selfEmp}/enroll`, { frames: [FRONT] })).status).toBe(403);
    expect((await payroll.post(`/api/v1/biometric/employees/${emp.id}/enroll`, { frames: [FRONT] })).status).toBe(403);
    expect((await it_.del(`/api/v1/biometric/employees/${emp.id}/template`)).status).toBe(403);
    expect((await self.get(`/api/v1/biometric/employees/${selfEmp}/status`)).status).toBe(200);
    expect((await self.get(`/api/v1/biometric/employees/${emp.id}/status`)).status).toBe(403);
    expect((await self.get('/api/v1/biometric/settings')).status).toBe(403);
    expect((await payroll.post('/api/v1/biometric/terminals', { name: 'Gate kiosk', siteId: emp.siteId, terminalType: 'MOBILE_KIOSK' })).status).toBe(403);
  });
});

describe('recognition → punch (employee mobile mode, anonymous)', () => {
  let ticket: string;
  it('identifies the employee from a different frame, returns a ticket and suggests CHECK IN', async () => {
    const r = await anon.post('/api/v1/attendance/mobile/recognize', { frame: RIGHT, gps: gpsInside(), clientSignals: signals });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe('MATCHED');
    expect(r.body.employee.employeeNo).toBe(emp.no);
    expect(r.body.employee).not.toHaveProperty('salary');
    expect(r.body.suggestedDirection).toBe('IN');
    expect(r.body.geofence.result).toBe('INSIDE');
    expect(r.body.scores.match).toBeGreaterThanOrEqual(0.5);
    expect(r.body.mode).toBe('EMPLOYEE_MOBILE');
    ticket = r.body.ticket;
  }, 60_000);
  it('punch IN enters the immutable raw ledger with source MOBILE_FACE and is processed by the attendance engine', async () => {
    const r = await anon.post('/api/v1/attendance/mobile/punch', { ticket, direction: 'IN', gps: gpsInside() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe('PUNCHED'); expect(r.body.flagged).toEqual([]);
    const raw = await app.db.selectFrom('attendance_raw_events').selectAll().where('id', '=', r.body.rawEventId).executeTakeFirstOrThrow();
    expect(raw.source).toBe('MOBILE_FACE'); expect(raw.direction).toBe('IN'); expect(raw.employee_id).toBe(emp.id); expect(raw.verification_method).toBe('FACE'); expect(raw.device_code).toBe('MOBILE-WEB');
    expect((raw.vendor_payload as any).faceMatchScore).toBeGreaterThan(0);
    expect(JSON.stringify(raw.vendor_payload)).not.toMatch(/embedding/);
    const ev = await app.db.selectFrom('face_recognition_events').select(['outcome', 'raw_event_id']).where('employee_id', '=', emp.id).orderBy('occurred_at', 'desc').executeTakeFirst();
    expect(ev?.outcome).toBe('PUNCHED'); expect(ev?.raw_event_id).toBe(raw.id);
    const audit = await app.db.selectFrom('audit_logs').select('new_value').where('entity_id', '=', raw.id).where('action', '=', 'attendance.mobile.punch').executeTakeFirst();
    expect(JSON.stringify(audit?.new_value)).not.toMatch(/embedding/);
  });
  it('duplicate protection: a second scan inside the window is ignored, a replayed ticket is refused', async () => {
    const r = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: gpsInside(), clientSignals: signals });
    expect(r.body.outcome).toBe('DUPLICATE'); expect(r.body.ticket).toBeNull();
    const p = await anon.post('/api/v1/attendance/mobile/punch', { ticket, direction: 'OUT', gps: gpsInside() });
    expect(p.status).toBe(409);
  }, 60_000);
  it('security: forged / tampered tickets and client-supplied ids are rejected', async () => {
    const [body, mac] = ticket.split('.');
    const forged = JSON.parse(Buffer.from(body!, 'base64url').toString()); forged.employeeId = other.id;
    expect((await anon.post('/api/v1/attendance/mobile/punch', { ticket: `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`, direction: 'IN', gps: gpsInside() })).status).toBe(401);
    expect((await anon.post('/api/v1/attendance/mobile/punch', { ticket: 'abcdefghijklmnopqrstuvwxyz.def', direction: 'IN' })).status).toBe(401);
    // there is no endpoint that accepts an employeeId for punching
    expect((await anon.post(`/api/v1/attendance/mobile/punch/${emp.id}`, { direction: 'IN' })).status).toBe(404);
  });
  it('after the duplicate window, CHECK OUT is suggested and recorded', async () => {
    await settings((v) => { v.duplicateWindowSeconds = 5; });
    await new Promise((res) => setTimeout(res, 5200));
    const r = await anon.post('/api/v1/attendance/mobile/recognize', { frame: RIGHT, gps: gpsInside(), clientSignals: signals });
    expect(r.body.outcome).toBe('MATCHED'); expect(r.body.suggestedDirection).toBe('OUT'); expect(r.body.lastPunch.direction).toBe('IN');
    const p = await anon.post('/api/v1/attendance/mobile/punch', { ticket: r.body.ticket, direction: 'OUT', gps: gpsInside() });
    expect(p.status, JSON.stringify(p.body)).toBe(200); expect(p.body.direction).toBe('OUT');
    const punches = await app.db.selectFrom('attendance_raw_events').select('direction').where('employee_id', '=', emp.id).where('source', '=', 'MOBILE_FACE').orderBy('punched_at').execute();
    expect(punches.map((x) => x.direction)).toEqual(['IN', 'OUT']);
  }, 60_000);
});

describe('GPS / geofence behaviour', () => {
  beforeAll(async () => { await settings((v) => { v.duplicateWindowSeconds = 5; }); await new Promise((res) => setTimeout(res, 5200)); });
  it('outside the fence → rejected; missing GPS → rejected', async () => {
    const out = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: { ...gpsInside(), latitude: 24.60 }, clientSignals: signals });
    expect(out.body.outcome).toBe('REJECTED'); expect(out.body.reason).toMatch(/outside the permitted/); expect(out.body.ticket).toBeNull(); expect(out.body.geofence.result).toBe('OUTSIDE');
    const none = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, clientSignals: signals });
    expect(none.body.outcome).toBe('REJECTED'); expect(none.body.reason).toMatch(/Location is required/);
  }, 60_000);
  it('poor accuracy and mock-location are recorded with review flags (configured as EXCEPTION), not silently rejected', async () => {
    const r = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: { ...gpsInside(), accuracyM: 400, isMocked: true }, clientSignals: signals });
    expect(r.body.outcome).toBe('MATCHED'); expect(r.body.geofence.result).toBe('LOW_ACCURACY');
    const p = await anon.post('/api/v1/attendance/mobile/punch', { ticket: r.body.ticket, direction: 'IN', gps: { ...gpsInside(), accuracyM: 400 } });
    expect(p.status, JSON.stringify(p.body)).toBe(200); expect(p.body.flagged).toContain('LOW_ACCURACY');
    const ex = await app.db.selectFrom('attendance_exceptions').select(['exception_type', 'details']).where('raw_event_id', '=', p.body.rawEventId).executeTakeFirstOrThrow();
    expect((ex.details as any).flag).toBe('LOW_ACCURACY');
    await new Promise((res) => setTimeout(res, 5200));
    const s = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: { ...gpsInside(), isMocked: true }, clientSignals: signals });
    expect(s.body.geofence.result).toBe('SUSPICIOUS');
    const p2 = await anon.post('/api/v1/attendance/mobile/punch', { ticket: s.body.ticket, direction: 'OUT', gps: { ...gpsInside(), isMocked: true } });
    expect(p2.status).toBe(200); expect(p2.body.flagged).toContain('LOCATION_SUSPICIOUS');
    const ex2 = await app.db.selectFrom('attendance_exceptions').select('severity').where('raw_event_id', '=', p2.body.rawEventId).executeTakeFirstOrThrow();
    expect(ex2.severity).toBe('HIGH');
  }, 60_000);
});

describe('site kiosk (terminal identity)', () => {
  let token: string, terminalId: string;
  it('registers a terminal, pairs with the one-time code, and recognises without GPS (kiosk site fence)', async () => {
    const t = await it_.post('/api/v1/biometric/terminals', { name: 'C55 gate tablet', siteId: emp.siteId, terminalType: 'TABLET_KIOSK' });
    expect(t.status, JSON.stringify(t.body)).toBe(201); expect(t.body.pairingCode).toMatch(/^\d{6}$/); expect(t.body.status).toBe('PENDING');
    terminalId = t.body.id;
    const bad = await anon.post('/api/v1/attendance/mobile/terminals/pair', { pairingCode: '000000' });
    expect(bad.status).toBe(401);
    const pair = await anon.post('/api/v1/attendance/mobile/terminals/pair', { pairingCode: t.body.pairingCode });
    expect(pair.status, JSON.stringify(pair.body)).toBe(200); token = pair.body.token; expect(token).toMatch(/^bpt_/);
    expect((await anon.post('/api/v1/attendance/mobile/terminals/pair', { pairingCode: t.body.pairingCode })).status).toBe(401); // consumed
    const cfg = await app.inject({ method: 'GET', url: '/api/v1/attendance/mobile/config', headers: { 'x-terminal-token': token } });
    expect(cfg.json().mode).toBe('SITE_KIOSK'); expect(cfg.json().terminal.deviceCode).toMatch(/^MF-/);
    await new Promise((res) => setTimeout(res, 5200));
    const r = await app.inject({ method: 'POST', url: '/api/v1/attendance/mobile/recognize', headers: { 'x-terminal-token': token }, payload: { frame: FRONT, clientSignals: signals } });
    expect(r.json().outcome, r.body).toBe('MATCHED'); expect(r.json().mode).toBe('SITE_KIOSK'); expect(r.json().employee.photoObjectKey).toBeNull();
    // a ticket issued to the kiosk cannot be redeemed from an anonymous phone
    expect((await anon.post('/api/v1/attendance/mobile/punch', { ticket: r.json().ticket, direction: 'IN' })).status).toBe(401);
    const p = await app.inject({ method: 'POST', url: '/api/v1/attendance/mobile/punch', headers: { 'x-terminal-token': token }, payload: { ticket: r.json().ticket, direction: 'IN' } });
    expect(p.statusCode, p.body).toBe(200);
    const raw = await app.db.selectFrom('attendance_raw_events').select(['device_code', 'site_id']).where('id', '=', p.json().rawEventId).executeTakeFirstOrThrow();
    expect(raw.device_code).toMatch(/^MF-/); expect(raw.site_id).toBe(emp.siteId);
  }, 90_000);
  it('an employee of another site is refused at this kiosk; a revoked terminal token stops working', async () => {
    const ho = await app.db.selectFrom('sites').select('id').where('code', '=', 'HO').executeTakeFirstOrThrow();
    const t = await it_.post('/api/v1/biometric/terminals', { name: 'HO reception', siteId: ho.id });
    const pair = await anon.post('/api/v1/attendance/mobile/terminals/pair', { pairingCode: t.body.pairingCode });
    await new Promise((res) => setTimeout(res, 5200));
    const r = await app.inject({ method: 'POST', url: '/api/v1/attendance/mobile/recognize', headers: { 'x-terminal-token': pair.body.token }, payload: { frame: FRONT, clientSignals: signals } });
    expect(r.json().outcome).toBe('REJECTED'); expect(r.json().reason).toMatch(/not assigned to this site/);
    expect((await it_.post(`/api/v1/biometric/terminals/${terminalId}/revoke`, { reason: 'lost device' })).status).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/v1/attendance/mobile/config', headers: { 'x-terminal-token': token } });
    expect(after.statusCode).toBe(401);
  }, 60_000);
});

describe('thresholds, liveness, ambiguity, eligibility, deletion', () => {
  beforeAll(async () => { await new Promise((res) => setTimeout(res, 5200)); });
  it('anti-spoof threshold above the score → LIVENESS_FAILED; active challenge missing → LIVENESS_FAILED', async () => {
    // the sample image scores liveness = 1.0 exactly, so the anti-spoof classifier (≈ 0.6–0.8 on the samples) is the gate we raise
    await settings((v) => { v.thresholds.antispoof = 1; });
    const r = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: gpsInside(), clientSignals: signals });
    expect(r.body.outcome, JSON.stringify(r.body)).toBe('LIVENESS_FAILED'); expect(r.body.ticket).toBeNull(); expect(r.body.reason).toMatch(/live person/i);
    await settings((v) => { v.thresholds.antispoof = 0.5; });
    const noChallenge = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: gpsInside() });
    expect(noChallenge.body.outcome).toBe('LIVENESS_FAILED');
  }, 60_000);
  it('match threshold above the score → LOW_CONFIDENCE / NO_MATCH; two near-identical templates → AMBIGUOUS', async () => {
    const base = await anon.post('/api/v1/attendance/mobile/recognize', { frame: RIGHT, gps: gpsInside(), clientSignals: signals });
    const score = base.body.scores.match as number;
    await settings((v) => { v.thresholds.match = Math.min(0.99, score + 0.05); });
    const low = await anon.post('/api/v1/attendance/mobile/recognize', { frame: RIGHT, gps: gpsInside(), clientSignals: signals });
    expect(['LOW_CONFIDENCE', 'NO_MATCH']).toContain(low.body.outcome); expect(low.body.ticket).toBeNull();
    await settings((v) => { v.thresholds.match = 0.5; });
    // clone the template onto another employee directly in the DB (the API refuses this) → the index now holds two identical faces
    const t = await app.db.selectFrom('biometric_face_templates').selectAll().where('employee_id', '=', emp.id).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
    await app.db.insertInto('biometric_face_templates').values({ employee_id: other.id, provider: t.provider, model_version: t.model_version, embedding_dim: t.embedding_dim, embedding_enc: t.embedding_enc, sample_count: 1 }).execute();
    invalidateFaceIndex(); // direct DB write bypasses the API's index invalidation
    const amb = await anon.post('/api/v1/attendance/mobile/recognize', { frame: RIGHT, gps: gpsInside(), clientSignals: signals });
    expect(amb.body.outcome).toBe('AMBIGUOUS'); expect(amb.body.reason).toMatch(/confidently identify/); expect(amb.body.ticket).toBeNull();
    await app.db.deleteFrom('biometric_face_templates').where('employee_id', '=', other.id).execute();
    invalidateFaceIndex();
  }, 90_000);
  it('terminated employees are refused and their template is disabled by the lifecycle transition', async () => {
    await app.db.updateTable('employees').set({ status: 'TERMINATED' }).where('id', '=', emp.id).execute();
    const r = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: gpsInside(), clientSignals: signals });
    expect(r.body.outcome).toBe('REJECTED'); expect(r.body.reason).toMatch(/terminated/);
    await app.db.updateTable('employees').set({ status: 'ACTIVE' }).where('id', '=', emp.id).execute();
    // real lifecycle path on another enrolled employee
    const e2 = (await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-152').executeTakeFirstOrThrow()).id;
    await app.db.updateTable('employees').set({ status: 'RESIGNED', last_working_date: '2026-09-01' }).where('id', '=', e2).execute();
    const tpl = await app.db.selectFrom('biometric_face_templates').selectAll().where('employee_id', '=', emp.id).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
    await app.db.insertInto('biometric_face_templates').values({ employee_id: e2, provider: tpl.provider, model_version: 'test-only', embedding_dim: tpl.embedding_dim, embedding_enc: tpl.embedding_enc }).execute();
    const tr = await hrm.post(`/api/v1/employees/${e2}/transition`, { to: 'CLEARANCE', reason: 'test' });
    expect(tr.status, JSON.stringify(tr.body)).toBe(200);
    // CLEARANCE keeps recognition (employee still on site); ARCHIVED/TERMINATED disable it
    await app.db.updateTable('employees').set({ status: 'FINAL_SETTLEMENT' }).where('id', '=', e2).execute();
    const arch = await hrm.post(`/api/v1/employees/${e2}/transition`, { to: 'ARCHIVED', reason: 'test' });
    expect(arch.status, JSON.stringify(arch.body)).toBe(200);
    const st = await app.db.selectFrom('biometric_face_templates').select('status').where('employee_id', '=', e2).executeTakeFirstOrThrow();
    expect(st.status).toBe('DISABLED');
  }, 60_000);
  it('recognition events are auditable (HR sees all, employee sees own only) and never contain embeddings', async () => {
    const all = await hrm.get('/api/v1/biometric/events?pageSize=50');
    expect(all.status).toBe(200); expect(all.body.data.some((e: any) => e.outcome === 'PUNCHED')).toBe(true); expect(all.body.data.some((e: any) => e.outcome === 'REJECTED')).toBe(true);
    expect(JSON.stringify(all.body)).not.toMatch(/embedding/);
    const own = await self.get('/api/v1/biometric/events');
    expect(own.status).toBe(200); expect(own.body.data.every((e: any) => e.employee === null || e.employee.employeeNo === 'BP-26-020')).toBe(true);
    const ver = (await hrm.get('/api/v1/biometric/settings')).body;
    expect(ver.version).toBeGreaterThan(settingsV1.version); expect(ver.history.length).toBeGreaterThan(0);
  });
  it('self-test endpoint verifies against the employee template; delete wipes the ciphertext and unknown faces are not recognised', async () => {
    const t = await hrm.post(`/api/v1/biometric/employees/${emp.id}/test`, { frame: RIGHT });
    expect(t.status, JSON.stringify(t.body)).toBe(200); expect(t.body.identified.isThisEmployee).toBe(true); expect(t.body.verifyScore).toBeGreaterThanOrEqual(0.5);
    const del = await hrm.del(`/api/v1/biometric/employees/${emp.id}/template`);
    expect(del.status, JSON.stringify(del.body)).toBe(200); expect(del.body.deleted).toBe(1);
    const wiped = await app.db.selectFrom('biometric_face_templates').select(['status', 'embedding_enc']).where('employee_id', '=', emp.id).orderBy('enrolled_at', 'desc').executeTakeFirstOrThrow();
    expect(wiped.status).toBe('DELETED'); expect(Buffer.from(wiped.embedding_enc as any).length).toBe(0);
    const r = await anon.post('/api/v1/attendance/mobile/recognize', { frame: FRONT, gps: gpsInside(), clientSignals: signals });
    expect(r.body.outcome).toBe('NO_MATCH'); expect(r.body.reason).toMatch(/not recognized/);
    expect((await hrm.get(`/api/v1/biometric/employees/${emp.id}/status`)).body.enrolled).toBe(false);
  }, 60_000);
});
