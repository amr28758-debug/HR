import { buildApp } from '../src/app.js';
const app = await buildApp({ logger: false, enableQueues: false });
await app.ready();
const j = async (method: string, url: string, body?: unknown, token?: string, apiKey?: string) => {
  const res = await app.inject({ method: method as any, url, payload: body, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(apiKey && { 'x-api-key': apiKey }) } });
  let parsed: any; try { parsed = res.json(); } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
};
const login = await j('POST', '/api/v1/auth/local/login', { email: 'admin@burtplace.local', password: 'Password123!' });
console.log('login', login.status);
const T = login.body.accessToken;
console.log('me', (await j('GET', '/api/v1/auth/me', undefined, T)).body.roles);
const emps = await j('GET', '/api/v1/employees?pageSize=3&q=BP-26-021', undefined, T);
console.log('employees', emps.status, emps.body.meta, emps.body.data?.[0]?.employeeNo, emps.body.data?.[0]?.site?.name);
const emp = emps.body.data[0];
const byNo = await j('GET', '/api/v1/employees/by-number/BP-26-021', undefined, T);
console.log('by-number', byNo.status, byNo.body.fullNameEn, byNo.body.allowedTransitions);
// Create API key for the gateway service account
const svc = await app.db.selectFrom('users').select('id').where('email', '=', 'svc.device-gateway@burtplace.local').executeTakeFirstOrThrow();
const key = await j('POST', '/api/v1/auth/api-keys', { userId: svc.id, name: 'test gateway' }, T);
console.log('api key', key.status);
// Ingest a week of punches for BP-26-021 (matrix user id 21) at ARGO-C31-01, Mon 7 Sep → Sat 12 Sep 2026 (Fri off)
const events: any[] = [];
for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-12']) {
  events.push({ userId: '21', deviceCode: 'ARGO-C31-01', timestamp: `${d}T06:${d === '2026-09-09' ? '35' : '02'}:00+04:00` });
  events.push({ userId: '21', deviceCode: 'ARGO-C31-01', timestamp: `${d}T${d === '2026-09-10' ? '19:10' : '17:03'}:00+04:00` });
}
events.push({ userId: '21', deviceCode: 'ARGO-C31-01', timestamp: '2026-09-11T07:00:00+04:00' }); // Friday (week off) OT
events.push({ userId: '21', deviceCode: 'ARGO-C31-01', timestamp: '2026-09-11T12:10:00+04:00' });
events.push({ userId: '9999', deviceCode: 'ARGO-C31-01', timestamp: '2026-09-07T06:00:00+04:00' }); // unmapped
const ing = await j('POST', '/api/v1/attendance/events', events, undefined, key.body.apiKey);
console.log('ingest', ing.status, ing.body);
const ing2 = await j('POST', '/api/v1/attendance/events', events, undefined, key.body.apiKey);
console.log('ingest again (dupes)', ing2.body.inserted, ing2.body.duplicates);
const daily = await j('GET', `/api/v1/attendance/daily?employeeId=${emp.id}&from=2026-09-07&to=2026-09-13&order=asc&pageSize=10`, undefined, T);
console.log('daily', daily.status, daily.body.data?.map((d: any) => `${d.date} ${d.status} w=${d.workedMinutes} late=${d.lateMinutes} ot=${d.overtimeMinutes}`).join('\n  '));
const ex = await j('GET', '/api/v1/attendance/exceptions?pageSize=50', undefined, T);
console.log('exceptions', ex.status, ex.body.data?.map((x: any) => `${x.date} ${x.type} ${x.employeeNo ?? x.details?.externalUserId}`).join(', '));
// Process the whole month for this employee (absences for other days)
const proc = await j('POST', '/api/v1/attendance/process', { from: '2026-09-01', to: '2026-09-13', employeeIds: [emp.id] }, T);
console.log('process', proc.status, proc.body);
// OT request for Thursday & approve as manager fallback (HR)
const ot = await j('POST', '/api/v1/overtime/requests', { employeeId: emp.id, date: '2026-09-10' }, T);
console.log('ot request', ot.status, ot.body.requestedMinutes, ot.body.status, ot.body.workflowInstanceId);
const tasks = await j('GET', '/api/v1/workflows/tasks/mine?all=true', undefined, T);
console.log('my tasks', tasks.status, tasks.body.data?.map((t: any) => `${t.workflowCode}/${t.stepKey}`));
for (const t of tasks.body.data ?? []) { const d = await j('POST', `/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' }, T); console.log('decide', d.status, d.body); }
const tasks2 = await j('GET', '/api/v1/workflows/tasks/mine?all=true', undefined, T);
for (const t of tasks2.body.data ?? []) { const d = await j('POST', `/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' }, T); console.log('decide2', d.status, d.body); }
// Leave request for 8 Sep (annual) as HR
const lv = await j('POST', '/api/v1/leave/requests', { employeeId: emp.id, leaveTypeCode: 'ANNUAL', startDate: '2026-09-08', endDate: '2026-09-08', reason: 'test' }, T);
console.log('leave', lv.status, lv.body.totalDays ?? lv.body);
const tasks3 = await j('GET', '/api/v1/workflows/tasks/mine?all=true', undefined, T);
for (const t of tasks3.body.data ?? []) { await j('POST', `/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' }, T); }
const tasks4 = await j('GET', '/api/v1/workflows/tasks/mine?all=true', undefined, T);
for (const t of tasks4.body.data ?? []) { await j('POST', `/api/v1/workflows/tasks/${t.id}/decide`, { decision: 'APPROVED' }, T); }
// timesheet
const gen = await j('POST', '/api/v1/timesheets/generate', { year: 2026, month: 9, employeeIds: [emp.id] }, T);
console.log('timesheet gen', gen.status, gen.body);
const ts = await j('GET', `/api/v1/timesheets?year=2026&month=9&employeeId=${emp.id}`, undefined, T);
const t0 = ts.body.data[0];
console.log('timesheet', ts.status, { present: t0.presentDays, absent: t0.absentDays, leave: t0.paidLeaveDays, ot: t0.overtimeMinutes, weekendOt: t0.weekendOtMinutes, late: t0.lateMinutes, unapproved: t0.unapprovedOvertimeMinutes });
// payroll
const run = await j('POST', '/api/v1/payroll/runs', { year: 2026, month: 9, filters: { siteIds: [emp.site.id] } }, T);
console.log('run', run.status, run.body.code ?? run.body);
const calc = await j('POST', `/api/v1/payroll/runs/${run.body.id}/calculate`, undefined, T);
console.log('calc', calc.status, calc.body);
const reg = await j('GET', `/api/v1/payroll/runs/${run.body.id}/employees?q=BP-26-021`, undefined, T);
const pe = reg.body.data[0];
console.log('register row', reg.status, { gross: pe.grossSalary, earnings: pe.totalEarnings, ded: pe.totalDeductions, net: pe.netSalary, ex: pe.exceptions });
const det = await j('GET', `/api/v1/payroll/employees/${pe.id}`, undefined, T);
console.log('lines', det.body.earnings?.map((l: any) => `${l.componentCode}=${l.amount}`).join(' '), '|', det.body.deductions?.map((l: any) => `${l.componentCode}=${l.amount}`).join(' '));
for (const to of ['FINANCE_REVIEW', 'MANAGEMENT_APPROVAL', 'APPROVED', 'LOCKED']) { const tr = await j('POST', `/api/v1/payroll/runs/${run.body.id}/transition`, { to, note: 'ack' }, T); console.log('transition', to, tr.status, tr.body.status ?? tr.body); }
const bank = await j('GET', `/api/v1/payroll/runs/${run.body.id}/bank-file`, undefined, T);
console.log('bank file', bank.status, String(bank.body).split('\n').length, 'lines');
console.log('dash exec', (await j('GET', '/api/v1/dashboards/executive?date=2026-09-10', undefined, T)).status);
console.log('dash hr', (await j('GET', '/api/v1/dashboards/hr', undefined, T)).status);
console.log('dash payroll', (await j('GET', '/api/v1/dashboards/payroll', undefined, T)).status);
console.log('devices health', (await j('GET', '/api/v1/devices/health', undefined, T)).body);
console.log('search', (await j('GET', '/api/v1/search?q=BP-26-021', undefined, T)).body?.[0]);
console.log('recon', (await j('POST', '/api/v1/attendance/reconcile', { from: '2026-09-01', to: '2026-09-13' }, T)).body.summary);
console.log('report cost', (await j('GET', `/api/v1/reports/payroll/cost?runId=${run.body.id}&groupBy=project`, undefined, T)).body.data?.[0]);
console.log('report csv', (await j('GET', `/api/v1/reports/attendance/monthly?from=2026-09-01&to=2026-09-30&format=csv`, undefined, T)).status);
console.log('audit', (await j('GET', '/api/v1/audit?pageSize=3', undefined, T)).body.data?.map((a: any) => a.action));
// RBAC: employee login sees only own
const el = await j('POST', '/api/v1/auth/local/login', { email: 'employee@burtplace.local', password: 'Password123!' });
console.log('employee list scope', (await j('GET', '/api/v1/employees', undefined, el.body.accessToken)).body.meta);
console.log('employee forbidden payroll', (await j('GET', '/api/v1/payroll/runs', undefined, el.body.accessToken)).status);
console.log('employee other profile', (await j('GET', `/api/v1/employees/${emp.id}`, undefined, el.body.accessToken)).status);
console.log('openapi paths', Object.keys(app.swagger().paths).length);
await app.close();
