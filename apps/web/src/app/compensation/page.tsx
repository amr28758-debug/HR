'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronRight } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, StatTile, Tabs, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMoney, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Compensation /></AppShell>; }
type Tab = 'increments' | 'loans' | 'bonuses' | 'deductions';

function Compensation() {
  const { can } = useAuth();
  const sp = useSearchParams();
  const [tab, setTab] = useState<Tab>((sp.get('tab') as Tab) ?? (can('compensation:read') ? 'increments' : 'loans'));
  const tabs = [...(can('compensation:read') ? [{ key: 'increments' as Tab, label: 'Increment cycles' }] : []), { key: 'loans' as Tab, label: 'Loans & advances' }, { key: 'bonuses' as Tab, label: 'Bonuses' }, { key: 'deductions' as Tab, label: 'Deductions' }];
  return (
    <>
      <PageHeader eyebrow="Compensation" title={can('compensation:read') ? 'Compensation center' : 'My compensation'} subtitle={can('compensation:read') ? 'Salary changes, bulk increments, loans, bonuses and deductions. New items are raised per employee from the profile Actions menu and flow through approval.' : 'Your loans, bonuses and deductions. Raise a loan or advance from your profile.'} actions={<Link href="/requests?new=1" className="btn-secondary"><Plus size={15} />New request</Link>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'increments' && <Increments canWrite={can('compensation:write')} canApply={can('salary:write')} />}
      {tab === 'loans' && <Loans canWrite={can('compensation:write')} />}
      {tab === 'bonuses' && <SimpleList kind="bonuses" canWrite={can('compensation:write')} />}
      {tab === 'deductions' && <SimpleList kind="deductions" canWrite={can('compensation:write')} />}
    </>
  );
}

