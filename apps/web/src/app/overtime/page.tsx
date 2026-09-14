'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, TableSkeleton, Tabs } from '@/components/ui';
import { fmtDate, fmtMinutes, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Overtime /></AppShell>; }
function Overtime() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'requests' | 'rules'>('requests');
  const [f, setF] = useState({ status: 'PENDING', page: 1 });
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['overtime', f], queryFn: () => api<Paginated<any>>(`/api/v1/overtime/requests${qs({ ...f, pageSize: 50 })}`), placeholderData: (p) => p });
  const rules = useQuery({ queryKey: ['overtime-rules'], queryFn: () => api<any[]>('/api/v1/overtime/rules') });
  const decide = useMutation({ mutationFn: (v: { id: string; decision: string }) => api(`/api/v1/overtime/requests/${v.id}/decide`, { method: 'POST', json: { decision: v.decision } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['overtime'] }) });
  const [form, setForm] = useState({ employeeNo: '', date: '', reason: '' });
  const m = useMutation({ mutationFn: async () => { const employeeId = form.employeeNo ? (await api<any>(`/api/v1/employees/by-number/${form.employeeNo}`)).id : undefined; return api('/api/v1/overtime/requests', { method: 'POST', json: { employeeId, date: form.date, reason: form.reason || undefined } }); }, onSuccess: () => { qc.invalidateQueries({ queryKey: ['overtime'] }); setOpen(false); } });
  return (
    <>
      <PageHeader title="Overtime" subtitle="Computed from punches by shift rules; paid only after approval. Multipliers are configurable policy." actions={can('overtime:request', 'overtime:approve') && <button className="btn-primary" onClick={() => setOpen(true)}>Request approval</button>} />
      <Tabs tabs={[{ key: 'requests', label: 'Requests' }, { key: 'rules', label: 'Rules' }]} value={tab} onChange={setTab} />
      {tab === 'requests' && <Card padded={false}><div className="flex gap-2 border-b p-3"><select className="input sm:w-40" value={f.status} onChange={(e) => setF({ status: e.target.value, page: 1 })}><option value="">All</option>{['PENDING', 'APPROVED', 'REJECTED'].map((s) => <option key={s}>{s}</option>)}</select></div>{q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <table className="data"><thead><tr><th>Date</th><th>Employee</th><th>Day</th><th>Computed</th><th>Requested</th><th>Approved</th><th>Multiplier</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>{q.data.data.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td><Link href={`/employees/${r.employeeId}?tab=requests`} className="font-medium hover:underline">{r.employeeNo} · {r.employeeName}</Link></td><td><Badge status={r.dayKind === 'NORMAL' ? undefined : r.dayKind === 'WEEK_OFF' ? 'WEEK_OFF' : 'PUBLIC_HOLIDAY'}>{humanStatus(r.dayKind)}</Badge></td><td className="text-muted">{fmtMinutes(r.computedMinutes)}</td><td>{fmtMinutes(r.requestedMinutes)}</td><td className="text-success">{fmtMinutes(r.approvedMinutes)}</td><td>{r.multiplier ? `×${r.multiplier}` : '—'}</td><td className="max-w-xs truncate text-muted">{r.reason ?? '—'}</td><td><Badge status={r.status} /></td><td className="whitespace-nowrap text-end">{r.status === 'PENDING' && can('overtime:approve') && <><button className="btn-ghost btn-sm text-success" onClick={() => decide.mutate({ id: r.id, decision: 'APPROVED' })}>Approve</button><button className="btn-ghost btn-sm text-danger" onClick={() => decide.mutate({ id: r.id, decision: 'REJECTED' })}>Reject</button></>}</td></tr>)}</tbody></table> : <EmptyState title="No overtime requests" />}{q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}</Card>}
      {tab === 'rules' && <div className="grid gap-4 md:grid-cols-3">{rules.data?.map((r) => <div key={r.id} className="card p-5"><p className="text-xs font-semibold uppercase tracking-wider text-muted">{r.code}</p><h3 className="text-lg font-semibold">{r.name}</h3><p className="mt-2 text-3xl font-semibold">×{r.multiplier}</p><dl className="mt-3 grid grid-cols-2 gap-1 text-xs"><dt className="text-muted">Day kind</dt><dd>{humanStatus(r.dayKind)}</dd><dt className="text-muted">Scope</dt><dd>{r.scope}</dd><dt className="text-muted">Min / max per day</dt><dd>{r.minMinutes}m / {r.maxMinutesPerDay ? fmtMinutes(r.maxMinutesPerDay) : '∞'}</dd><dt className="text-muted">HR approval over</dt><dd>{r.requiresHrApprovalOverMinutes ? fmtMinutes(r.requiresHrApprovalOverMinutes) : '—'}</dd></dl>{r.isStatutory ? <Badge status="LOCKED" className="mt-3">Statutory · legally reviewed</Badge> : <Badge className="mt-3">Company policy · requires HR/legal confirmation</Badge>}</div>)}</div>}
      <Modal open={open} onClose={() => setOpen(false)} title="Request overtime approval"><div className="space-y-3">{can('overtime:approve') && <Field label="Employee number (blank = myself)"><input className="input" value={form.employeeNo} onChange={(e) => setForm({ ...form, employeeNo: e.target.value })} /></Field>}<Field label="Date"><input type="date" className="input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field><Field label="Reason"><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field><Alert tone="info">Requested minutes default to the overtime computed from punches for that day.</Alert>{m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={m.isPending || !form.date} onClick={() => m.mutate()}>Submit</button></div></div></Modal>
    </>
  );
}
