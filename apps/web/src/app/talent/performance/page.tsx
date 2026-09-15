'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, StatTile, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Performance /></AppShell>; }

function Performance() {
  const { can, principal } = useAuth();
  const qc = useQueryClient();
  const cycles = useQuery({ queryKey: ['perf', 'cycles'], queryFn: () => api<any[]>('/api/v1/people/performance/cycles') });
  const [cycleId, setCycleId] = useState<string>('');
  const cur = cycles.data?.find((c) => c.id === cycleId) ?? cycles.data?.[0];
  const [status, setStatus] = useState('');
  const reviews = useQuery({ queryKey: ['perf', 'reviews', cur?.id, status], queryFn: () => api<any[]>(`/api/v1/people/performance/reviews${qs({ cycleId: cur?.id, status })}`), enabled: !!cur });
  const [create, setCreate] = useState<any | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ['perf'] });
  const mCreate = useMutation({ mutationFn: () => api('/api/v1/people/performance/cycles', { method: 'POST', json: { ...create, year: Number(create.year), competencies: create.competencies.split(',').map((x: string) => x.trim()).filter(Boolean) } }), onSuccess: () => { setCreate(null); inv(); } });
  const launch = useMutation({ mutationFn: (id: string) => api(`/api/v1/people/performance/cycles/${id}/launch`, { method: 'POST', json: {} }), onSuccess: inv });
  const save = useMutation({ mutationFn: (body: any) => api(`/api/v1/people/performance/reviews/${open.id}`, { method: 'PATCH', json: body }), onSuccess: () => { setOpen(null); inv(); } });
  const rows = reviews.data ?? [];
  const isSelf = (r: any) => r.employeeId === principal?.employeeId;
  return (
    <>
      <PageHeader eyebrow="Talent" title="Performance" subtitle="Lightweight cycles: self review → manager review → HR finalisation. Ratings feed increment cycles." actions={<>{cycles.data && <select className="input sm:w-64" value={cur?.id ?? ''} onChange={(e) => setCycleId(e.target.value)}>{cycles.data.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.status}</option>)}</select>}{can('performance:write') && <button className="btn-primary" onClick={() => setCreate({ name: '', year: new Date().getFullYear(), periodStart: `${new Date().getFullYear()}-01-01`, periodEnd: `${new Date().getFullYear()}-12-31`, reviewDue: '', competencies: 'Quality of work, Safety, Teamwork, Reliability, Initiative' })}><Plus size={16} />Cycle</button>}</>} />
      {cur && <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Cycle" value={cur.name} hint={`${fmtDate(cur.periodStart)} → ${fmtDate(cur.periodEnd)}${cur.reviewDue ? ` · due ${fmtDate(cur.reviewDue)}` : ''}`} /><StatTile label="Reviews" value={cur.reviews} hint={cur.status === 'DRAFT' ? 'Launch to create reviews' : undefined} /><StatTile label="Finalised" value={cur.finalized} tone="success" /><StatTile label="Average rating" value={cur.avgRating ?? '—'} tone="accent" /></div>}
      {cur && cur.status === 'DRAFT' && can('performance:write') && <div className="mb-4"><Alert tone="info"><span className="flex flex-wrap items-center justify-between gap-2">This cycle is a draft. Launching creates one review per working employee with their manager as reviewer.<button className="btn-primary btn-sm" onClick={() => launch.mutate(cur.id)}><Rocket size={14} />Launch cycle</button></span></Alert></div>}
      <Card padded={false} title="Reviews" actions={<select className="input sm:w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['DRAFT', 'SELF_REVIEW', 'MANAGER_REVIEW', 'FINAL'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select>}>
        {reviews.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Reviewer</th><th>Self</th><th>Manager</th><th>Final</th><th>Goals</th><th>Status</th><th></th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td><Link href={`/employees/${r.employeeId}`} className="font-medium hover:underline">{r.employeeName}</Link><span className="block text-[11px] text-muted">{r.employeeNo}</span></td><td>{r.reviewer ?? '—'}</td><td>{r.selfRating ?? '—'}</td><td>{r.managerRating ?? '—'}</td><td className="font-semibold">{r.finalRating ?? '—'}</td><td>{r.goals?.length ?? 0}</td><td><Badge status={r.status} /></td><td><button className="btn-ghost btn-sm" onClick={() => setOpen(r)}>Open</button></td></tr>)}</tbody></table></div> : <EmptyState hint={cur ? 'No reviews in this cycle yet.' : 'Create a cycle to begin.'} />}
      </Card>
      <Modal open={!!create} onClose={() => setCreate(null)} title="New performance cycle">{create && <div className="grid gap-3 sm:grid-cols-2"><Field label="Name" className="sm:col-span-2"><input className="input" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></Field><Field label="Year"><input type="number" className="input" value={create.year} onChange={(e) => setCreate({ ...create, year: e.target.value })} /></Field><Field label="Review due"><input type="date" className="input" value={create.reviewDue} onChange={(e) => setCreate({ ...create, reviewDue: e.target.value })} /></Field><Field label="Period start"><input type="date" className="input" value={create.periodStart} onChange={(e) => setCreate({ ...create, periodStart: e.target.value })} /></Field><Field label="Period end"><input type="date" className="input" value={create.periodEnd} onChange={(e) => setCreate({ ...create, periodEnd: e.target.value })} /></Field><Field label="Competencies (comma separated)" className="sm:col-span-2"><input className="input" value={create.competencies} onChange={(e) => setCreate({ ...create, competencies: e.target.value })} /></Field><div className="flex justify-end sm:col-span-2"><button className="btn-primary" disabled={!create.name} onClick={() => mCreate.mutate()}>Create</button></div></div>}</Modal>
      <ReviewModal r={open} onClose={() => setOpen(null)} onSave={(b) => save.mutate(b)} canHr={can('performance:write')} self={open ? isSelf(open) : false} scale={cur?.ratingScale ?? []} competencies={cur?.competencies ?? []} />
    </>
  );
}

