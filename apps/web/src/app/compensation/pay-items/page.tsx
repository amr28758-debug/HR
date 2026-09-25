'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronRight } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { CompNav } from '@/components/compensation/common';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, StatTile, Tabs, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMoney, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Compensation /></AppShell>; }
type Tab = 'loans' | 'bonuses' | 'deductions';

function Compensation() {
  const { can } = useAuth();
  const sp = useSearchParams();
  const [tab, setTab] = useState<Tab>((sp.get('tab') as Tab) ?? 'loans');
  const tabs = [{ key: 'loans' as Tab, label: 'Loans & advances' }, { key: 'bonuses' as Tab, label: 'Bonuses' }, { key: 'deductions' as Tab, label: 'Deductions' }];
  return (
    <>
      <PageHeader eyebrow="Compensation" title={can('compensation:read') ? 'Loans, bonuses & deductions' : 'My compensation'} subtitle={can('compensation:read') ? 'Loans, advances, bonuses and deductions feeding payroll. New items are raised per employee from the profile Actions menu and flow through approval.' : 'Your loans, bonuses and deductions. Raise a loan or advance from your profile.'} actions={<Link href="/requests?new=1" className="btn-secondary"><Plus size={15} />New request</Link>} />
      {can('compensation:read') && <CompNav />}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'loans' && <Loans canWrite={can('compensation:write')} />}
      {tab === 'bonuses' && <SimpleList kind="bonuses" canWrite={can('compensation:write')} />}
      {tab === 'deductions' && <SimpleList kind="deductions" canWrite={can('compensation:write')} />}
    </>
  );
}

function Loans({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ status: '', loanType: '', page: 1 });
  const q = useQuery({ queryKey: ['loans', f], queryFn: () => api<Paginated<any>>(`/api/v1/compensation/loans${qs({ ...f, pageSize: 25 })}`) });
  const [edit, setEdit] = useState<any | null>(null);
  const m = useMutation({ mutationFn: () => api(`/api/v1/compensation/loans/${edit.id}`, { method: 'PATCH', json: { status: edit.status || undefined, installment: edit.installment ? Number(edit.installment) : undefined, reason: edit.reason } }), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['loans'] }); } });
  const rows = q.data?.data ?? [];
  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-3"><StatTile label="Active loans" value={rows.filter((l) => l.status === 'ACTIVE').length} /><StatTile label="Outstanding" value={fmtMoney(rows.filter((l) => l.status === 'ACTIVE').reduce((s, l) => s + l.outstanding, 0))} tone="accent" /><StatTile label="Paused" value={rows.filter((l) => l.status === 'PAUSED').length} tone="warning" /></div>
      <Card padded={false} title="Loans & advances" actions={<><select className="input sm:w-36" value={f.loanType} onChange={(e) => setF({ ...f, loanType: e.target.value, page: 1 })}><option value="">Loans & advances</option><option value="LOAN">Loans</option><option value="ADVANCE">Advances</option></select><select className="input sm:w-36" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['ACTIVE', 'PAUSED', 'CLOSED'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select></>}>
        {q.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Type</th><th>Principal</th><th>Instalment</th><th>Outstanding</th><th>Schedule</th><th>Status</th><th></th></tr></thead><tbody>{rows.map((l) => <tr key={l.id}><td><Link href={`/employees/${l.employee.id}?tab=compensation`} className="font-medium hover:underline">{l.employee.name}</Link><span className="block text-[11px] text-muted">{l.employee.employeeNo}</span></td><td>{humanStatus(l.loanType)}<span className="block max-w-[200px] truncate text-[11px] text-muted">{l.reason}</span></td><td className="tabular-nums">{fmtMoney(l.principal)}</td><td className="tabular-nums">{fmtMoney(l.installment)}</td><td className="tabular-nums font-semibold">{fmtMoney(l.outstanding)}</td><td className="text-xs">{l.startPeriod} → {l.endPeriod ?? '…'}<span className="block text-muted">{l.installments.filter((i: any) => i.status === 'DEDUCTED').length}/{l.installments.length} deducted</span></td><td><Badge status={l.status} /></td><td>{canWrite && l.status !== 'CLOSED' && <button className="btn-ghost btn-sm" onClick={() => setEdit({ id: l.id, status: l.status, installment: '', reason: '' })}>Manage</button>}</td></tr>)}</tbody></table></div> : <EmptyState hint="Loans are raised from the employee profile (Actions → Loan / Salary advance)." />}
        {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Manage loan">{edit && <div className="space-y-3"><Field label="Status"><select className="input" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{['ACTIVE', 'PAUSED', 'CLOSED'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select></Field><Field label="New monthly instalment (reschedules remaining)"><input type="number" className="input" value={edit.installment} onChange={(e) => setEdit({ ...edit, installment: e.target.value })} /></Field><Field label="Reason"><input className="input" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field><div className="flex justify-end"><button className="btn-primary" disabled={!edit.reason} onClick={() => m.mutate()}>Save</button></div></div>}</Modal>
    </>
  );
}

function SimpleList({ kind, canWrite }: { kind: 'bonuses' | 'deductions'; canWrite: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ status: '', page: 1 });
  const q = useQuery({ queryKey: [kind, f], queryFn: () => api<Paginated<any>>(`/api/v1/compensation/${kind}${qs({ ...f, pageSize: 25 })}`) });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/api/v1/compensation/${kind}/${id}/cancel`, { method: 'POST', json: { reason: 'Cancelled from compensation center' } }), onSuccess: () => qc.invalidateQueries({ queryKey: [kind] }) });
  const rows = q.data?.data ?? [];
  return (
    <Card padded={false} title={kind === 'bonuses' ? 'Bonuses' : 'Deductions'} subtitle="Approved items are picked up by the payroll run of their period and marked APPLIED on lock" actions={<select className="input sm:w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['PENDING', 'APPROVED', 'APPLIED', 'CANCELLED'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select>}>
      {q.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>{kind === 'bonuses' ? 'Type' : 'Component'}</th><th>Amount</th><th>Period</th><th>Reason</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>{rows.map((x) => <tr key={x.id}><td><Link href={`/employees/${x.employee.id}?tab=compensation`} className="font-medium hover:underline">{x.employee.name}</Link><span className="block text-[11px] text-muted">{x.employee.employeeNo}</span></td><td>{humanStatus(kind === 'bonuses' ? x.bonusType : x.componentCode)}{kind === 'bonuses' && x.isRecurring && <span className="block text-[11px] text-muted">recurring · {x.recurringMonths} months</span>}{kind === 'deductions' && <span className="block text-[11px] text-muted">{humanStatus(x.source)}</span>}</td><td className="tabular-nums font-semibold">{x.amount !== null && x.amount !== undefined ? fmtMoney(x.amount) : `${x.percentage}% of basic`}</td><td>{x.period}</td><td className="max-w-xs truncate text-muted">{x.reason}</td><td><Badge status={x.status} /></td><td className="text-xs text-muted">{fmtDateTime(x.createdAt)}</td><td>{canWrite && ['PENDING', 'APPROVED'].includes(x.status) && <button className="btn-ghost btn-sm" onClick={() => { if (confirm('Cancel this item?')) cancel.mutate(x.id); }}>Cancel</button>}{x.hrRequestId && <Link href={`/requests/${x.hrRequestId}`} className="btn-ghost btn-sm"><ChevronRight size={14} /></Link>}</td></tr>)}</tbody></table></div> : <EmptyState hint="Raise items from the employee profile Actions menu." />}
      {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
    </Card>
  );
}
