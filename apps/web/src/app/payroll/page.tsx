'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Tabs } from '@/components/ui';
import { fmtDate, fmtMoney, monthName } from '@/lib/format';

export default function Page() { return <AppShell><Payroll /></AppShell>; }
function Payroll() {
  const { can } = useAuth();
  if (!can('payroll:read')) return <MyPayslips />;
  return <Runs />;
}
function Runs() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'runs' | 'policies' | 'adjustments'>('runs');
  const runs = useQuery({ queryKey: ['payroll', 'runs'], queryFn: () => api<any[]>('/api/v1/payroll/runs') });
  const policies = useQuery({ queryKey: ['payroll', 'policies'], queryFn: () => api<any[]>('/api/v1/payroll/policies'), enabled: tab === 'policies' });
  const adjustments = useQuery({ queryKey: ['payroll', 'adjustments'], queryFn: () => api<any[]>('/api/v1/payroll/adjustments'), enabled: tab === 'adjustments' });
  const [open, setOpen] = useState(false);
  const n = new Date();
  const [f, setF] = useState({ year: n.getFullYear(), month: n.getMonth() + 1 });
  const create = useMutation({ mutationFn: () => api<any>('/api/v1/payroll/runs', { method: 'POST', json: f }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll', 'runs'] }); setOpen(false); } });
  const decide = useMutation({ mutationFn: (v: { id: string; decision: string }) => api(`/api/v1/payroll/adjustments/${v.id}/decide`, { method: 'POST', json: { decision: v.decision } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll', 'adjustments'] }) });
  return (
    <>
      <PageHeader title="Payroll" subtitle="Draft → HR review → Finance review → Management approval → Approved → Locked → Bank/WPS → Paid → Closed" actions={can('payroll:run') && <button className="btn-primary" onClick={() => setOpen(true)}>New run</button>} />
      <Tabs tabs={[{ key: 'runs', label: 'Runs' }, { key: 'adjustments', label: 'Adjustments' }, { key: 'policies', label: 'Policies & formulas' }]} value={tab} onChange={setTab} />
      {tab === 'runs' && (runs.data?.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{runs.data.map((r) => <Link key={r.id} href={`/payroll/runs/${r.id}`} className="card p-5 transition hover:shadow-pop"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted">{r.code}</p><h3 className="text-lg font-semibold">{monthName(r.month)} {r.year}</h3></div><Badge status={r.status} /></div><p className="mt-4 text-3xl font-semibold tabular-nums tracking-tight">{fmtMoney(r.totalNet, r.currency)}</p><p className="text-xs text-muted">net · {r.employeeCount} employees · gross {fmtMoney(r.totalGross, r.currency)}</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand" style={{ width: `${(['DRAFT', 'CALCULATING', 'HR_REVIEW', 'FINANCE_REVIEW', 'MANAGEMENT_APPROVAL', 'APPROVED', 'LOCKED', 'BANK_WPS', 'PAID', 'CLOSED'].indexOf(r.status) + 1) * 10}%` }} /></div></Link>)}</div> : <EmptyState title="No payroll runs" hint="Create the first run for a period." />)}
      {tab === 'adjustments' && <Card padded={false}>{adjustments.data?.length ? <table className="data"><thead><tr><th>Employee</th><th>Component</th><th>Amount</th><th>Reason</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>{adjustments.data.map((a) => <tr key={a.id}><td><Link className="hover:underline" href={`/employees/${a.employeeId}`}>{a.employeeId.slice(0, 8)}…</Link></td><td>{a.componentCode}</td><td className="font-medium">{fmtMoney(a.amount)}</td><td className="text-muted">{a.reason}</td><td><Badge status={a.status} /></td><td>{fmtDate(a.createdAt)}</td><td className="text-end">{a.status === 'PENDING' && can('payroll:approve', 'payroll:review:finance') && <><button className="btn-ghost btn-sm text-success" onClick={() => decide.mutate({ id: a.id, decision: 'APPROVED' })}>Approve</button><button className="btn-ghost btn-sm text-danger" onClick={() => decide.mutate({ id: a.id, decision: 'REJECTED' })}>Reject</button></>}</td></tr>)}</tbody></table> : <EmptyState title="No adjustments" hint="After a run is locked, changes go through adjustment requests applied to the next run." />}</Card>}
      {tab === 'policies' && <div className="space-y-4">{policies.data?.map((p) => <Card key={p.id} title={<span>{p.name} <span className="ms-2 text-xs text-muted">v{p.version} · effective {fmtDate(p.effectiveFrom)}{p.effectiveTo ? ` → ${fmtDate(p.effectiveTo)}` : ''}</span></span>} actions={p.isStatutory ? <Badge status="LOCKED">Statutory</Badge> : <Badge status="PENDING">Company policy · requires HR/legal confirmation</Badge>}><div className="grid gap-4 md:grid-cols-2"><div><h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Parameters</h4><dl className="grid grid-cols-2 gap-1 text-sm"><dt className="text-muted">Rate base</dt><dd>{p.config.rateBase}</dd><dt className="text-muted">Days divisor</dt><dd>{p.config.daysInMonthDivisor}</dd><dt className="text-muted">Hours / day</dt><dd>{p.config.hoursPerDay}</dd><dt className="text-muted">OT multipliers</dt><dd>normal ×{p.config.overtime.NORMAL} · week off ×{p.config.overtime.WEEK_OFF} · holiday ×{p.config.overtime.PUBLIC_HOLIDAY}</dd><dt className="text-muted">Late grace / month</dt><dd>{p.config.lateDeduction.graceMinutesPerMonth} min</dd></dl>{p.notes && <p className="mt-3 text-xs text-warning">{p.notes}</p>}</div><div><h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Formulas</h4><ul className="space-y-1 font-mono text-xs">{Object.entries(p.config.formulas).map(([k, v]) => <li key={k}><span className="text-muted">{k}</span> = {String(v)}</li>)}</ul></div></div></Card>)}</div>}
      <Modal open={open} onClose={() => setOpen(false)} title="New payroll run"><div className="space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="Month"><select className="input" value={f.month} onChange={(e) => setF({ ...f, month: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>)}</select></Field><Field label="Year"><input type="number" className="input" value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value) })} /></Field></div>{create.error && <Alert tone="danger">{(create.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>Create</button></div></div></Modal>
    </>
  );
}
function MyPayslips() {
  const q = useQuery({ queryKey: ['my-payslips'], queryFn: () => api<any[]>('/api/v1/payroll/my-payslips') });
  return <><PageHeader title="My payslips" /><Card padded={false}>{q.data?.length ? <table className="data"><thead><tr><th>Period</th><th>Payslip</th><th>Net</th><th>Status</th><th></th></tr></thead><tbody>{q.data.map((p) => <tr key={p.payrollEmployeeId}><td className="font-medium">{monthName(p.month)} {p.year}</td><td>{p.payslipNo}</td><td>{fmtMoney(p.netSalary)}</td><td><Badge status={p.status} /></td><td className="text-end"><Link className="btn-secondary btn-sm" href={`/payroll/employees/${p.payrollEmployeeId}`}>View</Link></td></tr>)}</tbody></table> : <EmptyState title="No payslips published yet" />}</Card></>;
}