function Increments({ canWrite, canApply }: { canWrite: boolean; canApply: boolean }) {
  const qc = useQueryClient();
  const cycles = useQuery({ queryKey: ['inc', 'cycles'], queryFn: () => api<any[]>('/api/v1/compensation/increment-cycles') });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['inc', 'cycle', sel], queryFn: () => api<any>(`/api/v1/compensation/increment-cycles/${sel}`), enabled: !!sel });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments') });
  const [create, setCreate] = useState<any | null>(null);
  const [edits, setEdits] = useState<Record<string, { percentage?: string; status?: string }>>({});
  const inv = () => qc.invalidateQueries({ queryKey: ['inc'] });
  const mCreate = useMutation({ mutationFn: () => api<any>('/api/v1/compensation/increment-cycles', { method: 'POST', json: { name: create.name, year: Number(create.year), effectiveDate: create.effectiveDate, defaultPercentage: Number(create.defaultPercentage), filters: { departmentIds: create.departmentId ? [create.departmentId] : undefined }, notes: create.notes || undefined } }), onSuccess: (r) => { setCreate(null); inv(); setSel(r.id); } });
  const mEdit = useMutation({ mutationFn: () => api(`/api/v1/compensation/increment-cycles/${sel}/entries`, { method: 'PATCH', json: { entries: Object.entries(edits).map(([id, e]) => ({ id, ...(e.percentage !== undefined && e.percentage !== '' && { percentage: Number(e.percentage) }), ...(e.status && { status: e.status }) })) } }), onSuccess: () => { setEdits({}); inv(); } });
  const mTrans = useMutation({ mutationFn: (to: string) => api(`/api/v1/compensation/increment-cycles/${sel}/transition`, { method: 'POST', json: { to } }), onSuccess: inv });
  const c = detail.data;
  const NEXT: Record<string, { to: string; label: string; cls: string }[]> = { DRAFT: [{ to: 'IN_REVIEW', label: 'Send for review', cls: 'btn-primary' }, { to: 'CANCELLED', label: 'Cancel', cls: 'btn-ghost' }], IN_REVIEW: [{ to: 'APPROVED', label: 'Approve', cls: 'btn-primary' }, { to: 'DRAFT', label: 'Back to draft', cls: 'btn-secondary' }], APPROVED: [{ to: 'APPLIED', label: 'Apply to salaries', cls: 'btn-accent' }, { to: 'IN_REVIEW', label: 'Reopen', cls: 'btn-secondary' }] };
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card title="Cycles" className="lg:col-span-2" padded={false} actions={canWrite && <button className="btn-primary btn-sm" onClick={() => setCreate({ name: `Annual increment ${new Date().getFullYear() + 1}`, year: new Date().getFullYear(), effectiveDate: `${new Date().getFullYear() + 1}-01-01`, defaultPercentage: 5, departmentId: '', notes: '' })}><Plus size={14} />Cycle</button>}>
        {cycles.isLoading ? <TableSkeleton /> : cycles.data?.length ? <ul>{cycles.data.map((x) => <li key={x.id}><button onClick={() => setSel(x.id)} className={cn('flex w-full items-center justify-between gap-2 border-b px-4 py-3 text-start transition hover:bg-brand-soft/40', sel === x.id && 'bg-brand-soft/60')}><span><span className="block text-sm font-semibold">{x.name}</span><span className="block text-[11px] text-muted">Effective {fmtDate(x.effectiveDate)} · {x.stats.included}/{x.stats.entries} employees · +{fmtMoney(x.stats.costIncrease)}/month</span></span><Badge status={x.status === 'APPLIED' ? 'APPROVED' : x.status === 'IN_REVIEW' ? 'PENDING' : x.status} >{humanStatus(x.status)}</Badge></button></li>)}</ul> : <EmptyState hint="Create an increment cycle to propose raises in bulk." />}
      </Card>
      <Card title={c ? c.name : 'Select a cycle'} subtitle={c ? `${humanStatus(c.status)} · effective ${fmtDate(c.effectiveDate)} · default ${c.defaultPercentage}%` : undefined} className="lg:col-span-3" padded={false} actions={c && canWrite && <>{Object.keys(edits).length > 0 && ['DRAFT', 'IN_REVIEW'].includes(c.status) && <button className="btn-secondary btn-sm" onClick={() => mEdit.mutate()}>Save {Object.keys(edits).length} edits</button>}{(NEXT[c.status] ?? []).filter((n) => !(n.to === 'APPROVED' || n.to === 'APPLIED') || canApply).map((n) => <button key={n.to} className={`${n.cls} btn-sm`} disabled={mTrans.isPending} onClick={() => { if (n.to === 'APPLIED' && !confirm(`Apply ${c.stats.included} salary changes effective ${fmtDate(c.effectiveDate)}?`)) return; mTrans.mutate(n.to); }}>{n.label}</button>)}</>}>
        {!sel ? <div className="p-5"><EmptyState title="Pick a cycle" hint="Entries, proposed percentages and cost impact appear here." /></div> : detail.isLoading ? <TableSkeleton /> : c && <>
          <div className="grid gap-px border-b bg-border sm:grid-cols-4">{[['Employees', `${c.stats.included} / ${c.stats.entries}`], ['Current gross', fmtMoney(c.stats.currentGross)], ['New gross', fmtMoney(c.stats.newGross)], ['Monthly cost +', fmtMoney(c.stats.costIncrease)]].map(([l, v]) => <div key={l} className="bg-surface px-4 py-3"><p className="text-[10px] font-bold uppercase tracking-wider text-muted">{l}</p><p className="text-lg font-bold tabular-nums">{v}</p></div>)}</div>
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Grade</th><th>Rating</th><th>Current basic</th><th>Current gross</th><th>%</th><th>New gross</th><th>Status</th></tr></thead><tbody>{c.entries.map((e: any) => { const ed = edits[e.id] ?? {}; const editable = canWrite && ['DRAFT', 'IN_REVIEW'].includes(c.status); return <tr key={e.id} className={cn((ed.status ?? e.status) === 'EXCLUDED' && 'opacity-50')}><td><Link href={`/employees/${e.employee.id}?tab=compensation`} className="font-medium hover:underline">{e.employee.name}</Link><span className="block text-[11px] text-muted">{e.employee.employeeNo} · {e.employee.designation ?? '—'}</span></td><td>{e.gradeCode ?? '—'}</td><td>{e.performanceRating ?? '—'}</td><td className="tabular-nums">{fmtMoney(e.currentBasic)}</td><td className="tabular-nums">{fmtMoney(e.currentGross)}</td><td>{editable ? <input type="number" step={0.5} className="input h-8 w-20" value={ed.percentage ?? e.proposedPercentage} onChange={(ev) => setEdits({ ...edits, [e.id]: { ...ed, percentage: ev.target.value } })} /> : `${e.proposedPercentage}%`}</td><td className="tabular-nums font-semibold">{fmtMoney(e.newGross)}</td><td>{editable ? <select className="input h-8 w-32" value={ed.status ?? e.status} onChange={(ev) => setEdits({ ...edits, [e.id]: { ...ed, status: ev.target.value } })}><option value="PROPOSED">Included</option><option value="EXCLUDED">Excluded</option></select> : <Badge status={e.status === 'APPLIED' ? 'APPROVED' : e.status === 'EXCLUDED' ? 'CANCELLED' : e.status}>{humanStatus(e.status)}</Badge>}</td></tr>; })}</tbody></table></div>
        </>}
      </Card>
      <Modal open={!!create} onClose={() => setCreate(null)} title="New increment cycle">{create && <div className="grid gap-3 sm:grid-cols-2"><Field label="Name" className="sm:col-span-2"><input className="input" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></Field><Field label="Performance year"><input type="number" className="input" value={create.year} onChange={(e) => setCreate({ ...create, year: e.target.value })} /></Field><Field label="Effective date"><input type="date" className="input" value={create.effectiveDate} onChange={(e) => setCreate({ ...create, effectiveDate: e.target.value })} /></Field><Field label="Default %"><input type="number" step={0.5} className="input" value={create.defaultPercentage} onChange={(e) => setCreate({ ...create, defaultPercentage: e.target.value })} /></Field><Field label="Department (optional filter)"><select className="input" value={create.departmentId} onChange={(e) => setCreate({ ...create, departmentId: e.target.value })}><option value="">All working employees</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field><Field label="Notes" className="sm:col-span-2"><input className="input" value={create.notes} onChange={(e) => setCreate({ ...create, notes: e.target.value })} /></Field><div className="flex justify-end sm:col-span-2"><button className="btn-primary" onClick={() => mCreate.mutate()}>Create & populate</button></div></div>}</Modal>
    </div>
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