function ReviewModal({ r, onClose, onSave, canHr, self, scale, competencies }: { r: any; onClose: () => void; onSave: (b: any) => void; canHr: boolean; self: boolean; scale: { value: number; label: string }[]; competencies: string[] }) {
  const [f, setF] = useState<any>({});
  const [goal, setGoal] = useState({ title: '', kpi: '', target: '' });
  if (!r) return null;
  const v = (k: string) => f[k] ?? r[k] ?? '';
  const rating = (k: string, disabled: boolean) => <select className="input" disabled={disabled} value={v(k)} onChange={(e) => setF({ ...f, [k]: e.target.value === '' ? null : Number(e.target.value) })}><option value="">—</option>{(scale.length ? scale : [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))).map((s) => <option key={s.value} value={s.value}>{s.value} · {s.label}</option>)}</select>;
  const scores = { ...(r.competencyScores ?? {}), ...(f.competencyScores ?? {}) };
  const body = (x: any) => { const { addGoals, ...rest } = x; const out: any = { ...rest }; for (const k of ['selfRating', 'managerRating', 'finalRating']) if (out[k] === null || out[k] === '') delete out[k]; if (addGoals?.length) out.goals = [...(r.goals ?? []).map((g: any) => ({ title: g.title, kpi: g.kpi, target: g.target, weight: g.weight ?? 0 })), ...addGoals.map((g: any) => ({ title: g.title, kpi: g.kpi || null, target: g.target || null }))]; return out; };
  return (
    <Modal open={!!r} onClose={onClose} title={`${r.employeeName} · ${r.cycleName}`} wide>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Self review" subtitle={self ? 'Your section' : 'Employee section'}><div className="space-y-3"><Field label="Self rating">{rating('selfRating', !self && !canHr)}</Field><Field label="Comments"><textarea className="input min-h-24" disabled={!self && !canHr} value={v('selfComments')} onChange={(e) => setF({ ...f, selfComments: e.target.value })} /></Field></div></Card>
        <Card title="Manager review" subtitle="Reviewer / HR"><div className="space-y-3"><Field label="Manager rating">{rating('managerRating', self && !canHr)}</Field>{competencies.length > 0 && <Field label="Competencies"><div className="grid gap-2 sm:grid-cols-2">{competencies.map((c) => <label key={c} className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs"><span>{c}</span><input type="number" min={1} max={5} className="input h-7 w-16" disabled={self && !canHr} value={scores[c] ?? ''} onChange={(e) => setF({ ...f, competencyScores: { ...scores, [c]: Number(e.target.value) } })} /></label>)}</div></Field>}<Field label="Comments"><textarea className="input min-h-20" disabled={self && !canHr} value={v('managerComments')} onChange={(e) => setF({ ...f, managerComments: e.target.value })} /></Field><Field label="Development plan"><textarea className="input min-h-16" disabled={self && !canHr} value={v('developmentPlan')} onChange={(e) => setF({ ...f, developmentPlan: e.target.value })} /></Field></div></Card>
        <Card title="Goals" className="lg:col-span-2">{r.goals?.length ? <ul className="mb-3 space-y-1.5">{r.goals.map((g: any) => <li key={g.id} className="flex items-center justify-between rounded-lg bg-surface-2/60 px-3 py-2 text-sm"><span>{g.title}<span className="block text-[11px] text-muted">{[g.kpi, g.target].filter(Boolean).join(' · ')}</span></span><Badge status={g.status} /></li>)}</ul> : <p className="mb-3 text-sm text-muted">No goals yet.</p>}<div className="grid gap-2 sm:grid-cols-4"><input className="input" placeholder="Goal" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} /><input className="input" placeholder="KPI" value={goal.kpi} onChange={(e) => setGoal({ ...goal, kpi: e.target.value })} /><input className="input" placeholder="Target" value={goal.target} onChange={(e) => setGoal({ ...goal, target: e.target.value })} /><button className="btn-secondary" disabled={!goal.title} onClick={() => { setF({ ...f, addGoals: [...(f.addGoals ?? []), goal] }); setGoal({ title: '', kpi: '', target: '' }); }}>Add goal{f.addGoals?.length ? ` (${f.addGoals.length})` : ''}</button></div></Card>
      </div>
      <div className={cn('mt-4 flex flex-wrap items-center justify-end gap-2')}>{canHr && <Field label="Final rating (HR)">{rating('finalRating', false)}</Field>}<button className="btn-secondary" onClick={onClose}>Close</button><button className="btn-primary" onClick={() => onSave(body(f))}>Save</button>{canHr && <button className="btn-accent" onClick={() => onSave({ ...body(f), finalize: true })}>Finalise</button>}</div>
    </Modal>
  );
}
