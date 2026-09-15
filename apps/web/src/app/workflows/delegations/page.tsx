'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCog } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, TableSkeleton } from '@/components/ui';
import { fmtDate, today } from '@/lib/format';

export default function Page() { return <AppShell><Delegations /></AppShell>; }

function Delegations() {
  const { can, principal } = useAuth();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['delegations', all], queryFn: () => api<any[]>(`/api/v1/workflows/delegations${all ? '?all=true' : ''}`) });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<any>('/api/v1/auth/users'), enabled: can('users:read'), retry: false });
  const [create, setCreate] = useState<any | null>(null);
  const m = useMutation({ mutationFn: () => api('/api/v1/workflows/delegations', { method: 'POST', json: { toUserId: create.toUserId, fromDate: create.fromDate, toDate: create.toDate, reason: create.reason || undefined, ...(create.fromUserId && { fromUserId: create.fromUserId }) } }), onSuccess: () => { setCreate(null); qc.invalidateQueries({ queryKey: ['delegations'] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/v1/workflows/delegations/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['delegations'] }) });
  const userList: any[] = Array.isArray(users.data) ? users.data : users.data?.data ?? [];
  return (
    <>
      <PageHeader eyebrow="Workflows" title="Delegation" subtitle="Hand your approvals to a colleague while you are away. Delegates see your tasks in their inbox and decisions are recorded under their name." actions={<>{can('delegation:manage') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show everyone's</label>}<button className="btn-primary" onClick={() => setCreate({ toUserId: '', fromUserId: '', fromDate: today(), toDate: today(), reason: '' })}><Plus size={16} />Delegate</button></>} />
      <Card padded={false}>
        {q.isLoading ? <TableSkeleton /> : q.data?.length ? <table className="data"><thead><tr><th>From</th><th>To</th><th>Period</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>{q.data.map((d) => { const active = d.isActive && d.fromDate <= today() && d.toDate >= today(); return <tr key={d.id}><td className="font-medium">{d.fromUser ?? d.fromUserId}</td><td className="font-medium">{d.toUser ?? d.toUserId}</td><td>{fmtDate(d.fromDate)} → {fmtDate(d.toDate)}</td><td className="text-muted">{d.reason ?? '—'}</td><td><Badge status={!d.isActive ? 'CANCELLED' : active ? 'ACTIVE' : d.fromDate > today() ? 'PENDING' : 'CLOSED'}>{!d.isActive ? 'Revoked' : active ? 'Active' : d.fromDate > today() ? 'Scheduled' : 'Ended'}</Badge></td><td>{d.isActive && (d.fromUserId === principal?.userId || can('delegation:manage')) && <button className="btn-ghost btn-sm text-danger" onClick={() => revoke.mutate(d.id)}>Revoke</button>}</td></tr>; })}</tbody></table> : <EmptyState icon={<UserCog size={22} />} title="No delegations" hint="Delegate your approvals before going on leave." />}
      </Card>
      <Modal open={!!create} onClose={() => setCreate(null)} title="Delegate approvals">{create && <div className="space-y-3">
        {can('delegation:manage') && userList.length > 0 && <Field label="On behalf of (optional — admin)"><select className="input" value={create.fromUserId} onChange={(e) => setCreate({ ...create, fromUserId: e.target.value })}><option value="">Myself</option>{userList.map((u) => <option key={u.id} value={u.id}>{u.displayName ?? u.email}</option>)}</select></Field>}
        <Field label="Delegate to">{userList.length ? <select className="input" value={create.toUserId} onChange={(e) => setCreate({ ...create, toUserId: e.target.value })}><option value="">Choose a user…</option>{userList.filter((u) => u.id !== principal?.userId).map((u) => <option key={u.id} value={u.id}>{u.displayName ?? u.email}{u.roles?.length ? ` · ${u.roles.join(', ')}` : ''}</option>)}</select> : <input className="input" placeholder="User id (ask IT for the colleague's user id)" value={create.toUserId} onChange={(e) => setCreate({ ...create, toUserId: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3"><Field label="From"><input type="date" className="input" value={create.fromDate} onChange={(e) => setCreate({ ...create, fromDate: e.target.value })} /></Field><Field label="To"><input type="date" className="input" value={create.toDate} onChange={(e) => setCreate({ ...create, toDate: e.target.value })} /></Field></div>
        <Field label="Reason"><input className="input" value={create.reason} onChange={(e) => setCreate({ ...create, reason: e.target.value })} /></Field>
        {m.isError && <Alert tone="danger">{(m.error as Error).message}</Alert>}
        <div className="flex justify-end"><button className="btn-primary" disabled={!create.toUserId} onClick={() => m.mutate()}>Delegate</button></div>
      </div>}</Modal>
    </>
  );
}
