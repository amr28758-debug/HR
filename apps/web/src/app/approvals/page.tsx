'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, TableSkeleton } from '@/components/ui';
import { fmtDateTime, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Approvals /></AppShell>; }
function Approvals() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['tasks', all], queryFn: () => api<Paginated<any>>(`/api/v1/workflows/tasks/mine?pageSize=100${all ? '&all=true' : ''}`) });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => api<any[]>('/api/v1/workflows/notifications') });
  const [target, setTarget] = useState<{ task: any; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  const [comment, setComment] = useState('');
  const decide = useMutation({ mutationFn: () => api(`/api/v1/workflows/tasks/${target!.task.id}/decide`, { method: 'POST', json: { decision: target!.decision, comment: comment || undefined } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); setTarget(null); setComment(''); } });
  const markRead = useMutation({ mutationFn: () => api('/api/v1/workflows/notifications/read', { method: 'POST', json: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const ctx = (t: any) => Object.entries(t.context ?? {}).filter(([k]) => k !== 'employeeId').map(([k, v]) => `${humanStatus(k)}: ${v}`).join(' · ');
  return (
    <>
      <PageHeader title="Approvals" subtitle="Tasks routed to you or your roles by the workflow engine." actions={can('workflows:write') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show all pending (admin)</label>} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card padded={false} className="xl:col-span-2" title={`Pending tasks${q.data ? ` · ${q.data.meta.total}` : ''}`}>{q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <ul className="divide-y">{q.data.data.map((t) => <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><Badge>{humanStatus(t.workflowCode)}</Badge><span className="text-xs text-muted">step: {t.stepKey}{t.assigneeRole ? ` · ${t.assigneeRole.replace(/_/g, ' ')}` : ''}</span></div><p className="mt-1 text-sm">{t.employee ? <Link href={`/employees/${t.employee.id}`} className="font-medium hover:underline">{t.employee.employeeNo} · {t.employee.name}</Link> : t.entityType}</p><p className="text-xs text-muted">{ctx(t)}</p><p className="text-[11px] text-muted">Requested {fmtDateTime(t.createdAt)}{t.dueAt ? ` · due ${fmtDateTime(t.dueAt)}` : ''}</p></div><div className="flex gap-2"><button className="btn-secondary btn-sm text-danger" onClick={() => setTarget({ task: t, decision: 'REJECTED' })}>Reject</button><button className="btn-primary btn-sm" onClick={() => setTarget({ task: t, decision: 'APPROVED' })}>Approve</button></div></li>)}</ul> : <EmptyState title="Inbox zero" hint="No approvals are waiting for you." />}</Card>
        <Card title="Notifications" padded={false} actions={<button className="btn-ghost btn-sm" onClick={() => markRead.mutate()}>Mark all read</button>}><ul className="max-h-[32rem] divide-y overflow-auto">{notes.data?.map((n) => <li key={n.id} className={`px-5 py-3 ${n.readAt ? 'opacity-60' : ''}`}><p className="text-sm font-medium">{n.title}</p>{n.body && <p className="text-xs text-muted">{n.body}</p>}<p className="text-[11px] text-muted">{fmtDateTime(n.createdAt)}</p></li>)}{notes.data?.length === 0 && <EmptyState title="No notifications" />}</ul></Card>
      </div>
      <Modal open={!!target} onClose={() => setTarget(null)} title={`${target?.decision === 'APPROVED' ? 'Approve' : 'Reject'} · ${humanStatus(target?.task.workflowCode)}`}><div className="space-y-3"><Field label="Comment"><textarea className="input h-20 py-2" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>{decide.error && <Alert tone="danger">{(decide.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setTarget(null)}>Cancel</button><button className={target?.decision === 'APPROVED' ? 'btn-primary' : 'btn-danger'} disabled={decide.isPending} onClick={() => decide.mutate()}>{target?.decision === 'APPROVED' ? 'Approve' : 'Reject'}</button></div></div></Modal>
    </>
  );
}
