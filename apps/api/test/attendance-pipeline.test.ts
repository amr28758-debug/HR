import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gatewayClient, login, punch, testApp, type App, type Client } from './helpers.js';

let app: App, admin: Client, hr: Client, gw: Client, emp: { id: string; matrix: string; siteId: string };
const DEV = 'ARGO-C42-01';
beforeAll(async () => {
  app = await testApp(); await app.ready();
  admin = await login(app, 'admin@burtplace.local'); hr = await login(app, 'hr.admin@burtplace.local'); gw = await gatewayClient(app, admin);
  // BP-26-100 is at C42 (seed order: 18 HO, 70 C31, 45 C42 → 89..133)
  const e = await app.db.selectFrom('employees').select(['id', 'matrix_user_id', 'site_id']).where('employee_no', '=', 'BP-26-100').executeTakeFirstOrThrow();
  emp = { id: e.id, matrix: e.matrix_user_id!, siteId: e.site_id! };
});
afterAll(async () => { await app.close(); });

describe('raw ingest', () => {
  it('accepts device events with an API key, dedups by fingerprint, flags unmapped users', async () => {
    const events = [punch(emp.matrix, DEV, '2026-08-03T06:00'), punch(emp.matrix, DEV, '2026-08-03T17:00'), punch('424242', DEV, '2026-08-03T06:00')];
    const first = await gw.post('/api/v1/attendance/events', events);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ received: 3, inserted: 3, duplicates: 0, unmapped: 1 });
    const again = await gw.post('/api/v1/attendance/events', events);
    expect(again.body).toMatchObject({ inserted: 0, duplicates: 3 });
    const raw = await hr.get(`/api/v1/attendance/raw-events?employeeId=${emp.id}&from=2026-08-03T00:00:00Z&to=2026-08-04T00:00:00Z`);
    expect(raw.body.meta.total).toBe(2);
    expect(raw.body.data[0].processedAt).not.toBeNull();
    const ex = await hr.get('/api/v1/attendance/exceptions?type=UNMAPPED_USER');
    expect(ex.body.data.some((x: any) => x.details.externalUserId === '424242')).toBe(true);
  });
  it('rejects the ingest endpoint for principals without attendance:ingest', async () => {
    expect((await hr.post('/api/v1/attendance/events', [punch('1', DEV, '2026-08-03T06:00')])).status).toBe(403);
  });
  it('rejects future timestamps and malformed payloads', async () => {
    const res = await gw.post('/api/v1/attendance/events', [punch(emp.matrix, DEV, '2099-01-01T06:00')]);
    expect(res.body.rejected).toBe(1);
    expect((await gw.post('/api/v1/attendance/events', [{ userId: '1' }])).status).toBe(400);
  });
  it('raw ledger is immutable even through the DB layer', async () => {
    const row = await app.db.selectFrom('attendance_raw_events').select('id').where('employee_id', '=', emp.id).executeTakeFirstOrThrow();
    await expect(app.db.deleteFrom('attendance_raw_events').where('id', '=', row.id).execute()).rejects.toThrow(/immutable/);
    await expect(app.db.updateTable('attendance_raw_events').set({ punched_at: new Date() }).where('id', '=', row.id).execute()).rejects.toThrow(/immutable/);
  });
});

