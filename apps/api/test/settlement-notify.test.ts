import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, testApp, type App, type Client } from './helpers.js';

/** Final settlement preview, QR-verified letters and notification channel fan-out. */
let app: App, hrm: Client, payroll: Client, self: Client;
let emp: { id: string };
beforeAll(async () => {
  app = await testApp(); await app.ready();
  hrm = await login(app, 'hr.manager@burtplace.local'); payroll = await login(app, 'payroll@burtplace.local'); self = await login(app, 'employee@burtplace.local');
  emp = { id: (await app.db.selectFrom('employees').select('id').where('employee_no', '=', 'BP-26-160').executeTakeFirstOrThrow()).id };
  await hrm.post(`/api/v1/employees/${emp.id}/salary`, { effectiveFrom: '2026-01-01', lines: [{ componentCode: 'BASIC', amount: 3000 }, { componentCode: 'HOUSING', amount: 1000 }] });
  await app.db.updateTable('employees').set({ joining_date: '2021-01-01' }).where('id', '=', emp.id).execute();
});
afterAll(async () => { await app.close(); });

describe('final settlement', () => {
  it('computes a DRAFT statement from the policy bands and live inputs; employees cannot preview others', async () => {
    const r = await payroll.get(`/api/v1/employees/${emp.id}/final-settlement?lastWorkingDate=2026-12-31&exitType=RESIGNATION`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('DRAFT');
    expect(r.body.policySignedOff).toBe(false);
    expect(r.body.service.years).toBe(6);
    const g = r.body.lines.find((l: any) => l.code === 'GRATUITY');
    // 6 years on basic 3000 (daily 100): 5y × 21 + ~1y × 30 ≈ 135 days → ≈ 13,500 (pro-rata over 2191 days)
    expect(g.amount).toBeGreaterThan(13400); expect(g.amount).toBeLessThan(13600);
    expect(r.body.warnings.join(' ')).toMatch(/not been signed off/);
    expect(r.body.net).toBe(r.body.totalEarnings - r.body.totalDeductions);
    const other = await self.get(`/api/v1/employees/${emp.id}/final-settlement?lastWorkingDate=2026-12-31`);
    expect(other.status).toBe(404);
    const missing = await payroll.get(`/api/v1/employees/${emp.id}/final-settlement`);
    expect(missing.status).toBe(400);
  });
});

describe('letters carry a scannable QR and notifications fan out only when channels are configured', () => {
  it('embeds an SVG QR pointing at the public verify URL', async () => {
    const l = await hrm.post(`/api/v1/employees/${emp.id}/generate-letter`, { templateCode: 'EMPLOYMENT_CERTIFICATE', purpose: 'Tenancy contract' });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    const html = await hrm.get(`/api/v1/letters/${l.body.id}/html`);
    expect(html.text).toContain('<svg');
    expect(html.text).toContain(`/verify/${l.body.verificationCode}`);
  });
  it('deliverPending is a no-op without SMTP/Teams and records failures when a channel is misconfigured', async () => {
    const { deliverPending, resetChannels } = await import('../src/notifications/channels.js');
    expect(await deliverPending(app)).toBe(0);
    // Simulate a configured but unreachable Teams webhook: delivery must not throw and must leave an auditable error row.
    const { resetEnvCache, getEnv } = await import('@burtplace/config');
    process.env.TEAMS_WEBHOOK_URL = 'http://127.0.0.1:9/hook'; resetEnvCache(); getEnv(); resetChannels();
    const uid = (await app.db.selectFrom('users').select('id').where('email', '=', 'hr.manager@burtplace.local').executeTakeFirstOrThrow()).id;
    await app.db.insertInto('notifications').values({ user_id: uid, type: 'approval.pending', title: 'Test approval', body: 'unit test', link: '/approvals' }).execute();
    const n = await deliverPending(app);
    expect(n).toBeGreaterThanOrEqual(1);
    const failed = await app.db.selectFrom('notifications').select(['channel', 'send_error']).where('user_id', '=', uid).where('channel', '=', 'TEAMS').orderBy('created_at', 'desc').executeTakeFirst();
    expect(failed?.send_error).toBeTruthy();
    delete process.env.TEAMS_WEBHOOK_URL; resetEnvCache(); resetChannels();
  });
});
