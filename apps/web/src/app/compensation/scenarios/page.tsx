'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, GitCompare } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, Field, Modal, TableSkeleton, cn } from '@/components/ui';
import { BarsChart, COLORS } from '@/components/charts';
import { fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { CompPage, WfBadge, pct } from '@/components/compensation/common';

const METHODS: Record<string, string> = { FLAT_PERCENT: 'Same % for everyone', MERIT_MATRIX: 'Performance-based (merit matrix)', PROMOTION_PLUS_INCREMENT: 'Promotion + annual increment', BUDGET_LIMITED: 'Budget limited' };
export default function Page() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  return <CompPage title="Scenario planning" subtitle="Model compensation scenarios without touching any salary. Compare them side by side, then turn the chosen one into a salary review for approval." actions={can('compensation:propose') && <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={15} /> New scenario</button>}><Scenarios /><NewScenario open={open} onClose={() => setOpen(false)} /></CompPage>;
}

function Scenarios() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({ queryKey: ['comp', 'scenarios'], queryFn: () => api<any[]>('/api/v1/compensation/scenarios') });
  const [cmp, setCmp] = useState<string[]>([]);
  const [detail, setDetail] = useState<any | null>(null);
  const [convert, setConvert] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const items = useQuery({ queryKey: ['comp', 'scenario-items', detail?.id], queryFn: () => api<Paginated<any>>(`/api/v1/compensation/scenarios/${detail.id}/items?pageSize=200&attention=true`), enabled: !!detail && can('salary:read') });
  const recalc = useMutation({ mutationFn: (id: string) => api(`/api/v1/compensation/scenarios/${id}/calculate`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp'] }) });
  const conv = useMutation({ mutationFn: () => api<any>(`/api/v1/compensation/scenarios/${convert.id}/convert`, { method: 'POST', json: { reviewName: convert.reviewName, effectiveDate: convert.effectiveDate } }), onSuccess: (r) => router.push(`/compensation/reviews/${r.reviewId}`), onError: (e: any) => setErr(e.message) });
  const rows = q.data ?? [];
  const selected = rows.filter((r) => cmp.includes(r.id) && r.summary);
  const metrics: [string, (s: any) => string][] = [['Employees', (s) => `${fmtNum(s.included)} / ${fmtNum(s.employees)}`], ['Current payroll', (s) => fmtMoney(s.currentPayroll)], ['Proposed payroll', (s) => fmtMoney(s.proposedPayroll)], ['Monthly increase', (s) => fmtMoney(s.monthlyIncrease)], ['Annual increase', (s) => fmtMoney(s.annualIncrease)], ['Average increase', (s) => pct(s.averageIncreasePct, 2)], ['Budget impact', (s) => (s.budget ? `${pct(s.budgetImpactPct)} of ${fmtMoney(s.budget)}` : '—')], ['Above maximum', (s) => fmtNum(s.aboveMax)], ['Capped at maximum', (s) => fmtNum(s.capped)], ['Requiring exception', (s) => fmtNum(s.requiringException)]];
  return (
    <div className="space-y-6">
      <Card padded={false} title="Scenarios" subtitle="Tick up to four to compare" actions={cmp.length > 1 && <span className="flex items-center gap-1 text-sm text-muted"><GitCompare size={14} /> Comparing {cmp.length}</span>}>
        {q.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th /><th>Scenario</th><th>Method</th><th>Employees</th><th>Monthly increase</th><th>Annual increase</th><th>Above max</th><th>Exceptions</th><th>Status</th><th /></tr></thead><tbody>{rows.map((r) => <tr key={r.id}>
          <td><input type="checkbox" checked={cmp.includes(r.id)} onChange={(e) => setCmp(e.target.checked ? [...cmp, r.id].slice(-4) : cmp.filter((x) => x !== r.id))} /></td>
          <td><button className="font-medium hover:text-brand" onClick={() => setDetail(r)}>{r.name}</button><div className="text-xs text-muted">FY {r.fiscalYear}{r.calculatedAt ? ` · calculated ${fmtDateTime(r.calculatedAt)}` : ''}</div></td>
          <td className="text-sm">{METHODS[r.method]}</td><td>{r.summary?.included ?? '—'}</td><td className="tabular-nums">{fmtMoney(r.summary?.monthlyIncrease)}</td><td className="tabular-nums">{fmtMoney(r.summary?.annualIncrease)}</td>
          <td className={cn(r.summary?.aboveMax && 'text-danger')}>{r.summary?.aboveMax ?? '—'}</td><td>{r.summary?.requiringException ?? '—'}</td><td><WfBadge status={r.status} /></td>
          <td className="whitespace-nowrap text-end">{can('compensation:propose') && <><button className="btn-ghost btn-sm" title="Recalculate" onClick={() => recalc.mutate(r.id)}><RefreshCw size={14} /></button>{r.status !== 'CONVERTED' && <button className="btn-secondary btn-sm" onClick={() => { setErr(null); setConvert({ ...r, reviewName: `${r.fiscalYear} Annual Salary Review`, effectiveDate: `${r.fiscalYear}-01-01` }); }}>Use for review</button>}</>}</td>
        </tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No scenarios yet" hint="Try “10% for everyone” against “performance-based” and a budget-limited variant." /></div>}
      </Card>
      {selected.length > 1 && <Card title="Comparison" padded={false}>
        <div className="overflow-x-auto"><table className="data"><thead><tr><th>Metric</th>{selected.map((s) => <th key={s.id}>{s.name}</th>)}</tr></thead><tbody>{metrics.map(([l, fn]) => <tr key={l}><td className="font-medium">{l}</td>{selected.map((s) => <td key={s.id} className="tabular-nums">{fn(s.summary)}</td>)}</tr>)}</tbody></table></div>
        <div className="p-5"><BarsChart data={selected.map((s) => ({ name: s.name.slice(0, 24), annual: s.summary.annualIncrease, budget: s.summary.budget ?? 0 }))} xKey="name" series={[{ key: 'annual', label: 'Annual increase', color: COLORS.brand }, { key: 'budget', label: 'Budget', color: COLORS.muted }]} /></div>
      </Card>}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.name ?? ''} wide>{detail && <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-4">{metrics.slice(1, 9).map(([l, fn]) => <div key={l} className="rounded-xl bg-surface-2 p-3"><p className="text-[10px] font-semibold uppercase text-muted">{l}</p><p className="font-bold tabular-nums">{detail.summary ? fn(detail.summary) : '—'}</p></div>)}</div>
        <p className="text-sm font-semibold">Employees needing attention (above max / capped / exception)</p>
        {items.isLoading ? <TableSkeleton rows={3} /> : items.data?.data.length ? <div className="max-h-96 overflow-auto"><table className="data"><thead><tr><th>Employee</th><th>Grade</th><th>Current</th><th>%</th><th>Proposed</th><th>Final</th><th>Flag</th></tr></thead><tbody>{items.data.data.map((i) => <tr key={i.employeeId}><td>{i.name}<div className="text-xs text-muted">{i.employeeNo}</div></td><td>{i.grade}</td><td className="tabular-nums">{fmtMoney(i.currentSalary)}</td><td>{pct(i.increasePct, 2)}</td><td className="tabular-nums">{fmtMoney(i.proposedSalary)}</td><td className="tabular-nums">{fmtMoney(i.finalSalary)}</td><td className="text-xs">{i.capped ? 'capped' : i.requiresException ? <span className="text-orange-600">exception</span> : ''}{i.exceedsMaxBy > 0 && <div className="text-danger">+{fmtMoney(i.exceedsMaxBy)} over</div>}</td></tr>)}</tbody></table></div> : <p className="text-sm text-muted">No employee exceeds the band maximum in this scenario.</p>}
      </div>}</Modal>
      <Modal open={!!convert} onClose={() => setConvert(null)} title="Create a salary review from this scenario">{convert && <div className="space-y-3">
        <Alert tone="info">A DRAFT review is created with each employee's scenario percentage. Nothing changes until the review is submitted and approved. Promotions in the scenario are raised separately.</Alert>
        <Field label="Review name"><input className="input" value={convert.reviewName} onChange={(e) => setConvert({ ...convert, reviewName: e.target.value })} /></Field>
        <Field label="Effective date"><input className="input" type="date" value={convert.effectiveDate} onChange={(e) => setConvert({ ...convert, effectiveDate: e.target.value })} /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setConvert(null)}>Cancel</button><button className="btn-primary" disabled={conv.isPending} onClick={() => conv.mutate()}>Create review</button></div>
      </div>}</Modal>
    </div>
  );
}

function NewScenario({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const y = new Date().getFullYear() + 1;
  const [f, setF] = useState<any>({ name: '', fiscalYear: y, method: 'FLAT_PERCENT', flatPct: 10, baseMethod: 'FLAT_PERCENT', budgetLimit: '', ceilingAction: 'CAP_AT_MAX', maxIncreasePct: '', minServiceMonths: 6, departmentIds: [] });
  const [err, setErr] = useState<string | null>(null);
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments'), enabled: open });
  const m = useMutation({ mutationFn: () => api('/api/v1/compensation/scenarios', { method: 'POST', json: { name: f.name, fiscalYear: Number(f.fiscalYear), method: f.method, config: { flatPct: f.flatPct === '' ? null : Number(f.flatPct), baseMethod: f.baseMethod, budgetLimit: f.budgetLimit === '' ? null : Number(f.budgetLimit), ceilingAction: f.ceilingAction, maxIncreasePct: f.maxIncreasePct === '' ? null : Number(f.maxIncreasePct), eligibilityRules: { minServiceMonths: f.minServiceMonths === '' ? null : Number(f.minServiceMonths) } }, filters: { departmentIds: f.departmentIds.length ? f.departmentIds : undefined } } }), onSuccess: () => { onClose(); qc.invalidateQueries({ queryKey: ['comp'] }); }, onError: (e: any) => setErr(e.message) });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const usesFlat = f.method === 'FLAT_PERCENT' || (f.method !== 'MERIT_MATRIX' && f.baseMethod === 'FLAT_PERCENT');
  return (
    <Modal open={open} onClose={onClose} title="New scenario" wide>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-2"><input className="input" value={f.name} onChange={set('name')} placeholder="e.g. Scenario A — 10% for everyone" /></Field>
        <Field label="Fiscal year"><input className="input" type="number" value={f.fiscalYear} onChange={set('fiscalYear')} /></Field>
        <Field label="Method" className="sm:col-span-2"><select className="input" value={f.method} onChange={set('method')}>{Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {(f.method === 'BUDGET_LIMITED' || f.method === 'PROMOTION_PLUS_INCREMENT') && <Field label="Base recommendation"><select className="input" value={f.baseMethod} onChange={set('baseMethod')}><option value="FLAT_PERCENT">Same %</option><option value="MERIT_MATRIX">Merit matrix</option></select></Field>}
        {usesFlat && <Field label="Increase %"><input className="input" type="number" step="0.1" value={f.flatPct} onChange={set('flatPct')} /></Field>}
        {f.method === 'BUDGET_LIMITED' && <Field label="Budget limit (annual)"><input className="input" type="number" value={f.budgetLimit} onChange={set('budgetLimit')} /></Field>}
        <Field label="Above band maximum"><select className="input" value={f.ceilingAction} onChange={set('ceilingAction')}><option value="CAP_AT_MAX">Cap at maximum</option><option value="REQUEST_EXCEPTION">Keep & count as exception</option></select></Field>
        <Field label="Max increase % (optional)"><input className="input" type="number" value={f.maxIncreasePct} onChange={set('maxIncreasePct')} /></Field>
        <Field label="Min. service months"><input className="input" type="number" value={f.minServiceMonths} onChange={set('minServiceMonths')} /></Field>
        <Field label="Departments (none = all)" className="sm:col-span-3"><select multiple className="input h-24" value={f.departmentIds} onChange={(e) => setF({ ...f, departmentIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      </div>
      {f.method === 'PROMOTION_PLUS_INCREMENT' && <p className="mt-2 text-xs text-muted">Promotions for a scenario are listed via the API (config.promotions); employees without one receive the base increment.</p>}
      {err && <div className="mt-3"><Alert tone="danger">{err}</Alert></div>}
      <div className="mt-5 flex justify-end gap-2 border-t pt-4"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Calculating…' : 'Create & calculate'}</button></div>
    </Modal>
  );
}
