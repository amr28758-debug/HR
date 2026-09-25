import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { login, testApp, type App, type Client } from './helpers.js';

/**
 * Compensation & Salary Management: bands, profile metrics, ceiling handling, individual changes through the approval chain,
 * duplicate protection, exceptions, rejection/cancellation, promotions, budgets, salary reviews, scenarios, dashboard,
 * reports, alerts, permissions and audit.
 */
let app: App, admin: Client, officer: Client, hrm: Client, hr: Client, fin: Client, mgmt: Client, self: Client, it_: Client, auditor: Client;
const C = '/api/v1/compensation';
let gradeId: string, g5: string;
const E: Record<string, string> = {}; // label → employee id
const ROLE: () => Record<string, Client> = () => ({ HR_MANAGER: hrm, FINANCE_MANAGER: fin, MANAGEMENT: mgmt, HR_ADMIN: hr });

/** Walk the approval chain of a salary change (or promotion via its change id) until it leaves the pending states. */
async function approveAll(changeId: string, decision: 'APPROVED' | 'REJECTED' = 'APPROVED') {
  const steps: string[] = [];
  for (let i = 0; i < 8; i++) {
    const c = await admin.get(`${C}/changes/${changeId}`);
    const t = c.body.tasks.find((x: any) => x.status === 'PENDING');
    if (!t) return { steps, change: c.body };
    const client = (t.role && ROLE()[t.role]) || admin;
    const d = await client.post(`${C}/changes/${changeId}/approve`, { decision, comment: `${t.step} ok` });
    expect(d.status, `${t.step}/${t.role}: ${JSON.stringify(d.body)}`).toBe(200);
    steps.push(t.step);
  }
  throw new Error('approval chain did not finish');
}
const salaryOf = async (id: string) => Number((await app.db.selectFrom('employee_salary_structures').select('basic_salary').where('employee_id', '=', id).orderBy('version', 'desc').executeTakeFirstOrThrow()).basic_salary);

