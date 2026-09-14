'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, TableSkeleton, Tabs } from '@/components/ui';
import { fmtDate } from '@/lib/format';

export default function Page() { return <AppShell><Leave /></AppShell>; }
function Leave() {
  const { can, principal } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'requests' | 'calendar' | 'balances'>('requests');
  const [f, setF] = useState({ status: '', page: 1 });
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['leave', f], queryFn: () => api<Paginated<any>>(`/api/v1/leave/requests${qs({ ...f, pageSize: 50 })}`), placeholderData: (p) => p });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/api/v1/leave/requests/${id}/cancel`, { method: 'POST', json: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['leave'] }) });
  const myBal = useQuery({ queryKey: ['leave-balances', principal?.employeeId], queryFn: () => api<any[]>(`/api/v1/leave/balances/${principal!.employeeId}`), enabled: !!principal?.employeeId });
  return (
    <>
      <PageHeader title="Leave" subtitle="Requests flow Manager → HR. Approved leave updates attendance, timesheets and payroll automatically." actions={can('leave:request:own', 'leave:request:any') && <button className="btn-primary" onClick={() => setOpen(true)}>Request leave</button>} />
      {myBal.data && <div className="mb-5 grid gap-3 sm:grid-cols-4">{myBal.data.map((b) => <div key={b.leaveTypeCode} className="card p-4"><p className="text-[11px] uppercase tracking-wider text-muted">{b.leaveTypeName}</p><p className="text-2xl font-semibold tabular-nums">{b.available}<span className="text-sm font-normal text-muted"> / {b.balance} days</span></p></div>)}</div>}
      <Tabs tabs={[{ key: 'requests', label: 'Requests' }, ...(can('leave:read', 'leave:read:team') ? [{ key: 'calendar' as const, label: 'Team calendar' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'requests' && <Card padded={false}><div className="flex gap-2 border-b p-3"><select className="input sm:w-40" value={f.status} onChange={(e) => setF({ status: e.target.value, page: 1 })}><option value="">All</option>{['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</select></div>{q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <table className="data"><thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>{q.data.data.map((r) => <tr key={r.id}><td><Link href={`/employees/${r.employeeId}?tab=leave`} className="font-medium hover:underline">{r.employeeNo} · {r.employeeName}</Link></td><td>{r.leaveTypeName}</td><td>{fmtDate(r.startDate)}</td><td>{fmtDate(r.endDate)}</td><td>{r.totalDays}{r.isHalfDay ? ` (${r.halfDayPart})` : ''}</td><td className="max-w-xs truncate text-muted">{r.reason ?? '—'}</td><td><Badge status={r.status} /></td><td className="text-end">{['PENDING', 'APPROVED'].includes(r.status) && (r.employeeId === principal?.employeeId || can('leave:request:any')) && <button className="btn-ghost btn-sm text-danger" onClick={() => confirm('Cancel this leave?') && cancel.mutate(r.id)}>Cancel</button>}</td></tr>)}</tbody></table> : <EmptyState title="No leave requests" />}{q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}</Card>}
      {tab === 'calendar' && <TeamCalendar />}
      <RequestModal open={open} onClose={() => setOpen(false)} onSaved={() => { qc.invalidateQueries({ queryKey: ['leave'] }); qc.invalidateQueries({ queryKey: ['leave-balances'] }); setOpen(false); }} />
    </>
  );
}
function TeamCalendar() {
  const [from] = useState(() => new Date().toISOString().slice(0, 10));
  const to = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const q = useQuery({ queryKey: ['leave', 'calendar', from], queryFn: () => api<any[]>(`/api/v1/leave/calendar?from=${from}&to=${to}`) });
  const days = Array.from({ length: 31 }, (_, i) => new Date(Date.now() + i * 864e5).toISOString().slice(0, 10));
  const people = [...new Map(q.data?.map((x) => [x.employeeId, x]) ?? []).values()];
  return <Card title="Next 30 days" padded={false}>{people.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th className="sticky start-0 bg-surface-2">Employee</th>{days.map((d) => <th key={d} className="px-1 text-center">{d.slice(8)}</th>)}</tr></thead><tbody>{people.map((p) => <tr key={p.employeeId}><td className="sticky start-0 whitespace-nowrap bg-surface font-medium">{p.employeeNo} · {p.employeeName}</td>{days.map((d) => { const l = q.data!.find((x) => x.employeeId === p.employeeId && x.startDate <= d && x.endDate >= d); return <td key={d} className="p-0.5"><div className={`h-6 rounded ${l ? (l.status === 'APPROVED' ? 'bg-info/70' : 'bg-warning/60') : ''}`} title={l ? `${l.leaveTypeCode} ${l.status}` : ''} /></td>; })}</tr>)}</tbody></table></div> : <EmptyState title="No upcoming leave in your team" />}</Card>;
}
function RequestModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { can } = useAuth();
  const types = useQuery({ queryKey: ['leave-types'], queryFn: () => api<any[]>('/api/v1/leave/types'), enabled: open });
  const [f, setF] = useState<any>({ employeeNo: '', leaveTypeCode: 'ANNUAL', startDate: '', endDate: '', isHalfDay: false, halfDayPart: 'AM', reason: '' });
  const m = useMutation({ mutationFn: async () => { let employeeId: string | undefined; if (f.employeeNo) employeeId = (await api<any>(`/api/v1/employees/by-number/${f.employeeNo}`)).id; return api('/api/v1/leave/requests', { method: 'POST', json: { employeeId, leaveTypeCode: f.leaveTypeCode, startDate: f.startDate, endDate: f.isHalfDay ? f.startDate : f.endDate, isHalfDay: f.isHalfDay, halfDayPart: f.isHalfDay ? f.halfDayPart : undefined, reason: f.reason || undefined } }); }, onSuccess: onSaved });
  return <Modal open={open} onClose={onClose} title="Request leave"><div className="space-y-3">{can('leave:request:any') && <Field label="Employee number (blank = myself)"><input className="input" placeholder="BP-26-777" value={f.employeeNo} onChange={(e) => setF({ ...f, employeeNo: e.target.value })} /></Field>}<Field label="Leave type"><select className="input" value={f.leaveTypeCode} onChange={(e) => setF({ ...f, leaveTypeCode: e.target.value })}>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}{t.isPaid ? '' : ' (unpaid)'}</option>)}</select></Field><div className="grid grid-cols-2 gap-3"><Field label="From"><input type="date" className="input" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field><Field label="To"><input type="date" className="input" disabled={f.isHalfDay} value={f.isHalfDay ? f.startDate : f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isHalfDay} onChange={(e) => setF({ ...f, isHalfDay: e.target.checked })} />Half day</label><Field label="Reason"><textarea className="input h-20 py-2" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>{m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending || !f.startDate} onClick={() => m.mutate()}>Submit</button></div></div></Modal>;
}
