'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, Field, Modal, Pagination, StatTile, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, fmtMoney, humanStatus } from '@/lib/format';
import { AlertList, ApprovalTrail, BandBar, CeilingDecision, CompPage, WfBadge, pct } from '@/components/compensation/common';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <CompPage title="Salary review" breadcrumb={<Link href="/compensation/reviews" className="hover:text-brand">Salary reviews</Link>}><Review id={id} /></CompPage>;
}

function Review({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const r = useQuery({ queryKey: ['comp', 'review', id], queryFn: () => api<any>(`/api/v1/compensation/reviews/${id}`) });
  const [f, setF] = useState({ status: '', attention: '', search: '', page: 1 });
  const items = useQuery({ queryKey: ['comp', 'review-items', id, f], queryFn: () => api<Paginated<any>>(`/api/v1/compensation/reviews/${id}/items${qs({ ...f, pageSize: 50 })}`), enabled: can('salary:read') });
  const [edit, setEdit] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const inv = () => { setErr(null); qc.invalidateQueries({ queryKey: ['comp'] }); };
  const post = useMutation({ mutationFn: ({ path, body }: { path: string; body?: any }) => api<any>(`/api/v1/compensation/reviews/${id}/${path}`, { method: 'POST', json: body ?? {} }), onSuccess: inv, onError: (e: any) => setErr(e.message) });
  const patch = useMutation({ mutationFn: (its: any[]) => api<any>(`/api/v1/compensation/reviews/${id}/items`, { method: 'PATCH', json: { items: its } }), onSuccess: () => { setEdit(null); inv(); }, onError: (e: any) => setErr(e.message) });
  if (r.isLoading) return <TableSkeleton rows={8} />;
  if (r.isError) return <Alert tone="danger">{(r.error as Error).message}</Alert>;
  const v = r.data; const s = v.summary; const cur = v.currency;
  const draft = v.status === 'DRAFT';
  const pendingTask = v.tasks.find((t: any) => t.status === 'PENDING');
  const live = ['SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED'].includes(v.status);
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="flex items-center gap-3 text-xl font-bold">{v.name} <WfBadge status={v.status} /></h2><p className="text-sm text-muted">Effective {fmtDate(v.effectiveDate)} · default {v.defaultPercentage}% · maximum {v.maxPercentage ?? '—'}% · {v.recommendationMethod === 'MERIT_MATRIX' ? 'merit matrix' : 'default %'}{v.defaultCeilingAction ? ` · above max: ${humanStatus(v.defaultCeilingAction).toLowerCase()}` : ''}</p>{v.decisionComment && <p className="mt-1 text-sm text-danger">“{v.decisionComment}”</p>}</div>
          <div className="flex flex-wrap gap-2">
            {draft && can('compensation:propose') && <><button className="btn-secondary btn-sm" disabled={post.isPending} onClick={() => post.mutate({ path: 'populate' })}>Re-identify eligible employees</button>{s.actionRequired > 0 && <button className="btn-secondary btn-sm" onClick={() => post.mutate({ path: 'bulk-ceiling', body: { ceilingAction: 'CAP_AT_MAX' } })}>Cap all at maximum</button>}<button className="btn-primary btn-sm" disabled={post.isPending || s.actionRequired > 0 || !s.proposed} title={s.actionRequired ? 'Resolve ceiling decisions first' : ''} onClick={() => post.mutate({ path: 'submit' })}>Submit for approval</button></>}
            {v.status === 'REJECTED' && can('compensation:propose') && <button className="btn-secondary btn-sm" onClick={() => post.mutate({ path: 'reopen', body: { reason: 'Rework after rejection' } })}>Reopen for rework</button>}
            {v.approvedAt && v.status !== 'COMPLETED' && can('salary:write') && <button className="btn-primary btn-sm" onClick={() => post.mutate({ path: 'complete' })}>Retry applying</button>}
            {!['COMPLETED', 'CANCELLED'].includes(v.status) && can('compensation:propose') && <button className="btn-ghost btn-sm" onClick={() => { const x = window.prompt('Reason for cancelling this review'); if (x) post.mutate({ path: 'cancel', body: { reason: x } }); }}>Cancel review</button>}
          </div>
        </div>
        {err && <div className="mt-3"><Alert tone="danger">{err}</Alert></div>}
        {s.actionRequired > 0 && draft && <div className="mt-3"><Alert tone="danger">🔴 {s.actionRequired} employee(s) would exceed their band maximum — choose cap, exception, cancel or promotion for each before submitting.</Alert></div>}
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Employees included" value={`${s.proposed + s.completed}`} hint={`${s.ineligible} ineligible · ${s.excluded} excluded`} />
        <StatTile label="Current payroll (included)" value={fmtMoney(s.currentPayroll, cur)} hint="monthly gross" />
        <StatTile label="Monthly increase" value={fmtMoney(s.monthlyIncrease, cur)} hint={`average ${pct(s.averagePct, 2)}`} tone="accent" />
        <StatTile label="Annual cost" value={fmtMoney(s.annualIncrease, cur)} hint={s.budget !== null ? `${pct(s.utilizationPct)} of ${fmtMoney(s.budget, cur)} · ${fmtMoney(s.remaining, cur)} left` : 'no review budget'} tone={s.remaining !== null && s.remaining < 0 ? 'danger' : 'success'} />
      </div>
      {live && pendingTask && can('workflows:act') && <Card title={`Your decision — step “${pendingTask.step}”`}><div className="flex flex-wrap items-end gap-2"><Field label="Comment" className="min-w-64 flex-1"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field><button className="btn-primary" disabled={post.isPending} onClick={() => post.mutate({ path: 'approve', body: { decision: 'APPROVED', comment: comment || undefined } })}>Approve</button><button className="btn-danger" disabled={post.isPending || !comment} onClick={() => post.mutate({ path: 'approve', body: { decision: 'REJECTED', comment } })}>Reject</button></div></Card>}
      <Card padded={false} title="Employees" actions={<div className="flex flex-wrap gap-2"><input className="input w-44" placeholder="Search…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value, page: 1 })} /><select className="input w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['PROPOSED', 'EXCLUDED', 'INELIGIBLE', 'COMPLETED', 'FAILED', 'CANCELLED'].map((x) => <option key={x} value={x}>{humanStatus(x)}</option>)}</select><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={!!f.attention} onChange={(e) => setF({ ...f, attention: e.target.checked ? 'true' : '', page: 1 })} /> Needs attention</label></div>}>
        {!can('salary:read') ? <div className="p-5"><Alert tone="warning">Employee amounts need salary:read.</Alert></div> : items.isLoading ? <TableSkeleton /> : items.data?.data.length ? <div className="overflow-x-auto"><table className="data">
          <thead><tr><th>Employee</th><th>Grade</th><th>Rating</th><th>Current</th><th className="min-w-40">Band</th><th>Compa</th><th>Rec.</th><th>Increase</th><th>New salary</th><th>Status</th><th /></tr></thead>
          <tbody>{items.data.data.map((i) => <tr key={i.id} className={cn(i.outcome === 'ACTION_REQUIRED' && 'bg-danger/5')}>
            <td><Link href={`/compensation/employees/${i.employee.id}`} className="font-medium hover:text-brand">{i.employee.name}</Link><div className="text-xs text-muted">{i.employee.employeeNo} · {i.employee.department ?? '—'}</div>{!i.eligible && <div className="text-[11px] text-muted">{i.ineligibilityReasons.join('; ')}</div>}{i.applyError && <div className="text-[11px] text-danger">{i.applyError}</div>}</td>
            <td>{i.gradeCode ?? '—'}</td><td>{i.ratingCode ? humanStatus(i.ratingCode) : '—'}</td>
            <td className="tabular-nums">{fmtMoney(i.currentSalary, cur)}</td>
            <td>{i.band ? <BandBar min={i.band.min} mid={i.band.mid} max={i.band.max} current={i.currentSalary} proposed={i.proposedSalary} compact /> : <span className="text-xs text-muted">no band</span>}</td>
            <td>{pct(i.compaRatio)}</td><td>{i.recommendedPct === null ? '—' : `${i.recommendedPct}%`}</td>
            <td className="tabular-nums">{pct(i.proposedPct, 2)}<div className="text-xs text-muted">+{fmtMoney(i.proposedAmount, cur)}</div></td>
            <td className="tabular-nums font-semibold">{fmtMoney(i.finalSalary, cur)}{i.exceedsMaxBy > 0 && <div className={cn('text-[11px] font-normal', i.outcome === 'ACTION_REQUIRED' ? 'text-danger' : 'text-orange-600')}>{i.outcome === 'ACTION_REQUIRED' ? '🔴 exceeds max by ' : i.outcome === 'CAPPED' ? 'capped (would exceed by ' : '🟠 exception +'}{fmtMoney(i.exceedsMaxBy, cur)}{i.outcome === 'CAPPED' ? ')' : ''}</div>}</td>
            <td><WfBadge status={i.status} /></td>
            <td>{draft && can('compensation:propose') && <button className="btn-ghost btn-sm" onClick={() => { setErr(null); setEdit({ ...i, pctInput: String(i.proposedPct), ceiling: i.ceilingAction, justification: i.justification ?? '', note: i.note ?? '' }); }}>Edit</button>}</td>
          </tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No employees" /></div>}
        {items.data && <Pagination page={items.data.meta.page} totalPages={items.data.meta.totalPages} total={items.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Approval steps">{v.tasks.length ? <ul className="space-y-2 text-sm">{v.tasks.map((t: any, k: number) => <li key={k} className="flex items-center justify-between"><span>{t.step}<span className="block text-xs text-muted">{t.role ? humanStatus(t.role) : ''}{t.decidedBy ? ` · ${t.decidedBy}` : ''}{t.comment ? ` · “${t.comment}”` : ''}</span></span><WfBadge status={t.status} /></li>)}</ul> : <p className="text-sm text-muted">Not submitted yet.</p>}</Card>
        <Card title="Approval history"><ApprovalTrail items={v.approvals} /></Card>
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.employee.name} — review item` : ''} wide>{edit && <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4"><Field label="Increase %"><input className="input" type="number" step="0.1" value={edit.pctInput} onChange={(e) => setEdit({ ...edit, pctInput: e.target.value })} /></Field><Field label="Include"><select className="input" value={edit.sel ?? (edit.status === 'PROPOSED' ? 'PROPOSED' : 'EXCLUDED')} onChange={(e) => setEdit({ ...edit, sel: e.target.value })}><option value="PROPOSED">Included</option><option value="EXCLUDED">Excluded</option></select></Field><Field label="Note" className="sm:col-span-2"><input className="input" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field></div>
        <p className="text-sm text-muted">Recommended {edit.recommendedPct ?? '—'}%{edit.matrixMaxPct !== null ? ` · matrix maximum ${edit.matrixMaxPct}%` : ''}{v.maxPercentage !== null ? ` · review maximum ${v.maxPercentage}%` : ''}. Going beyond a maximum or including an ineligible employee needs override permission and a justification.</p>
        {edit.band && Number(edit.currentSalary) * (1 + Number(edit.pctInput) / 100) > edit.band.max && <CeilingDecision exceedsBy={Math.round((Number(edit.currentSalary) * (1 + Number(edit.pctInput) / 100) - edit.band.max) * 100) / 100} currency={cur} allowed={['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL']} value={edit.ceiling} onChange={(a) => setEdit({ ...edit, ceiling: a })} />}
        <AlertList alerts={edit.alerts} />
        <Field label="Justification"><textarea className="input min-h-16" value={edit.justification} onChange={(e) => setEdit({ ...edit, justification: e.target.value })} /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setEdit(null)}>Close</button><button className="btn-primary" disabled={patch.isPending} onClick={() => patch.mutate([{ id: edit.id, percentage: Number(edit.pctInput), ceilingAction: edit.ceiling ?? null, ...(edit.sel ? { status: edit.sel } : {}), note: edit.note || undefined, justification: edit.justification || undefined }])}>Save</button></div>
      </div>}</Modal>
    </div>
  );
}
