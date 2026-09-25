'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, Field, Modal, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtMoney } from '@/lib/format';
import { CompPage, WfBadge, pct } from '@/components/compensation/common';

export default function Page() { return <Suspense><ReviewsPage /></Suspense>; }
function ReviewsPage() {
  const { can } = useAuth();
  const sp = useSearchParams();
  const [open, setOpen] = useState(sp.get('new') === '1');
  return <CompPage title="Annual salary reviews" subtitle="Review cycles identify eligible employees, recommend increases from the merit matrix, enforce the band ceiling and go through approval as a whole." actions={can('compensation:propose') && <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={15} /> New review</button>}><Reviews /><NewReview open={open} onClose={() => setOpen(false)} /></CompPage>;
}

function Reviews() {
  const q = useQuery({ queryKey: ['comp', 'reviews'], queryFn: () => api<any[]>('/api/v1/compensation/reviews') });
  return (
    <Card padded={false}>
      {q.isLoading ? <TableSkeleton /> : q.data?.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Review</th><th>Effective</th><th>Default / max</th><th>Employees</th><th>Annual cost</th><th>Budget</th><th>Attention</th><th>Status</th></tr></thead><tbody>{q.data.map((r) => <tr key={r.id}>
        <td><Link href={`/compensation/reviews/${r.id}`} className="font-medium hover:text-brand">{r.name}</Link><div className="text-xs text-muted">{r.recommendationMethod === 'MERIT_MATRIX' ? 'Merit matrix' : 'Default %'}{r.reviewPeriodStart ? ` · period ${fmtDate(r.reviewPeriodStart)} – ${fmtDate(r.reviewPeriodEnd)}` : ''}</div></td>
        <td>{fmtDate(r.effectiveDate)}</td><td>{r.defaultPercentage}% / {r.maxPercentage === null ? '—' : `${r.maxPercentage}%`}</td>
        <td>{r.summary.proposed} <span className="text-xs text-muted">of {r.summary.items}</span></td>
        <td className="tabular-nums">{fmtMoney(r.summary.annualIncrease, r.currency)}</td>
        <td className="tabular-nums">{r.budgetAmount === null ? '—' : <>{fmtMoney(r.budgetAmount, r.currency)}<div className={r.summary.remaining < 0 ? 'text-xs text-danger' : 'text-xs text-muted'}>{pct(r.summary.utilizationPct)} used</div></>}</td>
        <td className="text-xs">{r.summary.actionRequired > 0 && <div className="text-danger">🔴 {r.summary.actionRequired} ceiling decisions</div>}{r.summary.exceptions > 0 && <div className="text-orange-600">🟠 {r.summary.exceptions} exceptions</div>}{r.summary.failed > 0 && <div className="text-danger">{r.summary.failed} failed</div>}</td>
        <td><WfBadge status={r.status} /></td>
      </tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No salary reviews yet" hint="Create the annual review cycle — e.g. “2027 Annual Salary Review”." /></div>}
    </Card>
  );
}

function NewReview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const y = new Date().getFullYear() + 1;
  const [f, setF] = useState<any>({ name: `${y} Annual Salary Review`, year: y, effectiveDate: `${y}-01-01`, reviewPeriodStart: `${y - 1}-01-01`, reviewPeriodEnd: `${y - 1}-12-31`, defaultPercentage: 5, maxPercentage: 10, budgetAmount: '', recommendationMethod: 'MERIT_MATRIX', defaultCeilingAction: '', minServiceMonths: 6, minMonthsSinceLastIncrease: 11, minRatingScore: '', excludeDisciplinaryWithinMonths: 12, excludeOnProbation: true, statuses: ['ACTIVE', 'CONFIRMED', 'PROBATION', 'TRANSFERRED', 'PROMOTED'], departmentIds: [], gradeIds: [], siteIds: [] });
  const [err, setErr] = useState<string | null>(null);
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments'), enabled: open });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites'), enabled: open });
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades'), enabled: open });
  const n = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
  const m = useMutation({ mutationFn: () => api<any>('/api/v1/compensation/reviews', { method: 'POST', json: {
    name: f.name, year: Number(f.year), effectiveDate: f.effectiveDate, reviewPeriodStart: f.reviewPeriodStart || null, reviewPeriodEnd: f.reviewPeriodEnd || null, defaultPercentage: Number(f.defaultPercentage), maxPercentage: n(f.maxPercentage), budgetAmount: n(f.budgetAmount), recommendationMethod: f.recommendationMethod, defaultCeilingAction: f.defaultCeilingAction || null,
    eligibilityRules: { minServiceMonths: n(f.minServiceMonths), minMonthsSinceLastIncrease: n(f.minMonthsSinceLastIncrease), minRatingScore: n(f.minRatingScore), excludeDisciplinaryWithinMonths: n(f.excludeDisciplinaryWithinMonths), excludeOnProbation: f.excludeOnProbation, employmentStatuses: f.statuses, departmentIds: f.departmentIds.length ? f.departmentIds : null, gradeIds: f.gradeIds.length ? f.gradeIds : null, siteIds: f.siteIds.length ? f.siteIds : null },
    populate: true } }), onSuccess: (r) => router.push(`/compensation/reviews/${r.id}`), onError: (e: any) => setErr(e.message) });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const multi = (k: string, items: { id: string; label: string }[] = []) => <select multiple className="input h-24" value={f[k]} onChange={(e) => setF({ ...f, [k]: Array.from(e.target.selectedOptions).map((o) => o.value) })}>{items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select>;
  return (
    <Modal open={open} onClose={onClose} title="New salary review cycle" wide>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Cycle name" className="sm:col-span-2"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Year"><input className="input" type="number" value={f.year} onChange={set('year')} /></Field>
        <Field label="Effective date"><input className="input" type="date" value={f.effectiveDate} onChange={set('effectiveDate')} /></Field>
        <Field label="Review period from"><input className="input" type="date" value={f.reviewPeriodStart} onChange={set('reviewPeriodStart')} /></Field>
        <Field label="Review period to"><input className="input" type="date" value={f.reviewPeriodEnd} onChange={set('reviewPeriodEnd')} /></Field>
        <Field label="Default increase %"><input className="input" type="number" step="0.1" value={f.defaultPercentage} onChange={set('defaultPercentage')} /></Field>
        <Field label="Maximum increase %"><input className="input" type="number" step="0.1" value={f.maxPercentage} onChange={set('maxPercentage')} /></Field>
        <Field label="Budget (annual cost)"><input className="input" type="number" value={f.budgetAmount} onChange={set('budgetAmount')} placeholder="optional" /></Field>
        <Field label="Recommendation"><select className="input" value={f.recommendationMethod} onChange={set('recommendationMethod')}><option value="MERIT_MATRIX">Merit matrix (rating × compa)</option><option value="DEFAULT_PERCENT">Default % for everyone</option></select></Field>
        <Field label="Above-maximum handling" className="sm:col-span-2"><select className="input" value={f.defaultCeilingAction} onChange={set('defaultCeilingAction')}><option value="">Decide per employee (flagged)</option><option value="CAP_AT_MAX">Cap at maximum</option><option value="REQUEST_EXCEPTION">Request exception</option><option value="CANCEL">Cancel increase</option></select></Field>
      </div>
      <p className="mt-5 mb-2 text-sm font-semibold">Eligibility rules</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Min. service (months)"><input className="input" type="number" value={f.minServiceMonths} onChange={set('minServiceMonths')} /></Field>
        <Field label="Months since last increase"><input className="input" type="number" value={f.minMonthsSinceLastIncrease} onChange={set('minMonthsSinceLastIncrease')} /></Field>
        <Field label="Min. performance score" hint="Empty = rating not required"><input className="input" type="number" step="0.1" value={f.minRatingScore} onChange={set('minRatingScore')} /></Field>
        <Field label="No disciplinary within (months)"><input className="input" type="number" value={f.excludeDisciplinaryWithinMonths} onChange={set('excludeDisciplinaryWithinMonths')} /></Field>
        <Field label="Departments (none = all)">{multi('departmentIds', depts.data?.map((d) => ({ id: d.id, label: d.name })))}</Field>
        <Field label="Grades (none = all)">{multi('gradeIds', grades.data?.map((g) => ({ id: g.id, label: g.code })))}</Field>
        <Field label="Sites (none = all)">{multi('siteIds', sites.data?.map((s) => ({ id: s.id, label: s.name })))}</Field>
        <Field label="Employment status">{multi('statuses', ['ACTIVE', 'CONFIRMED', 'PROBATION', 'TRANSFERRED', 'PROMOTED'].map((s) => ({ id: s, label: s.toLowerCase() })))}</Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-4"><input type="checkbox" checked={f.excludeOnProbation} onChange={set('excludeOnProbation')} /> Exclude employees on probation</label>
      </div>
      {err && <div className="mt-3"><Alert tone="danger">{err}</Alert></div>}
      <div className="mt-5 flex justify-end gap-2 border-t pt-4"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending || !f.name} onClick={() => m.mutate()}>{m.isPending ? 'Identifying eligible employees…' : 'Create & identify eligible employees'}</button></div>
    </Modal>
  );
}
