'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Calculator } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, StatTile, TableSkeleton } from '@/components/ui';
import { fmtMinutes, fmtMoney, humanStatus, monthName } from '@/lib/format';

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <AppShell><Run id={id} /></AppShell>; }
const STEPS = ['DRAFT', 'HR_REVIEW', 'FINANCE_REVIEW', 'MANAGEMENT_APPROVAL', 'APPROVED', 'LOCKED', 'BANK_WPS', 'PAID', 'CLOSED'];

function Run({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const run = useQuery({ queryKey: ['payroll', 'run', id], queryFn: () => api<any>(`/api/v1/payroll/runs/${id}`) });
  const [f, setF] = useState({ q: '', exceptionsOnly: false, page: 1 });
  const emps = useQuery({ queryKey: ['payroll', 'run', id, 'employees', f], queryFn: () => api<Paginated<any>>(`/api/v1/payroll/runs/${id}/employees${qs({ ...f, exceptionsOnly: f.exceptionsOnly || undefined, pageSize: 50 })}`), placeholderData: (p) => p });
  const calc = useMutation({ mutationFn: () => api<any>(`/api/v1/payroll/runs/${id}/calculate`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll'] }) });
  const [transition, setTransition] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const move = useMutation({ mutationFn: () => api(`/api/v1/payroll/runs/${id}/transition`, { method: 'POST', json: { to: transition, note: note || undefined } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll'] }); setTransition(null); setNote(''); } });
  const r = run.data;
  if (!r) return <TableSkeleton />;
  const idx = STEPS.indexOf(r.status === 'CALCULATING' ? 'HR_REVIEW' : r.status);
  return (
    <>
      <PageHeader breadcrumb={<Link href="/payroll" className="hover:underline">Payroll</Link>} title={<span className="flex items-center gap-3">{r.code} <Badge status={r.status} className="text-xs" /></span>} subtitle={`${monthName(r.month)} ${r.year} · ${r.periodStart} → ${r.periodEnd}`}
        actions={<>{['DRAFT', 'CALCULATING', 'HR_REVIEW'].includes(r.status) && can('payroll:run') && <button className="btn-secondary" disabled={calc.isPending} onClick={() => calc.mutate()}><Calculator size={15} />{calc.isPending ? 'Calculating…' : 'Calculate'}</button>}{['LOCKED', 'BANK_WPS', 'PAID', 'CLOSED'].includes(r.status) && can('payroll:pay') && <button className="btn-secondary" onClick={() => api<string>(`/api/v1/payroll/runs/${id}/bank-file`, { raw: true }).then((csv) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${r.code}-bank.csv`; a.click(); })}><Download size={15} />Bank file</button>}{r.allowedTransitions.map((t: string) => <button key={t} className="btn-primary" onClick={() => setTransition(t)}>→ {humanStatus(t)}</button>)}</>} />
      <div className="card mb-6 flex items-center gap-1 overflow-x-auto p-3">{STEPS.map((s, i) => <div key={s} className="flex items-center gap-1"><span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${i < idx ? 'bg-success/10 text-success' : i === idx ? 'bg-brand text-brand-fg' : 'bg-surface-2 text-muted'}`}>{humanStatus(s)}</span>{i < STEPS.length - 1 && <span className="text-muted">›</span>}</div>)}</div>
      {calc.data && <div className="mb-4"><Alert tone="success">Calculated {calc.data.employees} employees · net {fmtMoney(calc.data.totals.net)} · {calc.data.exceptions} with exceptions</Alert></div>}
      {calc.error && <div className="mb-4"><Alert tone="danger">{(calc.error as Error).message}</Alert></div>}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Employees" value={r.employeeCount} /><StatTile label="Gross (fixed pay)" value={fmtMoney(r.totalGross, r.currency)} /><StatTile label="Total earnings" value={fmtMoney(r.totalEarnings, r.currency)} tone="success" /><StatTile label="Deductions" value={fmtMoney(r.totalDeductions, r.currency)} tone="danger" hint={<b className="text-fg">Net {fmtMoney(r.totalNet, r.currency)}</b>} /></div>
      <Card title="Payroll register" padded={false} actions={<><input className="input h-8 w-48 text-xs" placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} /><label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={f.exceptionsOnly} onChange={(e) => setF({ ...f, exceptionsOnly: e.target.checked, page: 1 })} />Exceptions only</label></>}>
        {emps.isLoading ? <TableSkeleton /> : emps.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Department</th><th>Project</th><th>Gross</th><th>Paid days</th><th>Absent</th><th>Unpaid</th><th>OT</th><th>Earnings</th><th>Deductions</th><th>Net</th><th>Flags</th></tr></thead><tbody>{emps.data.data.map((e) => <tr key={e.id} className={e.hasExceptions ? 'bg-warning/5' : ''}><td><Link href={`/payroll/employees/${e.id}`} className="font-medium hover:underline">{e.employeeNo} · {e.employeeName}</Link></td><td className="text-muted">{e.departmentName ?? '—'}</td><td className="text-muted">{e.projectCode ?? '—'}</td><td>{fmtMoney(e.grossSalary)}</td><td>{e.paidDays}</td><td className={e.absentDays ? 'text-danger' : ''}>{e.absentDays}</td><td>{e.unpaidLeaveDays}</td><td>{fmtMinutes(e.overtimeMinutes)}</td><td>{fmtMoney(e.totalEarnings)}</td><td className="text-danger">{fmtMoney(e.totalDeductions)}</td><td className="font-semibold">{fmtMoney(e.netSalary)}</td><td className="max-w-xs"><div className="flex flex-wrap gap-1">{e.exceptions.map((x: string) => <Badge key={x} status="MEDIUM" className="max-w-[14rem] truncate" >{x}</Badge>)}</div></td></tr>)}</tbody></table></div> : <EmptyState title="Not calculated yet" hint="Run the calculation to build the register from timesheets and salary structures." />}
        {emps.data && <Pagination page={emps.data.meta.page} totalPages={emps.data.meta.totalPages} total={emps.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
      <Modal open={!!transition} onClose={() => setTransition(null)} title={`Move run to ${humanStatus(transition)}`}><div className="space-y-3">{transition === 'LOCKED' && <Alert tone="warning">Locking freezes every timesheet and attendance day in this run. Further changes require adjustment requests.</Alert>}<Field label="Note"><textarea className="input h-20 py-2" value={note} onChange={(e) => setNote(e.target.value)} /></Field>{move.error && <Alert tone="danger">{(move.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setTransition(null)}>Cancel</button><button className="btn-primary" disabled={move.isPending} onClick={() => move.mutate()}>Confirm</button></div></div></Modal>
    </>
  );
}