describe('daily attendance', () => {
  it('computes a present day with late + OT from site shift; week-off work becomes weekend OT; absence on scheduled day', async () => {
    await gw.post('/api/v1/attendance/events', [
      punch(emp.matrix, DEV, '2026-08-04T06:30'), punch(emp.matrix, DEV, '2026-08-04T19:05'),   // late 30, OT after end 125 → 120 (cap by worked-480? worked=755-60=695 → 215; min(125,215)=125 → 120)
      punch(emp.matrix, DEV, '2026-08-07T07:00'), punch(emp.matrix, DEV, '2026-08-07T11:00'),   // Friday week-off: 240-60=180 → weekend OT 180
      punch(emp.matrix, DEV, '2026-08-06T06:00'),                                             // Thursday: missing OUT
    ]);
    const daily = await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-08-03&to=2026-08-08&order=asc&pageSize=10`);
    const byDate = Object.fromEntries(daily.body.data.map((d: any) => [d.date, d]));
    expect(byDate['2026-08-03']).toMatchObject({ status: 'PRESENT', workedMinutes: 600, lateMinutes: 0, overtimeMinutes: 0 });
    expect(byDate['2026-08-04']).toMatchObject({ status: 'PRESENT', lateMinutes: 30, overtimeMinutes: 120, approvedOvertimeMinutes: 0 });
    expect(byDate['2026-08-06']).toMatchObject({ status: 'MISSING_PUNCH', punchCount: 1 });
    expect(byDate['2026-08-07']).toMatchObject({ status: 'WEEK_OFF', weekendMinutes: 180, overtimeMinutes: 180 });
    // Days with no punches are not present until a range process runs (the processor only touched affected dates)
    const proc = await admin.post('/api/v1/attendance/process', { from: '2026-08-01', to: '2026-08-08', employeeIds: [emp.id] });
    expect(proc.status).toBe(200);
    expect(proc.body.byStatus.ABSENT).toBeGreaterThanOrEqual(3);
    const cal = await hr.get(`/api/v1/attendance/calendar/${emp.id}?year=2026&month=8`);
    expect(cal.body.find((d: any) => d.date === '2026-08-05').status).toBe('ABSENT');
    const ex = await hr.get(`/api/v1/attendance/exceptions?employeeId=${emp.id}&from=2026-08-01&to=2026-08-08&pageSize=50`);
    const types = ex.body.data.map((x: any) => `${x.date}:${x.type}`);
    expect(types).toEqual(expect.arrayContaining(['2026-08-04:LATE', '2026-08-04:UNAPPROVED_OT', '2026-08-06:MISSING_OUT', '2026-08-05:ABSENT']));
  });
  it('resolves the effective schedule', async () => {
    const sch = await hr.get(`/api/v1/shifts/resolve/${emp.id}?from=2026-08-06&to=2026-08-07`);
    expect(sch.body[0]).toMatchObject({ date: '2026-08-06', isWorkingDay: true, shiftCode: 'SITE-DAY' });
    expect(sch.body[1]).toMatchObject({ date: '2026-08-07', isWeekOff: true });
  });
  it('an approved correction adds the missing punch without touching raw data and recalculates the day', async () => {
    const corr = await hr.post('/api/v1/attendance/corrections', { employeeId: emp.id, date: '2026-08-06', correctionType: 'ADD_PUNCH', punchedAt: '2026-08-06T17:00:00+04:00', reason: 'Device offline at exit, confirmed by site foreman' });
    expect(corr.status).toBe(201);
    expect(corr.body.status).toBe('PENDING');
    // approve through the workflow (manager → HR); admin acts as SUPER_ADMIN on any task
    for (let i = 0; i < 2; i++) {
      const tasks = await admin.get('/api/v1/workflows/tasks/mine?all=true');
      const t = tasks.body.data.find((x: any) => x.entityId === corr.body.id);
      expect(t, `step ${i}`).toBeTruthy();
      expect((await admin.post(`/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' })).status).toBe(200);
    }
    const day = (await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-08-06&to=2026-08-06`)).body.data[0];
    expect(day.status).toBe('PRESENT');
    expect(day.workedMinutes).toBe(600);
    const punches = await hr.get(`/api/v1/attendance/daily/${emp.id}/2026-08-06/punches`);
    expect(punches.body).toHaveLength(2);
    expect(punches.body[1].correctionId).toBe(corr.body.id);
    const raw = await hr.get(`/api/v1/attendance/raw-events?employeeId=${emp.id}&from=2026-08-06T00:00:00Z&to=2026-08-07T00:00:00Z`);
    expect(raw.body.meta.total).toBe(1); // raw ledger untouched
  });
  it('an employee-level night-shift assignment attributes cross-midnight punches to the shift date', async () => {
    const night = await app.db.selectFrom('shifts').select('id').where('code', '=', 'SITE-NIGHT').executeTakeFirstOrThrow();
    const asg = await hr.post('/api/v1/shifts/assignments', { employeeId: emp.id, shiftId: night.id, effectiveFrom: '2026-08-10', effectiveTo: '2026-08-12', recalculate: false });
    expect(asg.status).toBe(201);
    await gw.post('/api/v1/attendance/events', [punch(emp.matrix, DEV, '2026-08-10T18:00'), punch(emp.matrix, DEV, '2026-08-11T05:00'), punch(emp.matrix, DEV, '2026-08-11T18:00'), punch(emp.matrix, DEV, '2026-08-12T05:30')]);
    await admin.post('/api/v1/attendance/process', { from: '2026-08-10', to: '2026-08-12', employeeIds: [emp.id] });
    const rows = (await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-08-10&to=2026-08-12&order=asc`)).body.data;
    const byDate = Object.fromEntries(rows.map((d: any) => [d.date, d]));
    expect(byDate['2026-08-10']).toMatchObject({ status: 'PRESENT', workedMinutes: 600, shiftCode: 'SITE-NIGHT' });
    expect(byDate['2026-08-11']).toMatchObject({ status: 'PRESENT', workedMinutes: 630 });
    expect(byDate['2026-08-11'].overtimeMinutes).toBe(30);
  });
  it('mapping an unmapped device user relinks its raw events', async () => {
    const e2 = await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-101').executeTakeFirstOrThrow();
    const it_ = await login(app, 'it.admin@burtplace.local');
    const res = await it_.post('/api/v1/devices/mappings', { employeeId: e2.id, externalUserId: '424242' });
    expect(res.status).toBe(201);
    expect(res.body.relinkedEvents).toBe(1);
    const open = await hr.get('/api/v1/attendance/exceptions?type=UNMAPPED_USER');
    expect(open.body.data.some((x: any) => x.details.externalUserId === '424242')).toBe(false);
  });
  it('device health reflects last punch and reconciliation summarises the pipeline', async () => {
    const dev = (await hr.get('/api/v1/devices')).body.find((d: any) => d.deviceCode === DEV);
    expect(dev.lastPunchAt).not.toBeNull();
    const health = await admin.get('/api/v1/devices/health');
    const devCount = Number((await app.db.selectFrom('devices').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    expect(health.body.total).toBe(devCount); // 6 seeded gateway devices + any MOBILE_FACE terminals registered by other suites
    const recon = await admin.post('/api/v1/attendance/reconcile', { from: '2026-08-01', to: '2026-08-12' });
    expect(recon.status).toBe(200);
    expect(recon.body.summary.rawUnprocessed).toBe(0);
    expect(recon.body.summary.employeesMissingDaily).toBeGreaterThan(0);
  });
});
