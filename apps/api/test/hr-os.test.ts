import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, testApp, type App, type Client } from './helpers.js';

/** HR Operating System: command center, HR requests + approval chains, compensation, letters, bulk, analytics, delegation. */
let app: App, admin: Client, hr: Client, hrm: Client, fin: Client, mgmt: Client, payroll: Client, self: Client, pm: Client;
let emp: { id: string; no: string }, selfEmp: { id: string }, pmReport: { id: string };
const userClients = new Map<string, Client>();
const roleClients = (): Record<string, Client> => ({ HR_ADMIN: hr, HR_MANAGER: hrm, FINANCE_MANAGER: fin, MANAGEMENT: mgmt, PAYROLL_OFFICER: payroll });
/** Walk an approval chain: find the pending task (admin, all=true), decide it as the assignee's client (role or user), until the instance is APPROVED. Returns the step keys decided. */
const decideAll = async (requestId: string, clientsOverride?: Record<string, Client>) => {
  const steps: string[] = [];
  for (let i = 0; i < 8; i++) {
    const all = (await admin.get('/api/v1/workflows/tasks/mine?all=true&pageSize=200')).body.data as any[];
    const t = all.find((x) => x.entityType === 'hr_request' && x.entityId === requestId);
    if (!t) break;
    const c = t.assigneeRole ? ((clientsOverride ?? roleClients())[t.assigneeRole] ?? admin) : (userClients.get(t.assigneeUserId) ?? admin);
    const d = await c.post(`/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED', comment: 'ok' });
    expect(d.status, `${t.stepKey}/${t.assigneeRole}: ${JSON.stringify(d.body)}`).toBe(200);
    steps.push(t.stepKey);
    if (d.body.instanceStatus === 'APPROVED') return { steps, ...d.body };
  }
  return null;
};

beforeAll(async () => {
  app = await testApp(); await app.ready();
  admin = await login(app, 'admin@burtplace.local'); hr = await login(app, 'hr.admin@burtplace.local'); hrm = await login(app, 'hr.manager@burtplace.local');
  fin = await login(app, 'finance@burtplace.local'); mgmt = await login(app, 'management@burtplace.local'); payroll = await login(app, 'payroll@burtplace.local'); self = await login(app, 'employee@burtplace.local'); pm = await login(app, 'pm.c31@burtplace.local');
  for (const [email, c] of [['pm.c31@burtplace.local', pm], ['employee@burtplace.local', self], ['payroll@burtplace.local', payroll], ['hr.manager@burtplace.local', hrm], ['hr.admin@burtplace.local', hr]] as const) userClients.set((await app.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id, c);
  const e = await app.db.selectFrom('employees').select(['id', 'employee_no']).where('employee_no', '=', 'BP-26-150').executeTakeFirstOrThrow();
  emp = { id: e.id, no: e.employee_no };
  await hrm.post(`/api/v1/employees/${emp.id}/salary`, { effectiveFrom: '2026-01-01', lines: [{ componentCode: 'BASIC', amount: 4000 }, { componentCode: 'HOUSING', amount: 1500 }, { componentCode: 'TRANSPORT', amount: 500 }] });
  selfEmp = { id: (await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-020').executeTakeFirstOrThrow()).id };
  const pmEmp = await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-019').executeTakeFirstOrThrow();
  pmReport = { id: (await app.db.selectFrom('employees').select('id').where('manager_employee_id', '=', pmEmp.id).where('status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED']).orderBy('employee_no').executeTakeFirstOrThrow()).id };
});
afterAll(async () => { await app.close(); });

describe('employee command center', () => {
  it('returns header, employment health, cards, RBAC-filtered tabs and actions', async () => {
    const s = await hr.get(`/api/v1/employees/${emp.id}/summary`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.header.employeeNo).toBe(emp.no);
    expect(s.body.header.tenure).not.toBeNull();
    expect(s.body.health.map((h: any) => h.key)).toEqual(expect.arrayContaining(['PASSPORT', 'EMIRATES_ID', 'VISA', 'LABOUR_CARD', 'CONTRACT', 'PROBATION']));
    expect(['VALID', 'EXPIRING_SOON', 'EXPIRED', 'MISSING', 'NOT_APPLICABLE']).toContain(s.body.health[0].status);
    expect(s.body.tabs).toEqual(expect.arrayContaining(['overview', 'personal', 'employment', 'job', 'documents', 'requests', 'history']));
    expect(s.body.tabs).not.toContain('disciplinary'); // HR_ADMIN has no disciplinary:read
    expect(s.body.compensation.visible).toBe(false); // HR_ADMIN has no salary:read
    expect(s.body.actions.find((a: any) => a.key === 'promote').enabled).toBe(true);
    expect(s.body.actions.find((a: any) => a.key === 'salary-change').enabled).toBe(false);
    const m = await hrm.get(`/api/v1/employees/${emp.id}/summary`);
    expect(m.body.compensation.visible).toBe(true);
    expect(m.body.compensation.gross).toBe(6000);
    expect(m.body.tabs).toContain('disciplinary');
  });
  it('employee sees own summary but not a colleague\'s compensation', async () => {
    const mine = await self.get(`/api/v1/employees/${selfEmp.id}/summary`);
    expect(mine.status).toBe(200);
    expect(mine.body.tabs).toContain('compensation');
    const other = await self.get(`/api/v1/employees/${emp.id}/summary`);
    expect(other.status).toBe(403);
    const comp = await self.get(`/api/v1/employees/${emp.id}/compensation`);
    expect([403, 404]).toContain(comp.status);
    const promote = await self.post(`/api/v1/employees/${selfEmp.id}/promote`, { newBasic: 99999 });
    expect(promote.status).toBe(403);
  });
});

describe('HR requests — promotion chain', () => {
  let requestId: string, requestNo: string;
  it('promote creates a PENDING request with a before-snapshot and a 4-step chain', async () => {
    const cur = (await app.db.selectFrom('employees').select('designation_id').where('id', '=', emp.id).executeTakeFirstOrThrow()).designation_id;
    const desig = await app.db.selectFrom('designations').select(['id', 'title']).where('id', '!=', cur!).orderBy('title').executeTakeFirstOrThrow();
    const grade = await app.db.selectFrom('grades').select('id').where('code', '=', 'G6').executeTakeFirstOrThrow();
    const res = await hrm.post(`/api/v1/employees/${emp.id}/promote`, { designationId: desig.id, gradeId: grade.id, newBasic: 5000, effectiveDate: '2026-09-01', reason: 'Outstanding delivery on C31' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.workflowInstanceId).toBeTruthy();
    requestId = res.body.id; requestNo = res.body.requestNo;
    expect(requestNo).toMatch(/^HR-\d{4}-\d{6}$/);
    const d = await hrm.get(`/api/v1/hr-requests/${requestId}`);
    expect(d.status).toBe(200);
    expect(d.body.before.salary.basic).toBe(4000);
    expect(d.body.tasks.map((t: any) => t.stepKey)).toEqual(['manager']);
    expect(d.body.changes.find((c: any) => c.field === 'basic')).toMatchObject({ from: 4000, to: 5000 });
    // Employee (not the subject) cannot see restricted payload of someone else's promotion
    const forbidden = await self.get(`/api/v1/hr-requests/${requestId}`);
    expect(forbidden.status).toBe(403);
  });
  it('approvals (manager→HR→finance→management) apply designation, grade, salary version, letter and timeline', async () => {
    const final = await decideAll(requestId);
    expect(final?.instanceStatus).toBe('APPROVED');
    expect(final?.steps).toEqual(['manager', 'hr', 'finance', 'management']);
    const d = await hrm.get(`/api/v1/hr-requests/${requestId}`);
    expect(d.body.status).toBe('APPLIED');
    expect(d.body.result.salaryStructureId).toBeTruthy();
    expect(d.body.result.letterNo).toMatch(/^BP-LTR-/);
    const e = await app.db.selectFrom('employees as e').innerJoin('grades as g', 'g.id', 'e.grade_id').select(['g.code', 'e.designation_id']).where('e.id', '=', emp.id).executeTakeFirstOrThrow();
    expect(e.code).toBe('G6');
    const comp = await hrm.get(`/api/v1/employees/${emp.id}/compensation`);
    expect(comp.status).toBe(200);
    expect(comp.body.versions[0].source).toBe('PROMOTION');
    expect(comp.body.versions[0].basic).toBe(5000);
    expect(comp.body.versions[0].grossDelta).toBe(1000);
    expect(comp.body.versions[0].lines.find((l: any) => l.componentCode === 'BASIC').delta).toBe(1000);
    expect(comp.body.grade.code).toBe('G6');
    const hist = await hrm.get(`/api/v1/employees/${emp.id}/history`);
    expect(hist.body.employment[0].changeType).toBe('PROMOTION');
    const tl = await hrm.get(`/api/v1/employees/${emp.id}/timeline`);
    expect(tl.body.map((x: any) => x.type)).toEqual(expect.arrayContaining(['PROMOTION', 'LETTER', 'REQUEST']));
    const audit = await app.db.selectFrom('audit_logs').select('action').where('entity_id', '=', requestId).execute();
    expect(audit.map((a) => a.action)).toContain('hr_request.promotion.applied');
  });
});

describe('HR requests — loan by employee, deduction/bonus into payroll', () => {
  it('employee raises a loan for self; chain manager(HR_ADMIN fallback)→HR→finance creates instalment schedule', async () => {
    const res = await self.post(`/api/v1/employees/${selfEmp.id}/loan`, { principal: 3000, installments: 3, startPeriod: '2026-10', reason: 'family emergency' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const list = await self.get('/api/v1/hr-requests');
    expect(list.body.data.some((r: any) => r.id === res.body.id)).toBe(true);
    const final = await decideAll(res.body.id);
    expect(final?.instanceStatus).toBe('APPROVED');
    expect(final?.steps).toEqual(['manager', 'hr', 'finance']);
    const loans = await self.get(`/api/v1/compensation/loans?employeeId=${selfEmp.id}`);
    expect(loans.status).toBe(200);
    const loan = loans.body.data.find((l: any) => l.hrRequestId === res.body.id);
    expect(loan.installments).toHaveLength(3);
    expect(loan.installments.map((i: any) => i.period)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(loan.installments.reduce((s: number, i: any) => s + i.amount, 0)).toBe(3000);
    // A second active loan is refused
    const dup = await self.post(`/api/v1/employees/${selfEmp.id}/loan`, { principal: 100, installments: 1, startPeriod: '2026-11' });
    expect(dup.status).toBe(422);
  });
  it('approved deduction and bonus land in the period payroll and are marked APPLIED on lock', async () => {
    const ded = await hrm.post(`/api/v1/employees/${emp.id}/deduction`, { componentCode: 'PENALTY', amount: 250, periodYear: 2026, periodMonth: 8, reason: 'Safety violation', source: 'DISCIPLINARY' });
    expect(ded.status, JSON.stringify(ded.body)).toBe(201);
    expect((await decideAll(ded.body.id))?.steps).toEqual(['hr']);
    const bon = await hrm.post(`/api/v1/employees/${emp.id}/bonus`, { amount: 1000, periodYear: 2026, periodMonth: 8, reason: 'Project milestone', bonusType: 'PROJECT' });
    expect(bon.status).toBe(201);
    expect((await decideAll(bon.body.id))?.steps).toEqual(['hr', 'finance']);
    expect((await hrm.get(`/api/v1/hr-requests/${ded.body.id}`)).body.status).toBe('APPLIED');
    expect((await hrm.get(`/api/v1/hr-requests/${bon.body.id}`)).body.status).toBe('APPLIED');
    const site = (await app.db.selectFrom('employees').select('site_id').where('id', '=', emp.id).executeTakeFirstOrThrow()).site_id!;
    const run = await payroll.post('/api/v1/payroll/runs', { year: 2026, month: 8, filters: { siteIds: [site] } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const calc = await payroll.post(`/api/v1/payroll/runs/${run.body.id}/calculate`);
    expect(calc.status, JSON.stringify(calc.body)).toBe(200);
    const pe = await app.db.selectFrom('payroll_employees').select('id').where('payroll_run_id', '=', run.body.id).where('employee_id', '=', emp.id).executeTakeFirstOrThrow();
    const earn = await app.db.selectFrom('payroll_earnings').select(['component_code', 'amount']).where('payroll_employee_id', '=', pe.id).execute();
    const dedu = await app.db.selectFrom('payroll_deductions').select(['component_code', 'amount']).where('payroll_employee_id', '=', pe.id).execute();
    expect(earn.find((l) => l.component_code === 'BONUS')?.amount).toBe(1000);
    expect(dedu.find((l) => l.component_code === 'PENALTY')?.amount).toBe(250);
    // Clean up the scratch run so the payroll suite's "latest run" assertions are unaffected
    await app.db.updateTable('timesheets').set({ payroll_run_id: null }).where('payroll_run_id', '=', run.body.id).execute();
    await app.db.deleteFrom('payroll_earnings').where('payroll_employee_id', 'in', (eb) => eb.selectFrom('payroll_employees').select('id').where('payroll_run_id', '=', run.body.id)).execute();
    await app.db.deleteFrom('payroll_deductions').where('payroll_employee_id', 'in', (eb) => eb.selectFrom('payroll_employees').select('id').where('payroll_run_id', '=', run.body.id)).execute();
    await app.db.deleteFrom('payroll_employees').where('payroll_run_id', '=', run.body.id).execute();
    await app.db.deleteFrom('payroll_runs').where('id', '=', run.body.id).execute();
  });
});

describe('letters, bulk operations, increment cycle', () => {
  it('generates a salary certificate with a verifiable code; employee can request but not issue', async () => {
    const l = await hrm.post(`/api/v1/employees/${emp.id}/generate-letter`, { templateCode: 'SALARY_CERTIFICATE', addressee: 'Emirates NBD', purpose: 'Bank loan' });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect(l.body.mode).toBe('ISSUED');
    const v = await app.inject({ method: 'GET', url: `/api/v1/letters/verify/${l.body.verificationCode}` });
    expect(v.statusCode).toBe(200);
    expect(v.json().valid).toBe(true);
    const html = await hrm.get(`/api/v1/letters/${l.body.id}/html`);
    expect(html.status).toBe(200);
    expect(html.text).toContain('Emirates NBD');
    expect(html.text).not.toContain('{{');
    const own = await self.post(`/api/v1/employees/${selfEmp.id}/generate-letter`, { templateCode: 'EMPLOYMENT_CERTIFICATE', purpose: 'Visa' });
    expect(own.status).toBe(201);
    expect(own.body.mode).toBe('REQUESTED');
  });
  it('bulk training assignment previews then applies per employee', async () => {
    const course = await app.db.selectFrom('training_catalog').select('id').where('code', '=', 'HSE-IND').executeTakeFirstOrThrow();
    const ids = (await app.db.selectFrom('employees').select('id').where('status', '=', 'ACTIVE').where('deleted_at', 'is', null).orderBy('employee_no').limit(3).execute()).map((x) => x.id);
    const preview = await hrm.post('/api/v1/employees/bulk', { employeeIds: ids, action: 'TRAINING', payload: { courseId: course.id, scheduledDate: '2026-10-05' } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.mode).toBe('PREVIEW');
    expect(preview.body.eligible).toBe(3);
    const applied = await hrm.post('/api/v1/employees/bulk', { employeeIds: ids, action: 'TRAINING', payload: { courseId: course.id, scheduledDate: '2026-10-05' }, confirm: true });
    expect(applied.body.mode).toBe('APPLIED');
    expect(applied.body.results.every((r: any) => r.ok && r.requestNo)).toBe(true);
  });
  it('increment cycle: populate → review → approve → apply creates INCREMENT salary versions', async () => {
    const dept = (await app.db.selectFrom('employees').select('department_id').where('id', '=', emp.id).executeTakeFirstOrThrow()).department_id!;
    const c = await hrm.post('/api/v1/compensation/increment-cycles', { name: 'Test cycle', year: 2026, effectiveDate: '2026-11-01', defaultPercentage: 5, filters: { departmentIds: [dept] } });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.stats.entries).toBeGreaterThan(0);
    const detail = await hrm.get(`/api/v1/compensation/increment-cycles/${c.body.id}`);
    const mine = detail.body.entries.find((e: any) => e.employee.id === emp.id);
    expect(mine.currentBasic).toBe(5000);
    expect(mine.newBasic).toBe(5250);
    const others = detail.body.entries.filter((e: any) => e.employee.id !== emp.id).map((e: any) => ({ id: e.id, status: 'EXCLUDED' }));
    if (others.length) await hrm.patch(`/api/v1/compensation/increment-cycles/${c.body.id}/entries`, { entries: others });
    await hrm.patch(`/api/v1/compensation/increment-cycles/${c.body.id}/entries`, { entries: [{ id: mine.id, percentage: 10 }] });
    for (const to of ['IN_REVIEW', 'APPROVED', 'APPLIED']) { const t = await hrm.post(`/api/v1/compensation/increment-cycles/${c.body.id}/transition`, { to }); expect(t.status, JSON.stringify(t.body)).toBe(200); if (to === 'APPLIED') { expect(t.body.applied).toBe(1); expect(t.body.failed).toEqual([]); } }
    const comp = await hrm.get(`/api/v1/employees/${emp.id}/compensation`);
    expect(comp.body.versions[0].source).toBe('INCREMENT');
    expect(comp.body.versions[0].basic).toBe(5500);
    expect(comp.body.versions[0].effectiveFrom).toBe('2026-11-01');
  });
});

describe('analytics, control center, calendar, delegation', () => {
  it('control center lists attention items and headcount', async () => {
    const cc = await hrm.get('/api/v1/analytics/control-center');
    expect(cc.status, JSON.stringify(cc.body)).toBe(200);
    expect(cc.body.headcount.total).toBeGreaterThan(100);
    expect(cc.body.attention.length).toBeGreaterThan(0);
    const hrA = await hrm.get('/api/v1/analytics/hr?months=6');
    expect(hrA.status, JSON.stringify(hrA.body)).toBe(200);
    expect(hrA.body.headcountTrend).toHaveLength(6);
    expect(hrA.body.requests.find((r: any) => r.type === 'PROMOTION').applied).toBeGreaterThanOrEqual(1);
    const cost = await hrm.get('/api/v1/analytics/workforce-cost?groupBy=project');
    expect(cost.status).toBe(200);
    expect(cost.body.total).toBeGreaterThan(0);
    const noCost = await hr.get('/api/v1/analytics/workforce-cost?groupBy=project');
    expect(noCost.status).toBe(403);
    // Approve one of the bulk TRAINING requests so a scheduled training appears on the calendar
    const pendingTraining = (await hrm.get('/api/v1/hr-requests?type=TRAINING&status=PENDING&pageSize=1')).body.data[0];
    expect((await decideAll(pendingTraining.id))?.steps).toEqual(['manager', 'hr']);
    expect((await hrm.get(`/api/v1/hr-requests/${pendingTraining.id}`)).body.status).toBe('APPLIED');
    const cal = await hrm.get('/api/v1/analytics/calendar?from=2026-09-01&to=2026-12-31');
    expect(cal.status, JSON.stringify(cal.body)).toBe(200);
    expect(cal.body.some((e: any) => e.kind === 'TRAINING' && e.date === '2026-10-05')).toBe(true);
    const org = await hrm.get('/api/v1/employees/org-chart?depth=2');
    expect(org.status, JSON.stringify(org.body)).toBe(200);
    expect(org.body.length).toBeGreaterThan(0);
    const filtered = await hrm.get('/api/v1/employees?missing=iban&pageSize=5');
    expect(filtered.status).toBe(200);
  });
  it('a delegate sees and decides the delegator\'s manager tasks', async () => {
    const pmUser = await app.db.selectFrom('users').select('id').where('email', '=', 'pm.c31@burtplace.local').executeTakeFirstOrThrow();
    const payrollUser = await app.db.selectFrom('users').select('id').where('email', '=', 'payroll@burtplace.local').executeTakeFirstOrThrow();
    const today = new Date().toISOString().slice(0, 10);
    const d = await pm.post('/api/v1/workflows/delegations', { toUserId: payrollUser.id, fromDate: today, toDate: today, reason: 'Leave' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const req = await hrm.post(`/api/v1/employees/${pmReport.id}/assign-training`, { courseId: (await app.db.selectFrom('training_catalog').select('id').where('code', '=', 'WAH').executeTakeFirstOrThrow()).id });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const task = await app.db.selectFrom('workflow_tasks').select(['id', 'assignee_user_id']).where('instance_id', '=', req.body.workflowInstanceId).where('status', '=', 'PENDING').executeTakeFirstOrThrow();
    expect(task.assignee_user_id).toBe(pmUser.id);
    const mine = await payroll.get('/api/v1/workflows/tasks/mine?pageSize=100');
    expect(mine.body.data.some((t: any) => t.id === task.id)).toBe(true);
    const dec = await payroll.post(`/api/v1/workflows/tasks/${task.id}/decide`, { decision: 'APPROVED' });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    await pm.del(`/api/v1/workflows/delegations/${d.body.id}`);
    const gone = await payroll.get('/api/v1/workflows/delegations');
    expect(gone.body.find((x: any) => x.id === d.body.id)?.isActive).toBe(false);
  });
});