beforeAll(async () => {
  app = await testApp(); await app.ready();
  [admin, officer, hrm, hr, fin, mgmt, self, it_, auditor] = await Promise.all(['admin', 'comp.officer', 'hr.manager', 'hr.admin', 'finance', 'management', 'employee', 'it.admin', 'auditor'].map((u) => login(app, `${u}@burtplace.local`)));
  // Test grade with the brief's example band (5,000 / 6,500 / 8,000)
  const g = await hrm.post(`${C}/grades`, { code: 'TG4', name: 'Test grade 4', description: 'Compensation test grade', sortOrder: 4 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  gradeId = g.body.id;
  const b = await hrm.post(`${C}/salary-bands`, { gradeId, min: 5000, mid: 6500, max: 8000, effectiveFrom: '2026-01-01' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  g5 = (await app.db.selectFrom('grades').select('id').where('code', '=', 'G5').executeTakeFirstOrThrow()).id;
  // Fixture employees from the end of the register (other suites use the first ones), placed in TG4 with known salaries.
  const emps = await app.db.selectFrom('employees').select(['id']).where('status', 'in', ['ACTIVE', 'CONFIRMED']).where('deleted_at', 'is', null).where('employee_no', 'not in', ['BP-26-150', 'BP-26-020', 'BP-26-019']).orderBy('employee_no', 'desc').limit(8).execute();
  const plan: [string, number][] = [['low', 5000], ['mid', 7500], ['near', 7800], ['promo', 6000], ['rej', 6000], ['dup', 5200], ['rev', 6000], ['rev2', 7900]];
  for (const [i, [label, basic]] of plan.entries()) {
    const id = emps[i]!.id; E[label] = id;
    await app.db.updateTable('employees').set({ grade_id: gradeId, grade: 'TG4', joining_date: '2023-01-01', probation_status: 'NOT_APPLICABLE' }).where('id', '=', id).execute();
    const s = await hrm.post(`/api/v1/employees/${id}/salary`, { effectiveFrom: '2026-01-01', reason: 'Test fixture', lines: [{ componentCode: 'BASIC', amount: basic }, { componentCode: 'HOUSING', amount: 1500 }] });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
  }
});
afterAll(async () => { await app.close(); });

describe('salary structure', () => {
  it('validates bands and prevents overlapping active bands', async () => {
    expect((await hrm.post(`${C}/salary-bands`, { gradeId, min: 9000, mid: 6000, max: 8000, effectiveFrom: '2027-01-01' })).status).toBe(400);
    expect((await hrm.post(`${C}/salary-bands`, { gradeId, min: 5000, mid: 6500, max: 8000, effectiveFrom: '2025-06-01' })).status).toBe(409);
    const gc = await hrm.get(`${C}/grade-check?gradeId=${gradeId}&basic=8250`);
    expect(gc.body).toMatchObject({ position: 'ABOVE_MAX', max: 8000, status: { code: 'ABOVE_MAX', color: 'RED' } });
    const grades = await officer.get(`${C}/grades`);
    expect(grades.body.find((x: any) => x.id === gradeId).currentBand).toMatchObject({ min: 5000, mid: 6500, max: 8000 });
    expect((await officer.post(`${C}/salary-bands`, { gradeId, min: 1, max: 2, effectiveFrom: '2030-01-01' })).status).toBe(403); // officer cannot configure
  });
  it('maps job titles to grades (audited)', async () => {
    const m = await officer.get(`${C}/job-grade-mappings`);
    expect(m.status).toBe(200);
    expect(m.body.length).toBeGreaterThan(5);
  });
});

describe('employee compensation profile', () => {
  it('computes compa-ratio, range penetration, headroom and the configurable status', async () => {
    const r = await officer.get(`${C}/employee/${E.near}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.profile).toMatchObject({ currentSalary: 7800, compaRatio: 120, rangePenetration: 93.33, remainingToMax: 200, bandStatus: { code: 'NEAR_CEILING', color: 'ORANGE' } });
    expect(r.body.profile.maxPossibleIncreasePct).toBe(2.56);
    expect(r.body.history[0]).toMatchObject({ salary: 7800 });
    expect(r.body.actions.map((a: any) => a.key)).toEqual(['ANNUAL_INCREMENT', 'PROMOTION', 'MARKET_ADJUSTMENT', 'SALARY_CORRECTION']);
    const low = await officer.get(`${C}/employee/${E.low}`);
    expect(low.body.profile).toMatchObject({ rangePenetration: 0, bandStatus: { code: 'NORMAL', color: 'GREEN' } });
  });
  it('direct salary entry is mirrored in the ledger (joining / flagged correction)', async () => {
    const rows = await app.db.selectFrom('salary_changes').select(['change_type', 'outside_workflow', 'source']).where('employee_id', '=', E.low!).execute();
    expect(rows.some((x) => x.source === 'DIRECT')).toBe(true);
  });
  it('protects salary visibility', async () => {
    expect((await self.get(`${C}/employee/${E.low}`)).status).toBe(403);
    expect((await it_.get(`${C}/employees`)).status).toBe(403);          // system administrator: no salary visibility
    expect((await it_.get(`${C}/settings/policy`)).status).toBe(200);    // … but may configure non-monetary settings
    expect((await hr.get(`${C}/employees`)).status).toBe(403);           // HR_ADMIN has compensation:read without salary:read
    const dash = await hr.get(`${C}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.body.amountsVisible).toBe(false);
    expect(dash.body.cards.totalPayroll).toBeNull();
    expect(dash.body.aboveMaximum).toEqual([]);
  });
});

describe('increment calculation & ceiling', () => {
  it('10% on 7,500 exceeds the 8,000 maximum by AED 250 — never silently', async () => {
    const r = await officer.post(`${C}/increments/calculate`, { employeeId: E.mid, changeType: 'ANNUAL_INCREMENT', increasePct: 10, effectiveDate: '2027-01-01' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.calculation).toMatchObject({ proposedSalary: 8250, exceedsMaxBy: 250, outcome: 'ACTION_REQUIRED' });
    expect(r.body.blockers[0]).toMatch(/^Proposed salary exceeds the maximum salary band by AED 250\./);
    expect(r.body.allowedCeilingActions).toEqual(['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE']);
    const capped = await officer.post(`${C}/increments/calculate`, { employeeId: E.mid, changeType: 'ANNUAL_INCREMENT', increasePct: 10, effectiveDate: '2027-01-01', ceilingAction: 'CAP_AT_MAX' });
    expect(capped.body.calculation).toMatchObject({ finalSalary: 8000, outcome: 'CAPPED' });
    const blocked = await officer.post(`${C}/increments`, { employeeId: E.mid, increasePct: 10, effectiveDate: '2027-01-01', reason: 'Annual increment' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('COMPENSATION_BLOCKED');
    const noJust = await officer.post(`${C}/increments`, { employeeId: E.mid, increasePct: 10, effectiveDate: '2027-01-01', reason: 'Annual increment', ceilingAction: 'REQUEST_EXCEPTION' });
    expect(noJust.status).toBe(422);
  });
});

describe('individual salary change through the approval workflow', () => {
  let changeId: string;
  it('creates, submits and completes an annual increment in one transaction after HR → Finance approval', async () => {
    const c = await officer.post(`${C}/increments`, { employeeId: E.low, increasePct: 10, effectiveDate: '2027-01-01', reason: 'Annual increment 2027', submit: true });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ status: 'SUBMITTED', oldSalary: 5000, increaseAmount: 500, increasePct: 10, newSalary: 5500, changeType: 'ANNUAL_INCREMENT' });
    changeId = c.body.id;
    expect(await salaryOf(E.low!)).toBe(5000); // nothing changes before approval
    const res = await approveAll(changeId);
    expect(res.steps).toEqual(['hr_manager', 'finance']); // management step only when an exception is requested
    expect(res.change.status).toBe('COMPLETED');
    expect(await salaryOf(E.low!)).toBe(5500);
    const trail = res.change.approvals.map((a: any) => [a.action, a.role, a.previousStatus, a.newStatus]);
    expect(trail).toEqual([['CREATE', 'COMPENSATION_OFFICER', null, 'DRAFT'], ['SUBMIT', 'COMPENSATION_OFFICER', 'DRAFT', 'SUBMITTED'], ['APPROVE', 'HR_MANAGER', 'SUBMITTED', 'HR_APPROVED'], ['FINAL_APPROVE', 'FINANCE_MANAGER', 'HR_APPROVED', 'FINANCE_APPROVED'], ['COMPLETE', null, 'FINANCE_APPROVED', 'COMPLETED']]);
    expect(res.change.approvedBy).toBe('Finance Manager');
    const audit = await auditor.get(`${C}/audit?entityId=${changeId}`);
    expect(audit.body.data.map((a: any) => a.action)).toEqual(expect.arrayContaining(['compensation.change.create', 'compensation.change.submit', 'compensation.change.approve', 'compensation.change.completed']));
  });
  it('blocks a duplicate annual increase; only authorised users may override with justification', async () => {
    const d = await officer.post(`${C}/increments`, { employeeId: E.low, increasePct: 3, effectiveDate: '2027-06-01', reason: 'Second increase' });
    expect(d.status).toBe(409);
    expect(d.body.error.message).toBe('Annual salary increase has already been processed for this employee for 2027.');
    expect((await officer.post(`${C}/increments`, { employeeId: E.low, increasePct: 3, effectiveDate: '2027-06-01', reason: 'Second increase', overrideDuplicate: true, justification: 'x' })).status).toBe(403);
    expect((await hrm.post(`${C}/increments`, { employeeId: E.low, increasePct: 3, effectiveDate: '2027-06-01', reason: 'Second increase', overrideDuplicate: true })).status).toBe(422);
    const ok = await hrm.post(`${C}/increments`, { employeeId: E.low, increasePct: 3, effectiveDate: '2027-06-01', reason: 'Second increase', overrideDuplicate: true, justification: 'Retention — approved by GM' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.duplicateOverride).toBe(true);
    expect((await hrm.post(`${C}/changes/${ok.body.id}/cancel`, { reason: 'Not needed' })).body.status).toBe('CANCELLED');
    // the database refuses a second live annual increase even without the service
    await expect(sql`INSERT INTO salary_changes(change_no, employee_id, change_type, status, old_salary, increase_amount, increase_pct, new_salary, effective_date, reason) VALUES ('SC-TEST-DUP', ${E.low}, 'ANNUAL_INCREMENT', 'DRAFT', 5500, 1, 0.1, 5501, '2027-03-01', 'x')`.execute(app.db)).rejects.toThrow(/salary_changes_one_annual_increment/);
  });
  it('historical salary records can never be deleted or rewritten', async () => {
    await expect(app.db.deleteFrom('salary_changes').where('id', '=', changeId).execute()).rejects.toThrow(/never deleted/);
    await expect(app.db.updateTable('salary_changes').set({ new_salary: 1 }).where('id', '=', changeId).execute()).rejects.toThrow(/can no longer be modified/);
    await expect(app.db.deleteFrom('employee_salary_structures').where('employee_id', '=', E.low!).execute()).rejects.toThrow(/immutable/);
  });
  it('requests a band exception: management joins the chain and the salary may exceed the maximum', async () => {
    const c = await officer.post(`${C}/increments`, { employeeId: E.near, increasePct: 10, effectiveDate: '2027-01-01', reason: 'Annual increment 2027', ceilingAction: 'REQUEST_EXCEPTION', justification: 'Critical skill; retention risk', submit: true });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ newSalary: 8580, exceedsMaxBy: 580, requiresException: true });
    expect(c.body.alerts[0].message).toBe('Proposed salary exceeds the maximum salary band by AED 580.');
    const res = await approveAll(c.body.id);
    expect(res.steps).toEqual(['hr_manager', 'finance', 'management']);
    expect(res.change.status).toBe('COMPLETED');
    expect(await salaryOf(E.near!)).toBe(8580);
  });
  it('segregation of duties: the submitter cannot approve their own request', async () => {
    const c = await hrm.post(`${C}/changes`, { employeeId: E.rej, changeType: 'MARKET_ADJUSTMENT', increaseAmount: 300, effectiveDate: '2027-02-01', reason: 'Market data', submit: true });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const self_ = await hrm.post(`${C}/changes/${c.body.id}/approve`, { decision: 'APPROVED' });
    expect(self_.status).toBe(403);
    expect(self_.body.error.message).toMatch(/Segregation of duties/);
    await hrm.post(`${C}/changes/${c.body.id}/cancel`, { reason: 'test' });
  });
  it('a rejected change never touches the salary', async () => {
    const c = await officer.post(`${C}/changes`, { employeeId: E.rej, changeType: 'SALARY_CORRECTION', newSalary: 6250, effectiveDate: '2027-02-01', reason: 'Correction of entry error', submit: true });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const res = await approveAll(c.body.id, 'REJECTED');
    expect(res.change.status).toBe('REJECTED');
    expect(await salaryOf(E.rej!)).toBe(6000);
    expect(res.change.approvals.at(-1)).toMatchObject({ action: 'REJECT', newStatus: 'REJECTED', role: 'HR_MANAGER' });
  });
  it('override beyond the policy maximum needs compensation:override + justification', async () => {
    expect((await officer.post(`${C}/changes`, { employeeId: E.rej, changeType: 'SPECIAL_ADJUSTMENT', increasePct: 30, effectiveDate: '2027-02-01', reason: 'Special', ceilingAction: 'CAP_AT_MAX' })).status).toBe(403);
    const r = await hrm.post(`${C}/changes`, { employeeId: E.rej, changeType: 'SPECIAL_ADJUSTMENT', increasePct: 30, effectiveDate: '2027-02-01', reason: 'Special', ceilingAction: 'CAP_AT_MAX', justification: 'Board decision' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ isOverride: true, newSalary: 7800, status: 'DRAFT' });
    await hrm.post(`${C}/changes/${r.body.id}/cancel`, { reason: 'test' });
  });
});

describe('promotion', () => {
  it('recommends the salary from the configured rule and the target band, then applies grade + salary on approval', async () => {
    const calc = await officer.post(`${C}/promotions/calculate`, { employeeId: E.promo, newGradeId: g5, effectiveDate: '2027-03-01' });
    expect(calc.status, JSON.stringify(calc.body)).toBe(200);
    expect(calc.body.recommendedSalary).toBe(6600); // greater of +10% or the G5 minimum (6,000)
    expect(calc.body.explanation).toMatch(/Greater of 10%/);
    const lower = await officer.post(`${C}/promotions`, { employeeId: E.promo, newGradeId: g5, newSalary: 5800, effectiveDate: '2027-03-01', promotionReason: 'Test lower' });
    expect(lower.status, JSON.stringify(lower.body)).toBe(403); // lower than current salary needs override
    const p = await officer.post(`${C}/promotions`, { employeeId: E.promo, newGradeId: g5, effectiveDate: '2027-03-01', promotionReason: 'Consistently exceeds expectations', managerRecommendation: 'Strongly recommended', submit: true });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ status: 'SUBMITTED', currentSalary: 6000, newSalary: 6600, newGrade: 'G5', currentGrade: 'TG4' });
    const res = await approveAll(p.body.salaryChangeId);
    expect(res.steps).toEqual(['hr_manager', 'department_manager', 'finance', 'management']);
    const done = await officer.get(`${C}/promotions/${p.body.id}`);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.approvals.map((a: any) => a.newStatus)).toEqual(['DRAFT', 'SUBMITTED', 'HR_APPROVED', 'UNDER_REVIEW', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'COMPLETED']);
    const e = await app.db.selectFrom('employees').select('grade_id').where('id', '=', E.promo!).executeTakeFirstOrThrow();
    expect(e.grade_id).toBe(g5);
    expect(await salaryOf(E.promo!)).toBe(6600);
  });
});

describe('budgets', () => {
  it('reports utilisation and blocks a change that would exceed an approved budget', async () => {
    const dept = (await app.db.selectFrom('employees').select('department_id').where('id', '=', E.dup!).executeTakeFirstOrThrow()).department_id!;
    const b = await fin.post(`${C}/budgets`, { name: 'Test dept adjustments', fiscalYear: 2027, budgetType: 'ADJUSTMENT', scopeType: 'DEPARTMENT', scopeId: dept, amount: 1000 });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const c = await officer.post(`${C}/changes`, { employeeId: E.dup, changeType: 'MARKET_ADJUSTMENT', increaseAmount: 500, effectiveDate: '2027-04-01', reason: 'Market' });
    expect(c.status).toBe(201);
    expect(c.body.alerts.map((a: any) => a.code)).toContain('BUDGET_EXCEEDED');
    const s = await officer.post(`${C}/changes/${c.body.id}/submit`, {});
    expect(s.status).toBe(422);
    expect(s.body.error.code).toBe('BUDGET_EXCEEDED');
    await officer.post(`${C}/changes/${c.body.id}/cancel`, { reason: 'over budget' });
    const list = await officer.get(`${C}/budgets?year=2027`);
    const annual = list.body.find((x: any) => x.budgetType === 'ANNUAL' && x.scopeType === 'COMPANY');
    expect(annual.usage.approvedCost).toBeGreaterThan(0);
    expect(annual.usage.remaining).toBe(annual.usage.allocated - annual.usage.proposedCost);
    expect((await fin.put(`${C}/budgets/${b.body.id}`, { status: 'CLOSED', reason: 'test done' })).status).toBe(200);
  });
});

describe('annual salary review cycle', () => {
  let reviewId: string;
  it('identifies eligible employees, recommends increases and flags ceiling decisions', async () => {
    const r = await officer.post(`${C}/reviews`, { name: '2027 Annual Salary Review (test)', year: 2027, effectiveDate: '2027-01-01', reviewPeriodStart: '2026-01-01', reviewPeriodEnd: '2026-12-31', defaultPercentage: 5, maxPercentage: 8, budgetAmount: 100000, eligibilityRules: { gradeIds: [gradeId], minServiceMonths: 12 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    reviewId = r.body.id;
    const items = (await officer.get(`${C}/reviews/${reviewId}/items?pageSize=100`)).body.data as any[];
    const by = (id: string) => items.find((i) => i.employee.id === id);
    expect(by(E.low!).status).toBe('INELIGIBLE');
    expect(by(E.low!).ineligibilityReasons).toContain('Annual increase already processed for 2027');
    expect(by(E.rev!)).toMatchObject({ status: 'PROPOSED', proposedPct: 5, finalSalary: 6300 });
    expect(by(E.rev2!)).toMatchObject({ outcome: 'ACTION_REQUIRED', exceedsMaxBy: 295 });
    const sub = await officer.post(`${C}/reviews/${reviewId}/submit`);
    expect(sub.status).toBe(422);
    expect(sub.body.error.message).toMatch(/exceed the salary band maximum without a decision/);
    // beyond the review maximum: officer refused, HR manager with justification allowed
    expect((await officer.patch(`${C}/reviews/${reviewId}/items`, { items: [{ id: by(E.rev!).id, percentage: 9 }] })).status).toBe(403);
    expect((await hrm.patch(`${C}/reviews/${reviewId}/items`, { items: [{ id: by(E.rev!).id, percentage: 9, justification: 'Top performer' }] })).status).toBe(200);
    const bulk = await officer.post(`${C}/reviews/${reviewId}/bulk-ceiling`, { ceilingAction: 'CAP_AT_MAX' });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    expect(bulk.body.summary.actionRequired).toBe(0);
    const others = items.filter((i) => ![E.rev, E.rev2].includes(i.employee.id) && i.status === 'PROPOSED').map((i) => ({ id: i.id, status: 'EXCLUDED' }));
    if (others.length) await officer.patch(`${C}/reviews/${reviewId}/items`, { items: others });
  });
  it('is approved as a whole (HR → Finance → Management) and completes every item atomically', async () => {
    const sub = await officer.post(`${C}/reviews/${reviewId}/submit`);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('SUBMITTED');
    for (const [c, status] of [[hrm, 'HR_APPROVED'], [fin, 'FINANCE_APPROVED'], [mgmt, 'COMPLETED']] as const) {
      const d = await c.post(`${C}/reviews/${reviewId}/approve`, { decision: 'APPROVED', comment: 'ok' });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(d.body.status).toBe(status);
    }
    expect(await salaryOf(E.rev!)).toBe(6540);  // 9% override
    expect(await salaryOf(E.rev2!)).toBe(8000); // capped at the maximum
    const ch = await officer.get(`${C}/changes?reviewId=${reviewId}`);
    expect(ch.body.data.every((x: any) => x.status === 'COMPLETED' && x.source === 'REVIEW' && x.changeType === 'ANNUAL_INCREMENT')).toBe(true);
    const r = await officer.get(`${C}/reviews/${reviewId}`);
    expect(r.body.approvals.map((a: any) => a.newStatus)).toEqual(['DRAFT', 'SUBMITTED', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'COMPLETED']);
    // duplicate protection now covers these employees too
    expect((await officer.post(`${C}/increments`, { employeeId: E.rev, increasePct: 2, effectiveDate: '2027-05-01', reason: 'again' })).status).toBe(409);
  });
  it('a cancelled review releases its employees and changes nothing', async () => {
    const r = await officer.post(`${C}/reviews`, { name: '2028 review (cancel test)', year: 2028, effectiveDate: '2028-01-01', defaultPercentage: 4, eligibilityRules: { gradeIds: [gradeId] } });
    expect(r.status).toBe(201);
    const c = await officer.post(`${C}/reviews/${r.body.id}/cancel`, { reason: 'Superseded' });
    expect(c.body.status).toBe('CANCELLED');
    expect(c.body.summary.proposed).toBe(0);
  });
});

describe('scenario planning', () => {
  it('compares scenarios without changing salaries and converts one into a draft review', async () => {
    const before = await salaryOf(E.dup!);
    const a = await officer.post(`${C}/scenarios`, { name: 'A: 10% for everyone', fiscalYear: 2028, method: 'FLAT_PERCENT', config: { flatPct: 10, ceilingAction: 'CAP_AT_MAX' }, filters: { gradeIds: [gradeId] } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.summary.included).toBeGreaterThan(0);
    expect(a.body.summary.proposedPayroll).toBeGreaterThan(a.body.summary.currentPayroll);
    const b = await officer.post(`${C}/scenarios`, { name: 'D: budget limited', fiscalYear: 2028, method: 'BUDGET_LIMITED', config: { flatPct: 10, budgetLimit: 5000, ceilingAction: 'CAP_AT_MAX' }, filters: { gradeIds: [gradeId] } });
    expect(b.body.summary.annualIncrease).toBeLessThanOrEqual(5000);
    const m = await officer.post(`${C}/scenarios`, { name: 'B: merit', fiscalYear: 2028, method: 'MERIT_MATRIX', config: { ceilingAction: 'REQUEST_EXCEPTION' }, filters: { gradeIds: [gradeId] } });
    expect(m.status).toBe(201);
    const cmp = await officer.get(`${C}/scenarios/compare?ids=${a.body.id},${b.body.id},${m.body.id}`);
    expect(cmp.body).toHaveLength(3);
    expect(await salaryOf(E.dup!)).toBe(before);
    const conv = await officer.post(`${C}/scenarios/${a.body.id}/convert`, { reviewName: '2028 review from scenario A', effectiveDate: '2028-01-01' });
    expect(conv.status, JSON.stringify(conv.body)).toBe(200);
    const rv = await officer.get(`${C}/reviews/${conv.body.reviewId}`);
    expect(rv.body.status).toBe('DRAFT');
    expect(rv.body.summary.proposed).toBeGreaterThan(0);
  });
});

describe('dashboard, analysis, alerts, reports, audit', () => {
  it('dashboard cards and charts', async () => {
    const d = await mgmt.get(`${C}/dashboard?year=2027`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.cards.totalEmployees).toBeGreaterThan(100);
    expect(d.body.cards.totalPayroll).toBeGreaterThan(0);
    expect(d.body.cards.approvedIncreaseCost).toBeGreaterThan(0);
    expect(d.body.statusCounts.length).toBeGreaterThan(1);
    expect(d.body.byGrade.find((g: any) => g.name === 'TG4')).toBeTruthy();
    expect(d.body.aboveMaximum.length).toBeGreaterThan(0);
    expect(d.body.alerts.aboveMax).toBeGreaterThan(0);
    expect(d.body.payrollGrowth).toHaveLength(12);
  });
  it('department analysis', async () => {
    const a = await mgmt.get(`${C}/analysis?groupBy=grade&year=2027`);
    expect(a.status).toBe(200);
    const tg = a.body.find((x: any) => x.group === 'TG4');
    expect(tg.employees).toBeGreaterThan(3);
    expect(tg.annualIncreaseCost).toBeGreaterThan(0);
    expect((await self.get(`${C}/analysis`)).status).toBe(403);
  });
  it('alert scan finds ceiling / missing-structure conditions and resolves stale ones', async () => {
    const s = await officer.post(`${C}/alerts/scan`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const al = await officer.get(`${C}/alerts?pageSize=200&employeeId=${E.near}`);
    expect(al.body.data.map((x: any) => x.type)).toContain('ABOVE_MAX');
    expect(al.body.counts.ABOVE_MAX).toBeGreaterThan(0);
    const hrView = await hr.get(`${C}/alerts?type=ABOVE_MAX`);
    expect(hrView.body.data[0].message).not.toMatch(/AED \d/); // amounts masked without salary:read
    await app.db.updateTable('salary_alerts').set({ fingerprint: 'STALE:test' }).where('employee_id', '=', E.near!).where('alert_type', '=', 'ABOVE_MAX').execute();
    const s2 = await officer.post(`${C}/alerts/scan`);
    expect(s2.body.resolved).toBeGreaterThanOrEqual(1);
  });
  it('compression detection', async () => {
    const r = await mgmt.get(`${C}/compression`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
  it('exports reports as CSV and keeps salary reports restricted', async () => {
    const list = await fin.get(`${C}/reports`);
    expect(list.body).toHaveLength(12);
    const csv = await app.inject({ method: 'GET', url: `${C}/reports/salary-register?format=csv`, headers: { authorization: (await (async () => { const r = await app.inject({ method: 'POST', url: '/api/v1/auth/local/login', payload: { email: 'finance@burtplace.local', password: 'Password123!' } }); return `Bearer ${r.json().accessToken}`; })()) } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toMatch(/employee_no,name,department/);
    for (const k of ['annual-increments', 'promotions', 'salary-bands', 'above-maximum', 'below-minimum', 'salary-ceiling', 'budgets', 'department-analysis', 'salary-history', 'pending-approvals', 'change-audit']) {
      const r = await fin.get(`${C}/reports/${k}?year=2027`);
      expect(r.status, `${k}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    expect((await fin.get(`${C}/reports/annual-increments?year=2027`)).body.count).toBeGreaterThanOrEqual(3);
    expect((await it_.get(`${C}/reports/salary-register`)).status).toBe(403);
  });
  it('policy thresholds are configurable and versioned', async () => {
    const cur = (await hrm.get(`${C}/settings/policy`)).body;
    const bad = await hrm.put(`${C}/settings/policy`, { value: { ...cur.value, statusThresholds: { ...cur.value.statusThresholds, ranges: [{ code: 'A', label: 'A', color: 'GREEN', fromPct: 0, toPct: 50 }] } }, reason: 'test' });
    expect(bad.status).toBe(400);
    const ok = await hrm.put(`${C}/settings/policy`, { value: { ...cur.value, reviewDueMonths: 18 }, reason: 'test' });
    expect(ok.body.version).toBe(cur.version + 1);
    await hrm.put(`${C}/settings/policy`, { value: cur.value, reason: 'restore' });
    const hist = await hrm.get(`${C}/settings/policy/history`);
    expect(hist.body.length).toBeGreaterThanOrEqual(2);
    expect((await officer.put(`${C}/settings/policy`, { value: cur.value, reason: 'x' })).status).toBe(403);
  });
  it('never auto-approves: submission is refused when no approval chain is configured', async () => {
    await app.db.updateTable('workflow_definitions').set({ is_active: false }).where('code', '=', 'COMP_SALARY_CORRECTION').execute();
    const c = await officer.post(`${C}/changes`, { employeeId: E.dup, changeType: 'SALARY_CORRECTION', newSalary: 5250, effectiveDate: '2027-05-01', reason: 'Fix', submit: true });
    expect(c.status).toBe(422);
    expect(c.body.error.message).toMatch(/cannot be auto-approved/);
    await app.db.updateTable('workflow_definitions').set({ is_active: true }).where('code', '=', 'COMP_SALARY_CORRECTION').execute();
    const drafts = await app.db.selectFrom('salary_changes').select('id').where('employee_id', '=', E.dup!).where('status', '=', 'DRAFT').execute();
    for (const d of drafts) await officer.post(`${C}/changes/${d.id}/cancel`, { reason: 'cleanup' });
  });
});
