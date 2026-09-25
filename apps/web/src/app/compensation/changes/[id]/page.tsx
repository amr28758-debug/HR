'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, Field, KeyValue, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMoney, humanStatus } from '@/lib/format';
import { AlertList, ApprovalTrail, BandBar, CompPage, WfBadge, pct, typeLabel } from '@/components/compensation/common';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <CompPage title="Salary change" breadcrumb={<Link href="/compensation/employees" className="hover:text-brand">Employees</Link>}><Change id={id} /></CompPage>;
}

function Change({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['comp', 'change', id], queryFn: () => api<any>(`/api/v1/compensation/changes/${id}`) });
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const inv = () => { setErr(null); qc.invalidateQueries({ queryKey: ['comp'] }); };
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body: any }) => api(`/api/v1/compensation/changes/${id}/${path}`, { method: 'POST', json: body }), onSuccess: inv, onError: (e: any) => setErr(e.message) });
  if (q.isLoading) return <TableSkeleton />;
  if (q.isError) return <Alert tone="danger">{(q.error as Error).message}</Alert>;
  const c = q.data; const cur = c.currency;
  const pendingTask = c.tasks.find((t: any) => t.status === 'PENDING');
  const livePending = ['SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED'].includes(c.status);
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Card title={<span className="flex items-center gap-3">{c.changeNo} <WfBadge status={c.status} /></span>} subtitle={`${typeLabel(c.changeType)} · ${c.employee.name} (${c.employee.employeeNo})`} actions={<Link className="btn-ghost btn-sm" href={`/compensation/employees/${c.employee.id}`}>Employee</Link>}>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-surface-2 p-3"><p className="text-[10px] font-semibold uppercase text-muted">Old salary</p><p className="text-lg font-bold">{fmtMoney(c.oldSalary, cur)}</p></div>
            <div className="rounded-xl bg-surface-2 p-3"><p className="text-[10px] font-semibold uppercase text-muted">Increase</p><p className="text-lg font-bold">{c.increaseAmount >= 0 ? '+' : ''}{fmtMoney(c.increaseAmount, cur)}</p><p className="text-xs text-muted">{pct(c.increasePct, 2)}</p></div>
            <div className="rounded-xl bg-surface-2 p-3"><p className="text-[10px] font-semibold uppercase text-muted">New salary</p><p className="text-lg font-bold text-success">{fmtMoney(c.newSalary, cur)}</p></div>
            <div className="rounded-xl bg-surface-2 p-3"><p className="text-[10px] font-semibold uppercase text-muted">Annual cost</p><p className="text-lg font-bold">{fmtMoney(c.annualCost, cur)}</p></div>
          </div>
          {c.band && <div className="mt-4"><p className="text-xs text-muted">Band at request: compa {pct(c.compaBefore)} → {pct(c.compaAfter)}{c.exceedsMaxBy > 0 && <b className="text-danger"> · exceeds maximum by {fmtMoney(c.exceedsMaxBy, cur)} ({humanStatus(c.ceilingAction ?? '')})</b>}</p><BandBar min={c.band.min} mid={c.band.mid} max={c.band.max} current={c.oldSalary} proposed={c.newSalary} currency={cur} /></div>}
          <div className="mt-4"><KeyValue items={[
            { k: 'Effective date', v: fmtDate(c.effectiveDate) }, { k: 'Grade', v: c.oldGrade === c.newGrade ? c.oldGrade ?? '—' : `${c.oldGrade ?? '—'} → ${c.newGrade}` },
            { k: 'Job title', v: c.oldTitle === c.newTitle ? c.oldTitle ?? '—' : `${c.oldTitle ?? '—'} → ${c.newTitle}` }, { k: 'Reason', v: c.reason },
            { k: 'Comments', v: c.comments ?? '—' }, { k: 'Justification', v: c.justification ?? '—' },
            { k: 'Requested by', v: c.requestedBy ?? '—' }, { k: 'Approved by', v: c.approvedBy ? `${c.approvedBy} · ${fmtDateTime(c.approvedAt)}` : '—' },
            { k: 'Recommended (merit)', v: c.recommendedPct === null ? '—' : `${c.recommendedPct}%` }, { k: 'Flags', v: [c.isOverride && 'override', c.duplicateOverride && 'duplicate override', c.budgetOverride && 'budget override', c.requiresException && 'band exception', c.outsideWorkflow && 'outside workflow'].filter(Boolean).join(', ') || 'none' },
          ]} /></div>
          {c.applyError && <div className="mt-3"><Alert tone="danger">Could not be applied: {c.applyError}</Alert></div>}
          {c.alerts.length > 0 && <div className="mt-4"><AlertList alerts={c.alerts} /></div>}
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Actions">
          <div className="space-y-3">
            {err && <Alert tone="danger">{err}</Alert>}
            {c.status === 'DRAFT' && can('compensation:propose') && <button className="btn-primary w-full" disabled={act.isPending} onClick={() => act.mutate({ path: 'submit', body: {} })}>Submit for approval</button>}
            {livePending && pendingTask && can('workflows:act') && <>
              <Field label={`Decision for step “${pendingTask.step}”${pendingTask.role ? ` (${humanStatus(pendingTask.role)})` : ''}`}><textarea className="input min-h-16" placeholder="Comment (recorded in the approval history)" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
              <div className="grid grid-cols-2 gap-2"><button className="btn-primary" disabled={act.isPending} onClick={() => act.mutate({ path: 'approve', body: { decision: 'APPROVED', comment: comment || undefined } })}>Approve</button><button className="btn-danger" disabled={act.isPending || !comment} title={comment ? '' : 'A comment is required to reject'} onClick={() => act.mutate({ path: 'approve', body: { decision: 'REJECTED', comment } })}>Reject</button></div>
            </>}
            {(c.status === 'DRAFT' || livePending) && can('compensation:propose') && <button className="btn-ghost w-full" disabled={act.isPending} onClick={() => { const r = window.prompt('Reason for cancelling'); if (r) act.mutate({ path: 'cancel', body: { reason: r } }); }}>Cancel change</button>}
            {!['DRAFT'].includes(c.status) && !livePending && <p className="text-sm text-muted">This change is {humanStatus(c.status).toLowerCase()} — the record is kept permanently.</p>}
          </div>
        </Card>
        <Card title="Workflow steps">{c.tasks.length ? <ul className="space-y-2 text-sm">{c.tasks.map((t: any) => <li key={t.id} className="flex items-center justify-between gap-2"><span>{t.step}<span className="block text-xs text-muted">{t.role ? humanStatus(t.role) : 'Line manager'}{t.decidedBy ? ` · ${t.decidedBy}` : ''}</span></span><WfBadge status={t.status} /></li>)}</ul> : <p className="text-sm text-muted">Not submitted yet.</p>}</Card>
        <Card title="Approval history"><ApprovalTrail items={c.approvals} /></Card>
      </div>
    </div>
  );
}
