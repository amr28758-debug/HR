'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, StatTile, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Disciplinary /></AppShell>; }

function Disciplinary() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['disciplinary', 'list', status], queryFn: () => api<any[]>(`/api/v1/people/disciplinary${qs({ status })}`), enabled: can('disciplinary:read') });
  const [open, setOpen] = useState<any | null>(null);
  const save = useMutation({ mutationFn: () => api(`/api/v1/people/disciplinary/${open.id}`, { method: 'PATCH', json: { actionTaken: open.actionTaken || null, employeeResponse: open.employeeResponse || null, status: open.status } }), onSuccess: () => { setOpen(null); qc.invalidateQueries({ queryKey: ['disciplinary'] }); } });
  if (!can('disciplinary:read')) return <Alert tone="danger">Disciplinary records are confidential. Your role does not have access.</Alert>;
  const rows = q.data ?? [];
  return (
    <>
      <PageHeader eyebrow="Talent" title="Disciplinary" subtitle="Confidential case register. New actions are raised from the employee profile (Actions → Disciplinary action) and approved by HR Manager and Management." />
      <div className="mb-4"><Alert tone="warning"><span className="flex items-center gap-2"><ShieldAlert size={16} />Access to this module is audited. Penalties, suspensions and terminations must follow the company disciplinary policy and UAE Labour Law — REQUIRES HR/LEGAL SIGN-OFF.</span></Alert></div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Open" value={rows.filter((c) => c.status === 'OPEN').length} tone="warning" /><StatTile label="Under investigation" value={rows.filter((c) => c.status === 'UNDER_INVESTIGATION').length} tone="info" /><StatTile label="Action taken" value={rows.filter((c) => c.status === 'ACTION_TAKEN').length} /><StatTile label="Closed" value={rows.filter((c) => c.status === 'CLOSED').length} tone="success" /></div>
      <Card padded={false} title="Cases" actions={<select className="input sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['OPEN', 'UNDER_INVESTIGATION', 'ACTION_TAKEN', 'CLOSED', 'WITHDRAWN'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select>}>
        {q.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Case</th><th>Employee</th><th>Category</th><th>Severity</th><th>Incident</th><th>Action</th><th>Status</th><th>Opened</th><th></th></tr></thead><tbody>{rows.map((c) => <tr key={c.id}><td className="font-mono text-xs">{c.caseNo}</td><td><Link href={`/employees/${c.employeeId}?tab=disciplinary`} className="font-medium hover:underline">{c.employeeName}</Link><span className="block text-[11px] text-muted">{c.employeeNo}</span></td><td>{humanStatus(c.category)}</td><td><Badge status={c.severity} /></td><td>{fmtDate(c.incidentDate)}</td><td>{humanStatus(c.actionTaken)}</td><td><Badge status={c.status} /></td><td className="text-xs text-muted">{fmtDateTime(c.createdAt)}</td><td>{can('disciplinary:write') && <button className="btn-ghost btn-sm" onClick={() => setOpen({ ...c, actionTaken: c.actionTaken ?? '', employeeResponse: c.employeeResponse ?? '' })}>Open</button>}</td></tr>)}</tbody></table></div> : <EmptyState title="No cases" />}
      </Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${open.caseNo} · ${open.employeeName}` : ''} wide>{open && <div className="space-y-3"><p className="rounded-xl bg-surface-2/60 p-3 text-sm whitespace-pre-wrap">{open.description}</p><div className="grid gap-3 sm:grid-cols-2"><Field label="Status"><select className="input" value={open.status} onChange={(e) => setOpen({ ...open, status: e.target.value })}>{['OPEN', 'UNDER_INVESTIGATION', 'ACTION_TAKEN', 'CLOSED', 'WITHDRAWN'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select></Field><Field label="Action taken"><input className="input" value={open.actionTaken} onChange={(e) => setOpen({ ...open, actionTaken: e.target.value })} /></Field></div><Field label="Employee response"><textarea className="input min-h-24" value={open.employeeResponse} onChange={(e) => setOpen({ ...open, employeeResponse: e.target.value })} /></Field><div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(null)}>Cancel</button><button className="btn-primary" onClick={() => save.mutate()}>Save</button></div></div>}</Modal>
    </>
  );
}
