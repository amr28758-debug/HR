import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, testApp, type App, type Client } from './helpers.js';
import { mapZohoEmployees } from '../../../integrations/zoho/src/index.js';

let app: App, hr: Client;
beforeAll(async () => { app = await testApp(); await app.ready(); hr = await login(app, 'hr.manager@burtplace.local'); });
afterAll(async () => { await app.close(); });

describe('legacy migration framework', () => {
  it('validates, applies and re-applies employee rows idempotently (Zoho export → mapper → batch)', async () => {
    const zohoExport = [
      { recordId: 'z-1', EmployeeID: 'BP-26-901', FirstName: 'Migrated', LastName: 'One', EmailID: 'm.one@burtplace.local', Gender: 'Male', Dateofjoining: '01-Feb-2024', Department: 'CIVIL', Location: 'C31-SITE', Employee_type: 'Permanent', Employeestatus: 'Active' },
      { recordId: 'z-2', EmployeeID: 'BP-26-902', FirstName: 'Migrated', LastName: 'Two', Gender: 'Female', Dateofjoining: '15/03/2025', Department: 'HR', Location: 'HO', Employeestatus: 'Probation' },
      { recordId: 'z-3', EmployeeID: 'BP-26-903', FirstName: '', LastName: 'Broken' },
    ];
    const rows = mapZohoEmployees(zohoExport).map((r, i) => (i === 0 ? { ...r, basicSalary: 3000, housing: 750, transport: 300 } : r));
    const batch = await hr.post('/api/v1/migration/batches', { source: 'ZOHO_PEOPLE', entityType: 'employees', rows });
    expect(batch.status).toBe(201);
    expect(batch.body).toMatchObject({ status: 'VALIDATED', totalRows: 3, validRows: 2 });
    expect(batch.body.errors[0].row).toBe(3);
    const applied = await hr.post(`/api/v1/migration/batches/${batch.body.id}/apply`);
    expect(applied.body).toMatchObject({ status: 'APPLIED', appliedRows: 2 });
    const e1 = await hr.get('/api/v1/employees/by-number/BP-26-901');
    expect(e1.body).toMatchObject({ fullNameEn: 'Migrated One', status: 'ACTIVE', joiningDate: '2024-02-01', zohoRecordId: 'z-1' });
    expect(e1.body.site.name).toContain('C31');
    const sal = await hr.get(`/api/v1/employees/${e1.body.id}/salary`);
    expect(sal.body[0].grossSalary).toBe(4050);
    // re-run: same employee number → update, not duplicate
    const again = await hr.post('/api/v1/migration/batches', { source: 'ZOHO_PEOPLE', entityType: 'employees', rows: [{ ...rows[0], mobile: '+971500000001' }] });
    await hr.post(`/api/v1/migration/batches/${again.body.id}/apply`);
    const list = await hr.get('/api/v1/employees?q=BP-26-901');
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].mobile).toBe('+971500000001');
    // leave balances
    const lb = await hr.post('/api/v1/migration/batches', { source: 'EXCEL', entityType: 'leave_balances', rows: [{ employeeNo: 'BP-26-901', leaveTypeCode: 'ANNUAL', year: 2026, balanceDays: 12.5 }] });
    await hr.post(`/api/v1/migration/batches/${lb.body.id}/apply`);
    const bal = (await hr.get(`/api/v1/employees/${e1.body.id}`)).body.id && (await hr.get(`/api/v1/leave/balances/${e1.body.id}?year=2026`)).body.find((b: any) => b.leaveTypeCode === 'ANNUAL');
    expect(bal.opening).toBe(12.5);
  });
});
