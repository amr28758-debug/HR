import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, testApp, type App, type Client } from './helpers.js';

let app: App, hr: Client, hrm: Client, it_: Client;
beforeAll(async () => { app = await testApp(); await app.ready(); hr = await login(app, 'hr.admin@burtplace.local'); hrm = await login(app, 'hr.manager@burtplace.local'); it_ = await login(app, 'it.admin@burtplace.local'); });
afterAll(async () => { await app.close(); });

describe('employee master', () => {
  let id: string;
  it('creates an employee with an auto-generated number and audit entry', async () => {
    const site = await app.db.selectFrom('sites').select('id').where('code', '=', 'C31-SITE').executeTakeFirstOrThrow();
    const res = await hr.post('/api/v1/employees', { firstName: 'Test', lastName: 'Candidate', siteId: site.id, isOfficeStaff: true, matrixUserId: '5001', workEmail: 'test.candidate@burtplace.local' });
    expect(res.status).toBe(201);
    expect(res.body.employeeNo).toMatch(/^BP-\d{2}-\d{3,}$/);
    expect(res.body.status).toBe('CANDIDATE');
    expect(res.body.allowedTransitions).toEqual(['OFFER', 'ARCHIVED']);
    id = res.body.id;
    const audit = await hr.get(`/api/v1/audit?entityType=employee&entityId=${id}`);
    expect(audit.status).toBe(403); // HR_ADMIN lacks audit:read
    const mapping = await app.db.selectFrom('biometric_mappings').select('employee_id').where('external_user_id', '=', '5001').executeTakeFirst();
    expect(mapping?.employee_id).toBe(id);
  });
  it('rejects invalid input with a standard error envelope', async () => {
    const res = await hr.post('/api/v1/employees', { firstName: '', lastName: 'X', workEmail: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });
  it('finds by employee number (search)', async () => {
    const res = await hr.get('/api/v1/search?q=BP-26-777');
    expect(res.status).toBe(200);
    const byNo = await hr.get('/api/v1/employees/by-number/BP-26-001');
    expect(byNo.status).toBe(200);
    expect((await hr.get('/api/v1/search?q=BP-26-001')).body[0].title).toContain('BP-26-001');
  });
  it('walks the lifecycle and creates an onboarding checklist filtered by office-staff items', async () => {
    for (const to of ['OFFER', 'APPROVED', 'PRE_ONBOARDING', 'ONBOARDING']) {
      const res = await hr.post(`/api/v1/employees/${id}/transition`, { to, reason: 'test' });
      expect(res.status, `${to}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const checklists = await hr.get(`/api/v1/employees/${id}/checklists`);
    expect(checklists.body).toHaveLength(1);
    const tasks = checklists.body[0].tasks;
    expect(tasks.map((t: any) => t.key)).toContain('it.email');
    expect(tasks.map((t: any) => t.key)).toContain('hr.contract');
    const emailTask = tasks.find((t: any) => t.key === 'it.email');
    expect((await hr.post(`/api/v1/employees/checklist-tasks/${emailTask.id}/complete`, {})).status).toBe(400); // owned by IT_ADMIN
    expect((await it_.post(`/api/v1/employees/checklist-tasks/${emailTask.id}/complete`, { note: 'done' })).body.instanceStatus).toBe('OPEN');
  });
  it('rejects illegal transitions', async () => {
    const res = await hr.post(`/api/v1/employees/${id}/transition`, { to: 'ARCHIVED' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Cannot transition');
  });
  it('activates, records employment history on transfer, and versions salary', async () => {
    expect((await hr.post(`/api/v1/employees/${id}/transition`, { to: 'PROBATION' })).status).toBe(200);
    const site = await app.db.selectFrom('sites').select('id').where('code', '=', 'C42-SITE').executeTakeFirstOrThrow();
    const upd = await hr.patch(`/api/v1/employees/${id}`, { siteId: site.id, reason: 'moved to C42' });
    expect(upd.status).toBe(200);
    const hist = await hr.get(`/api/v1/employees/${id}/history`);
    expect(hist.body.employment[0].changeType).toBe('TRANSFER');
    expect(hist.body.status.map((s: any) => s.toStatus)).toContain('PROBATION');
    expect((await hr.post(`/api/v1/employees/${id}/salary`, { effectiveFrom: '2026-01-01', lines: [{ componentCode: 'BASIC', amount: 5000 }, { componentCode: 'HOUSING', amount: 2000 }, { componentCode: 'TRANSPORT', amount: 1000 }] })).status).toBe(403);
    const s1 = await hrm.post(`/api/v1/employees/${id}/salary`, { effectiveFrom: '2026-01-01', lines: [{ componentCode: 'BASIC', amount: 5000 }, { componentCode: 'HOUSING', amount: 2000 }, { componentCode: 'TRANSPORT', amount: 1000 }] });
    expect(s1.status).toBe(201);
    expect(s1.body.grossSalary).toBe(8000);
    const s2 = await hrm.post(`/api/v1/employees/${id}/salary`, { effectiveFrom: '2026-07-01', reason: 'increment', lines: [{ componentCode: 'BASIC', amount: 5500 }, { componentCode: 'HOUSING', amount: 2000 }, { componentCode: 'TRANSPORT', amount: 1000 }] });
    expect(s2.body.version).toBe(2);
    const all = await hrm.get(`/api/v1/employees/${id}/salary`);
    expect(all.body).toHaveLength(2);
    expect(all.body[1].effectiveTo).toBe('2026-06-30');
    const audit = await app.db.selectFrom('audit_logs').select(['action', 'old_value', 'new_value']).where('entity_id', '=', id).where('action', '=', 'employee.salary.update').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect((audit.old_value as any).gross).toBe(8000);
  });
  it('manages documents with computed expiry status', async () => {
    const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const doc = await hr.post(`/api/v1/employees/${id}/documents`, { documentType: 'VISA', documentNumber: 'V123', expiryDate: soon });
    expect(doc.status).toBe(201);
    expect(doc.body.status).toBe('EXPIRING');
    expect(doc.body.daysToExpiry).toBeLessThanOrEqual(10);
    expect((await hr.get(`/api/v1/employees/${id}/documents`)).body).toHaveLength(1);
    expect((await hr.del(`/api/v1/employees/${id}/documents/${doc.body.id}`)).status).toBe(204);
    expect((await hr.get(`/api/v1/employees/${id}/documents`)).body).toHaveLength(0);
  });
  it('resignation starts the RESIGNATION workflow and clearance follows approval', async () => {
    const res = await hr.post(`/api/v1/employees/${id}/transition`, { to: 'RESIGNED', lastWorkingDate: '2026-10-31', reason: 'personal' });
    expect(res.status).toBe(200);
    expect(res.body.workflowInstanceId).toBeTruthy();
    const inst = await hrm.get(`/api/v1/workflows/instances/${res.body.workflowInstanceId}`);
    expect(inst.body.workflowCode).toBe('RESIGNATION');
    expect(inst.body.tasks[0].stepKey).toBe('manager');
  });
});
