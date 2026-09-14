import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, login, testApp, type App } from './helpers.js';

let app: App;
beforeAll(async () => { app = await testApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

describe('auth', () => {
  it('rejects anonymous and bad tokens', async () => {
    expect((await client(app, {}).get('/api/v1/auth/me')).status).toBe(401);
    expect((await client(app, { authorization: 'Bearer nope' }).get('/api/v1/auth/me')).status).toBe(401);
    expect((await client(app, { 'x-api-key': 'bpw_invalid' }).get('/api/v1/devices')).status).toBe(401);
  });
  it('local login returns a JWT and /me lists roles and permissions', async () => {
    const hr = await login(app, 'hr.admin@burtplace.local');
    const me = await hr.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(['HR_ADMIN']);
    expect(me.body.permissions).toContain('employees:create');
    expect(me.body.permissions).not.toContain('salary:write');
  });
  it('rejects wrong password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/local/login', payload: { email: 'hr.admin@burtplace.local', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });
  it('exposes public auth config', async () => {
    const res = await client(app, {}).get('/api/v1/auth/config');
    expect(res.body.mode).toBe('local');
  });
});

describe('rbac scoping', () => {
  it('employee sees only own record; manager sees team; HR sees all', async () => {
    const emp = await login(app, 'employee@burtplace.local');
    const list = await emp.get('/api/v1/employees');
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].employeeNo).toBe('BP-26-020');
    const pm = await login(app, 'pm.c31@burtplace.local');
    const team = await pm.get('/api/v1/employees?pageSize=200');
    expect(team.body.meta.total).toBeGreaterThan(10);
    const hr = await login(app, 'hr.admin@burtplace.local');
    expect((await hr.get('/api/v1/employees')).body.meta.total).toBeGreaterThanOrEqual(175);
  });
  it('employee cannot read other profiles, payroll, or salary of others', async () => {
    const emp = await login(app, 'employee@burtplace.local');
    const other = await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-001').executeTakeFirstOrThrow();
    expect((await emp.get(`/api/v1/employees/${other.id}`)).status).toBe(403);
    expect((await emp.get('/api/v1/payroll/runs')).status).toBe(403);
    expect((await emp.get(`/api/v1/employees/${other.id}/salary`)).status).toBe(404);
    const me = await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-020').executeTakeFirstOrThrow();
    expect((await emp.get(`/api/v1/employees/${me.id}/salary`)).status).toBe(200);
  });
  it('banking is hidden without employees:banking:read', async () => {
    const hr = await login(app, 'hr.admin@burtplace.local');
    const fin = await login(app, 'finance@burtplace.local');
    const e = await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-001').executeTakeFirstOrThrow();
    expect((await hr.get(`/api/v1/employees/${e.id}`)).body.banking).toBeNull();
    expect((await fin.get(`/api/v1/employees/${e.id}`)).body.banking).not.toBeNull();
  });
  it('auditor is read-only', async () => {
    const aud = await login(app, 'auditor@burtplace.local');
    expect((await aud.get('/api/v1/audit')).status).toBe(200);
    expect((await aud.post('/api/v1/employees', { firstName: 'X', lastName: 'Y' })).status).toBe(403);
  });
});
