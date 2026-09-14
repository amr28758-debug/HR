import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gatewayClient, login, punch, testApp, type App, type Client } from './helpers.js';

let app: App, admin: Client, hr: Client, hrm: Client, payroll: Client, finance: Client, mgmt: Client, gw: Client;
let emp: { id: string; matrix: string; siteId: string };
const DEV = 'ARGO-C55-01';
const Y = 2026, M = 7; // July 2026: Wed 1 → Fri 31. SITE-6D: Fridays off (3,10,17,24,31) → 26 scheduled days
beforeAll(async () => {
  app = await testApp(); await app.ready();
  admin = await login(app, 'admin@burtplace.local'); hr = await login(app, 'hr.admin@burtplace.local'); hrm = await login(app, 'hr.manager@burtplace.local');
  payroll = await login(app, 'payroll@burtplace.local'); finance = await login(app, 'finance@burtplace.local'); mgmt = await login(app, 'management@burtplace.local'); gw = await gatewayClient(app, admin);
  const e = await app.db.selectFrom('employees').select(['id', 'matrix_user_id', 'site_id']).where('employee_no', '=', 'BP-26-140').executeTakeFirstOrThrow(); // C55 site
  emp = { id: e.id, matrix: e.matrix_user_id!, siteId: e.site_id! };
  // Known salary: 5000 basic + 2000 housing + 1000 transport = 8000 gross
  await hrm.post(`/api/v1/employees/${emp.id}/salary`, { effectiveFrom: '2026-01-01', lines: [{ componentCode: 'BASIC', amount: 5000 }, { componentCode: 'HOUSING', amount: 2000 }, { componentCode: 'TRANSPORT', amount: 1000 }] });
  await app.db.updateTable('employees').set({ bank_iban: 'AE070331234567890123456', joining_date: '2024-01-01' }).where('id', '=', emp.id).execute();
  // Full attendance for July except: 6 Jul (Mon) absent, 7 Jul OT 2h, 13-14 Jul annual leave, 20 Jul unpaid leave, 27 Jul late 45 min
  const events: any[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`;
    const dow = new Date(date).getUTCDay();
    if (dow === 5 || d === 6 || d === 13 || d === 14 || d === 20) continue;
    events.push(punch(emp.matrix, DEV, `${date}T${d === 27 ? '06:45' : '06:00'}`), punch(emp.matrix, DEV, `${date}T${d === 7 ? '19:00' : '17:00'}`));
  }
  await gw.post('/api/v1/attendance/events', events);
});
afterAll(async () => { await app.close(); });

describe('leave', () => {
  it('computes chargeable days from the work pattern, checks balance, and approval marks attendance ON_LEAVE', async () => {
    const bal0 = (await hr.get(`/api/v1/leave/balances/${emp.id}?year=2026`)).body.find((b: any) => b.leaveTypeCode === 'ANNUAL');
    expect(bal0.available).toBe(17.5);
    // 13 Jul (Mon) → 17 Jul (Fri, off) = 4 chargeable days
    const req = await hr.post('/api/v1/leave/requests', { employeeId: emp.id, leaveTypeCode: 'ANNUAL', startDate: '2026-07-13', endDate: '2026-07-14', reason: 'family' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body.totalDays).toBe(2);
    expect(req.body.status).toBe('PENDING');
    const bal1 = (await hr.get(`/api/v1/leave/balances/${emp.id}?year=2026`)).body.find((b: any) => b.leaveTypeCode === 'ANNUAL');
    expect(bal1.pending).toBe(2);
    expect(bal1.available).toBe(15.5);
    // overlap rejected
    expect((await hr.post('/api/v1/leave/requests', { employeeId: emp.id, leaveTypeCode: 'ANNUAL', startDate: '2026-07-14', endDate: '2026-07-15' })).status).toBe(400);
    // approve: manager → HR
    for (let i = 0; i < 2; i++) { const t = (await admin.get('/api/v1/workflows/tasks/mine?all=true')).body.data.find((x: any) => x.entityId === req.body.id); await admin.post(`/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' }); }
    const lr = (await hr.get(`/api/v1/leave/requests?employeeId=${emp.id}`)).body.data.find((x: any) => x.id === req.body.id);
    expect(lr.status).toBe('APPROVED');
    const bal2 = (await hr.get(`/api/v1/leave/balances/${emp.id}?year=2026`)).body.find((b: any) => b.leaveTypeCode === 'ANNUAL');
    expect(bal2.used).toBe(2); expect(bal2.pending).toBe(0); expect(bal2.balance).toBe(15.5);
    const day = (await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-07-13&to=2026-07-13`)).body.data[0];
    expect(day.status).toBe('ON_LEAVE'); expect(day.leaveTypeCode).toBe('ANNUAL'); expect(day.isPaidDay).toBe(true);
  });
  it('unpaid leave needs no balance and is recorded as unpaid', async () => {
    const req = await hr.post('/api/v1/leave/requests', { employeeId: emp.id, leaveTypeCode: 'UNPAID', startDate: '2026-07-20', endDate: '2026-07-20' });
    expect(req.status).toBe(201);
    for (let i = 0; i < 2; i++) { const t = (await admin.get('/api/v1/workflows/tasks/mine?all=true')).body.data.find((x: any) => x.entityId === req.body.id); await admin.post(`/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' }); }
    const day = (await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-07-20&to=2026-07-20`)).body.data[0];
    expect(day).toMatchObject({ status: 'ON_LEAVE', leaveTypeCode: 'UNPAID', isPaidDay: false });
  });
  it('insufficient balance is rejected; employee self-service works and cancellation restores balance', async () => {
    const big = await hr.post('/api/v1/leave/requests', { employeeId: emp.id, leaveTypeCode: 'ANNUAL', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(big.status).toBe(400); expect(big.body.error.message).toMatch(/Insufficient/);
    const self = await login(app, 'employee@burtplace.local');
    const mine = await self.post('/api/v1/leave/requests', { leaveTypeCode: 'ANNUAL', startDate: '2026-12-06', endDate: '2026-12-07' });
    expect(mine.status).toBe(201);
    const cancel = await self.post(`/api/v1/leave/requests/${mine.body.id}/cancel`, { reason: 'changed plans' });
    expect(cancel.body.status).toBe('CANCELLED');
    const me = await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-020').executeTakeFirstOrThrow();
    const bal = (await hr.get(`/api/v1/leave/balances/${me.id}?year=2026`)).body.find((b: any) => b.leaveTypeCode === 'ANNUAL');
    expect(bal.pending).toBe(0);
  });
  it('monthly accrual is idempotent', async () => {
    const a1 = await hrm.post('/api/v1/leave/accrual/run', { year: 2026, month: 9 });
    expect(a1.body.accrued).toBeGreaterThan(100);
    const a2 = await hrm.post('/api/v1/leave/accrual/run', { year: 2026, month: 9 });
    expect(a2.body.accrued).toBe(0);
  });
});

describe('overtime → timesheet → payroll', () => {
  let runId: string, peId: string;
  it('OT request defaults to computed minutes; >120 min needs HR too; approval writes approved minutes to the day', async () => {
    await admin.post('/api/v1/attendance/process', { from: '2026-07-01', to: '2026-07-31', employeeIds: [emp.id] });
    const day = (await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-07-07&to=2026-07-07`)).body.data[0];
    expect(day.overtimeMinutes).toBe(120);
    const ot = await hr.post('/api/v1/overtime/requests', { employeeId: emp.id, date: '2026-07-07', reason: 'concrete pour' });
    expect(ot.status).toBe(201);
    expect(ot.body.requestedMinutes).toBe(120);
    expect(ot.body.multiplier).toBe(1.25);
    const inst = await hrm.get(`/api/v1/workflows/instances/${ot.body.workflowInstanceId}`);
    expect(inst.body.tasks.map((t: any) => t.stepKey)).toEqual(['manager']); // 120 is not > 120 → HR step skipped
    const t = (await admin.get('/api/v1/workflows/tasks/mine?all=true')).body.data.find((x: any) => x.entityId === ot.body.id);
    await admin.post(`/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' });
    const after = (await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-07-07&to=2026-07-07`)).body.data[0];
    expect(after.approvedOvertimeMinutes).toBe(120);
    expect((await hr.get(`/api/v1/overtime/requests?employeeId=${emp.id}`)).body.data[0].status).toBe('APPROVED');
  });
  it('generates the monthly timesheet with the expected totals', async () => {
    const gen = await hr.post('/api/v1/timesheets/generate', { year: Y, month: M, employeeIds: [emp.id] });
    expect(gen.body.generated).toBe(1);
    const ts = (await hr.get(`/api/v1/timesheets?year=${Y}&month=${M}&employeeId=${emp.id}`)).body.data[0];
    expect(ts).toMatchObject({ calendarDays: 31, scheduledDays: 26, presentDays: 22, absentDays: 1, paidLeaveDays: 2, unpaidLeaveDays: 1, weekOffDays: 5, overtimeMinutes: 120, lateMinutes: 45, lateCount: 1, missingPunchDays: 0 });
    const detail = await hr.get(`/api/v1/timesheets/${ts.id}`);
    expect(detail.body.lines).toHaveLength(31);
    expect((await hr.post(`/api/v1/timesheets/${ts.id}/approve`)).body.status).toBe('APPROVED');
  });
  it('calculates payroll from the timesheet with configurable formulas and walks the approval chain to LOCKED', async () => {
    const run = await payroll.post('/api/v1/payroll/runs', { year: Y, month: M, filters: { siteIds: [emp.siteId] } });
    expect(run.status).toBe(201);
    runId = run.body.id;
    const calc = await payroll.post(`/api/v1/payroll/runs/${runId}/calculate`);
    expect(calc.status).toBe(200);
    expect(calc.body.employees).toBeGreaterThan(1);
    const row = (await payroll.get(`/api/v1/payroll/runs/${runId}/employees?q=BP-26-140`)).body.data[0];
    peId = row.id;
    // rates: 8000/30 = 266.6667/day, 33.3333/h. OT 2h × 1.25 = 83.33. Unpaid 1d = 266.67. Absence 1d = 266.67. Late 45 < 60 grace → 0.
    expect(row.grossSalary).toBe(8000);
    expect(row.totalEarnings).toBe(8083.33);
    expect(row.totalDeductions).toBe(533.34);
    expect(row.netSalary).toBe(7549.99);
    expect(row.exceptions).toEqual([]);
    const detail = await payroll.get(`/api/v1/payroll/employees/${peId}`);
    const codes = Object.fromEntries([...detail.body.earnings, ...detail.body.deductions].map((l: any) => [l.componentCode, l.amount]));
    expect(codes).toMatchObject({ BASIC: 5000, HOUSING: 2000, TRANSPORT: 1000, OT: 83.33, UNPAID_LEAVE: 266.67, ABSENCE: 266.67 });
    expect(detail.body.trace.variables.unpaid_leave_days).toBe(1);
    // approval chain with segregation of duties
    expect((await payroll.post(`/api/v1/payroll/runs/${runId}/transition`, { to: 'FINANCE_REVIEW' })).status).toBe(403);
    expect((await hrm.post(`/api/v1/payroll/runs/${runId}/transition`, { to: 'FINANCE_REVIEW', note: 'exceptions reviewed' })).body.status).toBe('FINANCE_REVIEW');
    expect((await payroll.post(`/api/v1/payroll/runs/${runId}/calculate`)).status).toBe(422); // no recalculation after HR review
    expect((await finance.post(`/api/v1/payroll/runs/${runId}/transition`, { to: 'MANAGEMENT_APPROVAL' })).body.status).toBe('MANAGEMENT_APPROVAL');
    expect((await finance.post(`/api/v1/payroll/runs/${runId}/transition`, { to: 'APPROVED' })).body.status).toBe('APPROVED');
    expect((await payroll.post(`/api/v1/payroll/runs/${runId}/transition`, { to: 'LOCKED' })).status).toBe(403);
    expect((await finance.post(`/api/v1/payroll/runs/${runId}/transition`, { to: 'LOCKED' })).body.status).toBe('LOCKED');
    void mgmt;
  });
  it('after LOCKED: timesheet & days are frozen, corrections are refused, payslips exist, bank file exports, adjustments route to next run', async () => {
    const ts = (await hr.get(`/api/v1/timesheets?year=${Y}&month=${M}&employeeId=${emp.id}`)).body.data[0];
    expect(ts.status).toBe('LOCKED');
    const corr = await hr.post('/api/v1/attendance/corrections', { employeeId: emp.id, date: '2026-07-06', correctionType: 'OVERRIDE_DAY', overrideStatus: 'PRESENT', reason: 'was actually present' });
    expect(corr.status).toBe(400); expect(corr.body.error.message).toMatch(/locked/);
    const before = (await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-07-06&to=2026-07-06`)).body.data[0];
    await admin.post('/api/v1/attendance/process', { from: '2026-07-06', to: '2026-07-06', employeeIds: [emp.id] });
    expect((await hr.get(`/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-07-06&to=2026-07-06`)).body.data[0].calculatedAt).toBe(before.calculatedAt);
    const slips = await payroll.get(`/api/v1/payroll/employees/${peId}`);
    expect(slips.body.payslipNo).toBe(`PR-2026-07-BP-26-140`);
    const bank = await finance.get(`/api/v1/payroll/runs/${runId}/bank-file`);
    expect(bank.status).toBe(200); expect(bank.text).toContain('AE070331234567890123456');
    const adj = await payroll.post('/api/v1/payroll/adjustments', { employeeId: emp.id, componentCode: 'ADJ_EARN', amount: 150, reason: 'Missed site allowance July', originRunId: runId });
    expect(adj.status).toBe(201); expect(adj.body.status).toBe('PENDING');
    expect((await finance.post(`/api/v1/payroll/adjustments/${adj.body.id}/decide`, { decision: 'APPROVED' })).status).toBe(200);
    // employee can see own locked payslip but not the trace; other payroll data is hidden
    const self = await login(app, 'employee@burtplace.local');
    expect((await self.get(`/api/v1/payroll/employees/${peId}`)).status).toBe(403);
    expect((await self.get('/api/v1/payroll/my-payslips')).status).toBe(200);
  });
  it('reports and dashboards read the run', async () => {
    const cost = await finance.get(`/api/v1/reports/payroll/cost?runId=${runId}&groupBy=project`);
    expect(cost.body.data[0].group).toContain('C55');
    const csv = await finance.get(`/api/v1/reports/payroll/register?runId=${runId}&format=csv`);
    expect(csv.text.split('\n')[0]).toContain('employee_no');
    expect((await finance.get('/api/v1/dashboards/payroll')).body.run.status).toBe('LOCKED');
    expect((await mgmt.get('/api/v1/dashboards/executive?date=2026-07-07')).body.headcount).toBeGreaterThanOrEqual(175);
    expect((await hr.get('/api/v1/dashboards/hr')).status).toBe(200);
    const pm = await login(app, 'pm.c31@burtplace.local');
    expect((await pm.get('/api/v1/dashboards/manager?date=2026-07-07')).body.teamSize).toBeGreaterThan(0);
    const self = await login(app, 'employee@burtplace.local');
    expect((await self.get('/api/v1/dashboards/me')).body.employee.employeeNo).toBe('BP-26-020');
  });
});
