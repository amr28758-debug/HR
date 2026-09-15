'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Avatar, Badge, Card, Field, KeyValue, Modal, PageHeader, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, fmtDateTime, humanStatus } from '@/lib/format';

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <AppShell><RequestDetail id={id} /></AppShell>; }

function RequestDetail({ id }: { id: string }) {
  const { can, principal } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['hr-request', id], queryFn: () => api<any>(`/api/v1/hr-requests/${id}`) });
  const mine = useQuery({ queryKey: ['tasks', 'mine'], queryFn: () => api<Paginated<any>>('/api/v1/workflows/tasks/mine?pageSize=200'), enabled: can('workflows:act') });
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [comment, setComment] = useState('');
  const task = mine.data?.data.find((t) => t.entityType === 'hr_request' && t.entityId === id);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['hr-request', id] }); qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['hr-requests'] }); };
  const decide = useMutation({ mutationFn: () => api(`/api/v1/workflows/tasks/${task!.id}/decide`, { method: 'POST', json: { decision, comment: comment || undefined } }), onSuccess: () => { setDecision(null); setComment(''); refresh(); } });
  const cancel = useMutation({ mutationFn: () => api(`/api/v1/hr-requests/${id}/cancel`, { method: 'POST', json: {} }), onSuccess: refresh });
  const reapply = useMutation({ mutationFn: () => api(`/api/v1/hr-requests/${id}/apply`, { method: 'POST' }), onSuccess: refresh });
  if (q.isLoading) return <TableSkeleton />;
  if (!q.data) return <Alert tone="danger">{(q.error as Error)?.message ?? 'Not found'}</Alert>;
  const r = q.data;
  const stepCls = (s: string) => s === 'APPROVED' ? 'bg-success text-white' : s === 'REJECTED' ? 'bg-danger text-white' : s === 'PENDING' ? 'bg-warning text-white animate-pulse' : 'bg-surface-2 text-muted';
  return (
    <>
      <PageHeader breadcrumb={<Link href="/requests" className="link">HR requests</Link>} eyebrow={humanStatus(r.type)} title={<span className="flex flex-wrap items-center gap-3">{r.requestNo}<Badge status={r.status} /></span>} subtitle={r.title}
        actions={<>{task && <><button className="btn-secondary" onClick={() => setDecision('REJECTED')}>Reject</button><button className="btn-primary" onClick={() => setDecision('APPROVED')}>Approve · {humanStatus(task.stepKey)}</button></>}{r.status === 'PENDING' && (can('requests:create:any') || r.employee.id === principal?.employeeId) && <button className="btn-ghost" onClick={() => { if (confirm('Cancel this request?')) cancel.mutate(); }}>Cancel request</button>}{r.status === 'FAILED' && can('config:write') && <button className="btn-primary" onClick={() => reapply.mutate()}>Re-apply</button>}</>} />
      {r.applyError && <div className="mb-4"><Alert tone="danger">Application failed: {r.applyError}</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Employee"><Link href={`/employees/${r.employee.id}`} className="flex items-center gap-3"><Avatar name={r.employee.name} /><span><span className="block font-semibold hover:underline">{r.employee.name}</span><span className="block text-xs text-muted">{r.employee.employeeNo} · {r.employee.designation ?? '—'} · {r.employee.department ?? '—'}</span></span></Link>
          <div className="mt-4"><KeyValue items={[{ k: 'Effective', v: fmtDate(r.effectiveDate) }, { k: 'Raised by', v: `${r.requestedBy ?? '—'} · ${fmtDateTime(r.requestedAt)}` }, { k: 'Decided', v: r.decidedAt ? fmtDateTime(r.decidedAt) : '—' }, { k: 'Applied', v: r.appliedAt ? fmtDateTime(r.appliedAt) : '—' }, { k: 'Reason', v: r.reason }]} cols={1} /></div></Card>
        <Card title="What changes" subtitle="Before → after" className="lg:col-span-2">
          {r.changes.length ? <div className="grid gap-2 sm:grid-cols-2">{r.changes.map((c: any) => <div key={c.field} className="flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-muted">{humanStatus(c.field)}</span><span className="text-sm"><span className="text-muted line-through">{c.from === null || c.from === undefined ? '—' : String(c.from)}</span><span className="mx-2 text-muted">→</span><b>{c.to === null || c.to === undefined ? '—' : String(c.to)}</b></span></div>)}</div> : <p className="text-sm text-muted">{r.payload && Object.keys(r.payload).length ? 'Details below.' : 'Restricted — you can see the status but not the content of this request.'}</p>}
          {r.payload && Object.keys(r.payload).length > 0 && <details className="mt-4"><summary className="cursor-pointer text-xs font-semibold text-muted">Raw payload</summary><pre className="mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3 text-[11px]">{JSON.stringify(r.payload, null, 2)}</pre></details>}
          {r.result && Object.keys(r.result).filter((k) => k !== 'changes').length > 0 && <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-muted">Application result</summary><pre className="mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3 text-[11px]">{JSON.stringify(Object.fromEntries(Object.entries(r.result).filter(([k]) => k !== 'changes')), null, 2)}</pre></details>}
        </Card>
        <Card title="Approval chain" className="lg:col-span-3">
          {r.tasks.length ? <ol className="flex flex-wrap gap-3">{r.tasks.map((t: any, i: number) => <li key={t.id} className="flex min-w-[220px] flex-1 items-center gap-3 rounded-2xl border p-3"><span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold', stepCls(t.status))}>{i + 1}</span><span className="min-w-0"><span className="block text-sm font-semibold">{humanStatus(t.stepKey)}</span><span className="block truncate text-[11px] text-muted">{t.assigneeRole ? t.assigneeRole.replace(/_/g, ' ') : 'Manager'} · {humanStatus(t.status)}{t.decidedBy ? ` by ${t.decidedBy}` : ''}{t.decidedAt ? ` · ${fmtDateTime(t.decidedAt)}` : ''}</span>{t.comment && <span className="block text-[11px] italic text-muted">“{t.comment}”</span>}</span></li>)}</ol> : <p className="text-sm text-muted">No approval workflow — applied immediately.</p>}
        </Card>
      </div>
      <Modal open={!!decision} onClose={() => setDecision(null)} title={decision === 'APPROVED' ? `Approve ${r.requestNo}` : `Reject ${r.requestNo}`}>
        <div className="space-y-3"><Field label="Comment"><textarea className="input min-h-24" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>{decision === 'APPROVED' && r.tasks.filter((t: any) => t.status === 'PENDING').length === 1 && <Alert tone="info">This is the final step — the change will be applied immediately on approval.</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setDecision(null)}>Back</button><button className={decision === 'APPROVED' ? 'btn-primary' : 'btn-danger'} disabled={decide.isPending} onClick={() => decide.mutate()}>{decision === 'APPROVED' ? 'Approve' : 'Reject'}</button></div></div>
      </Modal>
    </>
  );
}
