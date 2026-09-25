'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TrendingUp, ArrowUpRight, SlidersHorizontal, Wrench, History, Table2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Avatar, Card, EmptyState, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, fmtMoney, humanStatus } from '@/lib/format';
import { AlertList, ApprovalTrail, BandBar, CeilingDecision, CompPage, Kpi, PromotionModal, SalaryChangeModal, SeverityIcon, StatusPill, WfBadge, pct, typeLabel } from '@/components/compensation/common';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <CompPage title="Employee compensation" breadcrumb={<Link href="/compensation/employees" className="hover:text-brand">Employees</Link>}><EmployeeComp id={id} /></CompPage>;
}

function EmployeeComp({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['comp', 'employee', id], queryFn: () => api<any>(`/api/v1/compensation/employee/${id}`) });
  const [modal, setModal] = useState<{ kind: 'change' | 'promotion'; type?: string; preset?: any } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<'timeline' | 'table'>('timeline');
  const [what, setWhat] = useState('10');
  const whatBody = useMemo(() => (what && !Number.isNaN(Number(what)) ? { employeeId: id, changeType: 'ANNUAL_INCREMENT', increasePct: Number(what), effectiveDate: `${new Date().getFullYear() + 1}-01-01` } : null), [id, what]);
  const whatIf = useQuery({ queryKey: ['comp', 'whatif', whatBody], queryFn: () => api<any>('/api/v1/compensation/changes/calculate', { method: 'POST', json: whatBody }), enabled: !!whatBody && !!q.data && can('salary:read'), retry: false });
  if (q.isLoading) return <TableSkeleton rows={8} />;
  if (q.isError) return <Alert tone="danger">{(q.error as Error).message}</Alert>;
  const d = q.data; const p = d.profile; const cur = p.currency;
  const done = (r: any) => { setModal(null); setToast(`${r.changeNo ?? r.promotionNo} saved — ${humanStatus(r.status)}`); qc.invalidateQueries({ queryKey: ['comp'] }); };
  const k = whatIf.data?.calculation;
  const icons: Record<string, any> = { ANNUAL_INCREMENT: <TrendingUp size={16} />, PROMOTION: <ArrowUpRight size={16} />, MARKET_ADJUSTMENT: <SlidersHorizontal size={16} />, SALARY_CORRECTION: <Wrench size={16} /> };
  const open = (key: string, preset?: any) => setModal(key === 'PROMOTION' ? { kind: 'promotion' } : { kind: 'change', type: key, preset });
  return (
    <div className="space-y-6">
      {toast && <Alert tone="success">{toast}</Alert>}
      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={p.name} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Employee compensation</p>
            <h2 className="text-xl font-bold">{p.name}</h2>
            <p className="text-sm text-muted">{p.employeeNo} · {p.designation ?? '—'} · {p.department ?? '—'} · {p.site ?? '—'} · Grade <b className="text-fg">{p.gradeCode ?? 'missing'}</b>{p.gradeName && p.gradeName !== p.gradeCode ? ` (${p.gradeName})` : ''}</p>
            <p className="mt-1 text-xs text-muted">Joined {fmtDate(p.joiningDate)} · {humanStatus(p.employmentType)} · Rating {p.ratingLabel ? `${p.ratingLabel} (${p.ratingScore})` : '—'}</p>
          </div>
          <div className="text-end"><StatusPill status={p.bandStatus} className="text-sm" />{p.dueForReview && <p className="mt-1 text-xs text-success">🟢 Due for salary review</p>}</div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label={`Current salary (${p.salaryBasis.toLowerCase()})`} value={fmtMoney(p.currentSalary, cur)} />
          <Kpi label="Minimum" value={fmtMoney(p.band?.min ?? null, cur)} />
          <Kpi label="Midpoint" value={fmtMoney(p.band?.mid ?? null, cur)} />
          <Kpi label="Maximum" value={fmtMoney(p.band?.max ?? null, cur)} />
          <Kpi label="Compa-ratio" value={pct(p.compaRatio)} tone={p.compaRatio > 100 ? 'warning' : undefined} />
          <Kpi label="Range penetration" value={pct(p.rangePenetration)} tone={p.rangePenetration >= 100 ? 'danger' : p.rangePenetration >= 90 ? 'warning' : undefined} />
        </div>
        {p.band ? <div className="mt-4"><p className="text-xs text-muted">Salary band {fmtMoney(p.band.min, cur)} – {fmtMoney(p.band.max, cur)} · {fmtMoney(p.remainingToMax, cur)} to maximum · maximum possible increase {pct(p.maxPossibleIncreasePct, 2)}{p.aboveMaxBy > 0 && <b className="text-danger"> · above maximum by {fmtMoney(p.aboveMaxBy, cur)}</b>}{p.belowMinBy > 0 && <b className="text-info"> · below minimum by {fmtMoney(p.belowMinBy, cur)}</b>}</p><BandBar min={p.band.min} mid={p.band.mid} max={p.band.max} current={p.currentSalary} proposed={k?.proposedSalary} currency={cur} /></div>
          : <Alert tone="warning">{p.gradeCode ? `Grade ${p.gradeCode} has no active salary band.` : `No grade assigned${p.titleGradeCode ? ` — the job title maps to ${p.titleGradeCode}` : ''}.`}</Alert>}
        <div className="mt-4 grid gap-3 border-t pt-4 text-sm sm:grid-cols-3"><p><span className="text-muted">Last increase</span><br /><b>{fmtDate(p.lastIncreaseDate)}</b></p><p><span className="text-muted">Last promotion</span><br /><b>{fmtDate(p.lastPromotionDate)}</b></p><p><span className="text-muted">Last salary review</span><br /><b>{fmtDate(p.lastReviewDate)}</b></p></div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Compensation actions" subtitle="Every action goes through the approval workflow">
          <div className="grid grid-cols-2 gap-2">{d.actions.map((a: any) => <button key={a.key} disabled={!a.enabled} title={a.reason ?? ''} onClick={() => open(a.key)} className={cn('flex flex-col items-start gap-1 rounded-xl border px-3 py-3 text-start text-sm font-semibold transition', a.enabled ? 'hover:border-brand hover:bg-brand-soft/40' : 'cursor-not-allowed opacity-50')}><span className="text-brand">{icons[a.key]}</span>{a.label}{a.reason && <span className="text-[11px] font-normal text-muted">{a.reason}</span>}</button>)}</div>
        </Card>
        {can('salary:read') && <Card title="Quick check: proposed increase" subtitle="What would an annual increment do? Nothing is saved." className="xl:col-span-2">
          <div className="flex flex-wrap items-end gap-3"><label className="text-sm"><span className="mb-1 block text-xs font-semibold text-muted">Increase %</span><input className="input w-28" type="number" step="0.5" value={what} onChange={(e) => setWhat(e.target.value)} /></label>
            {k && <div className="grid flex-1 grid-cols-3 gap-2"><Kpi label="Proposed salary" value={fmtMoney(k.proposedSalary, cur)} tone={k.exceedsMaxBy > 0 ? 'danger' : 'success'} /><Kpi label="Compa after" value={pct(k.after?.compaRatio)} /><Kpi label="Range after" value={pct(k.after?.rangePenetration)} /></div>}
          </div>
          {whatIf.isError && <div className="mt-3"><Alert tone="warning">{(whatIf.error as Error).message}</Alert></div>}
          {k && k.exceedsMaxBy > 0 && <div className="mt-3"><CeilingDecision exceedsBy={k.exceedsMaxBy} currency={cur} allowed={whatIf.data.allowedCeilingActions} value={null} onChange={(a) => { if (a && a !== 'CANCEL') open('ANNUAL_INCREMENT', { mode: 'pct', value: what, ceilingAction: a }); else setWhat(''); }} onChangeGrade={() => open('PROMOTION')} /></div>}
          {k && k.exceedsMaxBy === 0 && <div className="mt-3 flex items-center justify-between gap-2"><AlertList alerts={whatIf.data.alerts} /><button className="btn-primary btn-sm" onClick={() => open('ANNUAL_INCREMENT', { mode: 'pct', value: what })}>Raise this increment</button></div>}
        </Card>}
      </div>

      <Card title="Salary history" actions={<div className="flex gap-1"><button className={cn('btn-sm', view === 'timeline' ? 'btn-secondary' : 'btn-ghost')} onClick={() => setView('timeline')}><History size={14} /> Timeline</button><button className={cn('btn-sm', view === 'table' ? 'btn-secondary' : 'btn-ghost')} onClick={() => setView('table')}><Table2 size={14} /> Table</button></div>} padded={view === 'timeline'}>
        {!d.history.length ? <EmptyState title="No salary structure yet" /> : view === 'timeline' ? <ol className="relative space-y-4 border-s-2 border-brand/20 ps-6">{d.history.map((h: any) => <li key={h.structureId} className="relative"><span className="absolute -start-[33px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand text-[9px] font-bold text-white ring-4 ring-surface">{String(h.year).slice(2)}</span>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{h.year} · {fmtDate(h.date)}</p>
          <p className="font-semibold">{typeLabel(h.type)}{h.increasePct !== null && h.increasePct !== 0 && <span className={cn('ms-2 text-sm', h.increasePct > 0 ? 'text-success' : 'text-danger')}>{h.increasePct > 0 ? '+' : ''}{h.increasePct}%</span>}</p>
          <p className="text-sm">{h.previousSalary !== null ? <>{fmtMoney(h.previousSalary, h.currency)} → </> : null}<b>{fmtMoney(h.salary, h.currency)}</b> <span className="text-xs text-muted">(gross {fmtMoney(h.gross, h.currency)})</span></p>
          <p className="text-xs text-muted">{h.reason ?? ''}{h.changeNo ? ` · ${h.changeNo}` : ''}{h.approvedBy ? ` · approved by ${h.approvedBy}` : ''}</p></li>)}</ol>
          : <div className="overflow-x-auto"><table className="data"><thead><tr><th>Effective</th><th>Type</th><th>Previous</th><th>Change</th><th>New salary</th><th>Basic</th><th>Gross</th><th>Reference</th><th>Approved by</th></tr></thead><tbody>{d.history.map((h: any) => <tr key={h.structureId}><td>{fmtDate(h.date)}</td><td>{typeLabel(h.type)}</td><td className="tabular-nums">{fmtMoney(h.previousSalary, h.currency)}</td><td className="tabular-nums">{h.increaseAmount === null ? '—' : `${h.increaseAmount >= 0 ? '+' : ''}${fmtMoney(h.increaseAmount, h.currency)} (${pct(h.increasePct, 2)})`}</td><td className="font-semibold tabular-nums">{fmtMoney(h.salary, h.currency)}</td><td className="tabular-nums">{fmtMoney(h.basic, h.currency)}</td><td className="tabular-nums">{fmtMoney(h.gross, h.currency)}</td><td className="text-xs">{h.changeNo ?? '—'}</td><td className="text-xs">{h.approvedBy ?? '—'}</td></tr>)}</tbody></table></div>}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Compensation changes" padded={false}>{d.changes.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Reference</th><th>Type</th><th>Change</th><th>Effective</th><th>Status</th></tr></thead><tbody>{d.changes.map((c: any) => <tr key={c.id}><td><Link className="link" href={`/compensation/changes/${c.id}`}>{c.changeNo}</Link>{c.outsideWorkflow && <div className="text-[11px] text-orange-600">outside workflow</div>}</td><td>{typeLabel(c.changeType)}</td><td className="tabular-nums">{fmtMoney(c.oldSalary, c.currency)} → {fmtMoney(c.newSalary, c.currency)}<div className="text-xs text-muted">{c.increasePct > 0 ? '+' : ''}{c.increasePct}%</div></td><td>{fmtDate(c.effectiveDate)}</td><td><WfBadge status={c.status} /></td></tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No changes yet" /></div>}</Card>
        <Card title="Approval history"><ApprovalTrail items={d.approvals} /></Card>
      </div>
      <Card title="Alerts">{d.alerts.length ? <ul className="space-y-2">{d.alerts.map((a: any) => <li key={a.id} className="flex items-start gap-2 text-sm"><SeverityIcon severity={a.severity} /><span>{a.message}</span><span className="ms-auto"><WfBadge status={a.status} /></span></li>)}</ul> : <p className="text-sm text-muted">No open alerts. Alerts are refreshed daily and on demand from the Alerts page.</p>}</Card>

      {modal?.kind === 'change' && <SalaryChangeModal employeeId={id} initialType={modal.type} preset={modal.preset} open onClose={() => setModal(null)} onDone={done} onPromote={() => setModal({ kind: 'promotion' })} />}
      {modal?.kind === 'promotion' && <PromotionModal employeeId={id} open onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}
