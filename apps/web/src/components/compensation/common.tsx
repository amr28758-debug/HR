'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, Scissors, ShieldAlert, XCircle, ArrowUpRight } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Field, Modal, PageHeader, cn } from '@/components/ui';
import { fmtDateTime, fmtMoney, humanStatus, today } from '@/lib/format';

/** Compensation module chrome: shared header + section navigation, filtered by permission. */
const NAV: { href: string; label: string; perms: string[]; exact?: boolean }[] = [
  { href: '/compensation', label: 'Dashboard', perms: ['compensation:read'], exact: true },
  { href: '/compensation/employees', label: 'Employees', perms: ['salary:read'] },
  { href: '/compensation/salary-structure', label: 'Salary structure', perms: ['compensation:read'] },
  { href: '/compensation/reviews', label: 'Salary reviews', perms: ['compensation:read'] },
  { href: '/compensation/promotions', label: 'Promotions', perms: ['salary:read'] },
  { href: '/compensation/budgets', label: 'Budgets', perms: ['compensation:read', 'compensation:budget'] },
  { href: '/compensation/scenarios', label: 'Scenarios', perms: ['compensation:read'] },
  { href: '/compensation/alerts', label: 'Alerts', perms: ['compensation:read'] },
  { href: '/compensation/reports', label: 'Reports', perms: ['reports:compensation'] },
  { href: '/compensation/settings', label: 'Settings', perms: ['compensation:read', 'compensation:settings'] },
  { href: '/compensation/pay-items', label: 'Loans, bonuses & deductions', perms: ['compensation:read', 'salary:read:own'] },
];
export function CompNav() {
  const { can } = useAuth();
  const path = usePathname();
  return (
    <nav className="-mx-1 mb-6 flex gap-1 overflow-x-auto pb-1 rise" aria-label="Compensation sections">
      {NAV.filter((n) => can(...n.perms)).map((n) => { const active = n.exact ? path === n.href : path === n.href || path.startsWith(`${n.href}/`); return <Link key={n.href} href={n.href} className={cn('whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition', active ? 'bg-brand text-brand-fg shadow-sm' : 'text-muted hover:bg-surface-2 hover:text-fg')}>{n.label}</Link>; })}
    </nav>
  );
}
export function CompPage({ title, subtitle, actions, children, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; breadcrumb?: ReactNode }) {
  return <AppShell><PageHeader eyebrow="Compensation" title={title} subtitle={subtitle} actions={actions} breadcrumb={breadcrumb} /><CompNav />{children}</AppShell>;
}
export function Restricted({ perm }: { perm: string }) { return <Alert tone="danger">Your role does not include this area ({perm}). Salary information is restricted.</Alert>; }

// ── formatting ──
export const pct = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? '—' : `${n.toFixed(d)}%`);
export const CHANGE_TYPES: { key: string; label: string; hint: string }[] = [
  { key: 'ANNUAL_INCREMENT', label: 'Annual increment', hint: 'Once per employee per year (duplicate-protected)' },
  { key: 'MERIT_INCREASE', label: 'Merit increase', hint: 'Performance-based, checked against the merit matrix' },
  { key: 'MARKET_ADJUSTMENT', label: 'Market adjustment', hint: 'Align with market data' },
  { key: 'SALARY_CORRECTION', label: 'Salary correction', hint: 'Fix an incorrect salary (may decrease)' },
  { key: 'SPECIAL_ADJUSTMENT', label: 'Special adjustment', hint: 'Exceptional, one-off adjustment' },
  { key: 'DEMOTION_ADJUSTMENT', label: 'Demotion adjustment', hint: 'Decrease, optionally with a lower grade' },
  { key: 'GRADE_CHANGE', label: 'Grade change', hint: 'Move to another grade (with or without salary change)' },
];
export const typeLabel = (t: string) => ({ JOINING: 'Joining salary', PROMOTION: 'Promotion', SALARY_CHANGE: 'Salary change', ...Object.fromEntries(CHANGE_TYPES.map((c) => [c.key, c.label])) } as Record<string, string>)[t] ?? humanStatus(t);

// ── status ──
const COLOR_CLS: Record<string, string> = { GREEN: 'bg-success/10 text-success', YELLOW: 'bg-yellow-400/15 text-yellow-700 dark:text-yellow-300', ORANGE: 'bg-orange-500/10 text-orange-600 dark:text-orange-400', RED: 'bg-danger/10 text-danger', BLUE: 'bg-info/10 text-info', GREY: 'bg-surface-2 text-muted' };
const COLOR_DOT: Record<string, string> = { GREEN: '🟢', YELLOW: '🟡', ORANGE: '🟠', RED: '🔴', BLUE: '🔵', GREY: '⚪' };
export const COLOR_HEX: Record<string, string> = { GREEN: 'rgb(var(--success))', YELLOW: '#eab308', ORANGE: '#f97316', RED: 'rgb(var(--danger))', BLUE: 'rgb(var(--info))', GREY: 'rgb(var(--muted))' };
export function StatusPill({ status, className }: { status: { code: string; label: string; color: string } | null | undefined; className?: string }) {
  if (!status) return <span className="text-muted">—</span>;
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none', COLOR_CLS[status.color] ?? COLOR_CLS.GREY, className)}><span aria-hidden>{COLOR_DOT[status.color] ?? '⚪'}</span>{status.label}</span>;
}
const WF_TONE: Record<string, string> = { DRAFT: 'bg-surface-2 text-muted', SUBMITTED: 'bg-info/10 text-info', UNDER_REVIEW: 'bg-info/10 text-info', HR_APPROVED: 'bg-warning/10 text-warning', FINANCE_APPROVED: 'bg-warning/10 text-warning', MANAGEMENT_APPROVED: 'bg-warning/10 text-warning', APPROVED: 'bg-success/10 text-success', COMPLETED: 'bg-success/10 text-success', REJECTED: 'bg-danger/10 text-danger', FAILED: 'bg-danger/10 text-danger', CANCELLED: 'bg-surface-2 text-muted', PROPOSED: 'bg-info/10 text-info', EXCLUDED: 'bg-surface-2 text-muted', INELIGIBLE: 'bg-surface-2 text-muted', CALCULATED: 'bg-info/10 text-info', CONVERTED: 'bg-success/10 text-success', ACTIVE: 'bg-success/10 text-success', CLOSED: 'bg-surface-2 text-muted', OPEN: 'bg-warning/10 text-warning', ACKNOWLEDGED: 'bg-info/10 text-info', RESOLVED: 'bg-success/10 text-success' };
export function WfBadge({ status }: { status: string }) { return <span className={cn('inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none', WF_TONE[status] ?? 'bg-surface-2 text-muted')}>{humanStatus(status)}</span>; }
export function SeverityIcon({ severity }: { severity: string }) {
  return severity === 'CRITICAL' ? <AlertOctagon size={16} className="shrink-0 text-danger" /> : severity === 'WARNING' ? <AlertTriangle size={16} className="shrink-0 text-orange-500" /> : <Info size={16} className="shrink-0 text-info" />;
}

/** Visual band: min → max with the midpoint tick, current (●) and proposed (◆) markers; the area beyond the maximum is red. */
export function BandBar({ min, mid, max, current, proposed, currency = 'AED', compact }: { min: number; mid: number; max: number; current?: number | null; proposed?: number | null; currency?: string; compact?: boolean }) {
  const hi = Math.max(max, current ?? 0, proposed ?? 0) * 1.04, lo = Math.min(min, current ?? min, proposed ?? min) * 0.96, span = hi - lo || 1;
  const at = (v: number) => `${((v - lo) / span) * 100}%`;
  return (
    <div className={cn('select-none', compact ? 'py-1' : 'py-3')}>
      <div className="relative h-3 rounded-full bg-surface-2">
        <div className="absolute inset-y-0 rounded-full bg-gradient-to-r from-success/40 via-yellow-400/40 to-orange-500/50" style={{ left: at(min), width: `calc(${at(max)} - ${at(min)})` }} />
        {hi > max && <div className="absolute inset-y-0 rounded-e-full bg-danger/25" style={{ left: at(max), right: 0 }} />}
        <div className="absolute -top-1 h-5 w-0.5 bg-fg/40" style={{ left: at(mid) }} title={`Midpoint ${fmtMoney(mid, currency)}`} />
        {current !== null && current !== undefined && <div className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand shadow" style={{ left: at(current) }} title={`Current ${fmtMoney(current, currency)}`} />}
        {proposed !== null && proposed !== undefined && proposed !== current && <div className={cn('absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-white shadow', proposed > max ? 'bg-danger' : 'bg-accent')} style={{ left: at(proposed) }} title={`Proposed ${fmtMoney(proposed, currency)}`} />}
      </div>
      {!compact && <div className="relative mt-2 h-4 text-[10px] font-semibold text-muted">
        <span className="absolute -translate-x-1/2" style={{ left: at(min) }}>{fmtMoney(min, currency)}</span>
        <span className="absolute -translate-x-1/2" style={{ left: at(mid) }}>Mid</span>
        <span className="absolute -translate-x-1/2" style={{ left: at(max) }}>{fmtMoney(max, currency)}</span>
      </div>}
    </div>
  );
}

export interface CompAlertT { code: string; severity: string; message: string; amount?: number }
export function AlertList({ alerts }: { alerts: CompAlertT[] }) {
  if (!alerts?.length) return null;
  return <ul className="space-y-1.5">{alerts.map((a, i) => <li key={i} className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', a.severity === 'CRITICAL' ? 'bg-danger/10 text-danger' : a.severity === 'WARNING' ? 'bg-orange-500/10 text-orange-700 dark:text-orange-300' : 'bg-info/10 text-info')}><SeverityIcon severity={a.severity} /><span>{a.severity === 'CRITICAL' && a.code === 'EXCEEDS_BAND_MAX' ? <b>RED ALERT: </b> : null}{a.message}</span></li>)}</ul>;
}

/** The ceiling decision: shown whenever a proposal exceeds the band maximum. */
export function CeilingDecision({ exceedsBy, currency, allowed, value, onChange, onChangeGrade }: { exceedsBy: number; currency: string; allowed: string[]; value: string | null; onChange: (a: string | null) => void; onChangeGrade?: () => void }) {
  const opts: { key: string; label: string; icon: ReactNode; hint: string }[] = [
    { key: 'CAP_AT_MAX', label: 'Cap at maximum', icon: <Scissors size={15} />, hint: 'Increase stops at the band maximum' },
    { key: 'REQUEST_EXCEPTION', label: 'Request exception', icon: <ShieldAlert size={15} />, hint: 'Keep the amount; needs justification and extra approval' },
    { key: 'CANCEL', label: 'Cancel increase', icon: <XCircle size={15} />, hint: 'No increase this time' },
    { key: 'CHANGE_GRADE', label: 'Change grade / promotion', icon: <ArrowUpRight size={15} />, hint: 'Raise a promotion instead' },
  ];
  return (
    <div className="rounded-2xl border-2 border-danger/40 bg-danger/5 p-4">
      <p className="flex items-center gap-2 font-semibold text-danger"><AlertOctagon size={18} /> Proposed salary exceeds the maximum salary band by {fmtMoney(exceedsBy, currency)}.</p>
      <p className="mt-1 text-xs text-muted">The system never exceeds the ceiling silently — choose how to proceed:</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">{opts.filter((o) => allowed.includes(o.key)).map((o) => (
        <button key={o.key} type="button" onClick={() => (o.key === 'CHANGE_GRADE' && onChangeGrade ? onChangeGrade() : onChange(value === o.key ? null : o.key))} className={cn('flex items-start gap-2 rounded-xl border px-3 py-2 text-start text-sm transition', value === o.key ? 'border-brand bg-brand/10 ring-2 ring-brand/30' : 'border-border bg-surface hover:border-brand/40')}>
          <span className="mt-0.5 text-brand">{o.icon}</span><span><span className="block font-semibold">{o.label}</span><span className="text-[11px] text-muted">{o.hint}</span></span>
        </button>))}</div>
    </div>
  );
}

export function ApprovalTrail({ items }: { items: { id: number | string; at: string; user: string | null; role: string | null; action: string; step: string | null; comment: string | null; previousStatus: string | null; newStatus: string; entity?: string; reference?: string }[] }) {
  if (!items?.length) return <p className="text-sm text-muted">No approval activity yet.</p>;
  return (
    <ol className="relative space-y-3 border-s border-border ps-5">{items.map((a) => (
      <li key={`${a.id}-${a.at}`} className="relative">
        <span className={cn('absolute -start-[27px] top-1 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-surface', a.action.includes('REJECT') || a.action === 'FAIL' ? 'bg-danger' : a.action === 'COMPLETE' ? 'bg-success' : a.action.includes('APPROVE') ? 'bg-brand' : 'bg-muted')} />
        <div className="flex flex-wrap items-center gap-2 text-sm"><b>{humanStatus(a.action)}</b>{a.reference && <span className="text-xs text-muted">{a.reference}</span>}<span className="text-xs text-muted">{a.previousStatus ? `${humanStatus(a.previousStatus)} → ` : ''}{humanStatus(a.newStatus)}</span></div>
        <p className="text-xs text-muted">{a.user ?? 'System'}{a.role ? ` · ${humanStatus(a.role)}` : ''}{a.step ? ` · step ${a.step}` : ''} · {fmtDateTime(a.at)}</p>
        {a.comment && <p className="mt-0.5 text-sm">“{a.comment}”</p>}
      </li>))}</ol>
  );
}

function useDebounced<T>(v: T, ms = 350): T { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; }
export function Kpi({ label, value, tone }: { label: string; value: ReactNode; tone?: 'danger' | 'success' | 'warning' }) {
  return <div className="rounded-xl bg-surface-2 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p><p className={cn('mt-1 break-words text-base font-bold tabular-nums xl:text-lg', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success', tone === 'warning' && 'text-orange-600')}>{value}</p></div>;
}

/**
 * Salary change dialog — live calculation (band position before/after, ceiling decision, merit recommendation, duplicate and
 * budget checks) against POST /compensation/changes/calculate, then save as draft or submit for approval.
 */
export function SalaryChangeModal({ employeeId, initialType = 'ANNUAL_INCREMENT', preset, open, onClose, onDone, onPromote }: { employeeId: string; initialType?: string; preset?: { mode?: 'pct' | 'amt' | 'new'; value?: string; ceilingAction?: string | null }; open: boolean; onClose: () => void; onDone: (r: any) => void; onPromote?: () => void }) {
  const { can } = useAuth();
  const [f, setF] = useState<any>({ changeType: initialType, mode: 'pct', value: '', effectiveDate: `${new Date().getFullYear() + 1}-01-01`, reason: '', comments: '', justification: '', ceilingAction: null, newGradeId: '', overrideDuplicate: false, overrideBudget: false });
  useEffect(() => { if (open) setF((x: any) => ({ ...x, changeType: initialType, mode: preset?.mode ?? 'pct', value: preset?.value ?? '', ceilingAction: preset?.ceilingAction ?? null, justification: '' })); }, [open, initialType, preset]);
  const [err, setErr] = useState<string | null>(null);
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades'), enabled: open && ['GRADE_CHANGE', 'DEMOTION_ADJUSTMENT'].includes(f.changeType) });
  const body = useMemo(() => {
    const v = Number(f.value);
    if (f.value === '' || Number.isNaN(v)) return null;
    return { employeeId, changeType: f.changeType, ...(f.mode === 'pct' ? { increasePct: v } : f.mode === 'amt' ? { increaseAmount: v } : { newSalary: v }), effectiveDate: f.effectiveDate, ceilingAction: f.ceilingAction, ...(f.newGradeId ? { newGradeId: f.newGradeId } : {}), overrideDuplicate: f.overrideDuplicate || undefined, overrideBudget: f.overrideBudget || undefined, justification: f.justification || undefined };
  }, [employeeId, f]);
  const dBody = useDebounced(body);
  const calc = useQuery({ queryKey: ['comp', 'calc', dBody], queryFn: () => api<any>('/api/v1/compensation/changes/calculate', { method: 'POST', json: dBody }), enabled: open && !!dBody, retry: false });
  const m = useMutation({ mutationFn: (submit: boolean) => api<any>('/api/v1/compensation/changes', { method: 'POST', json: { ...body, reason: f.reason, comments: f.comments || undefined, submit } }), onSuccess: onDone, onError: (e: any) => setErr(e.message) });
  const c = calc.data; const k = c?.calculation; const cur = c?.employee?.currency ?? 'AED';
  const set = (key: string) => (e: any) => { setErr(null); setF((x: any) => ({ ...x, [key]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e })); };
  const needsDecision = k && k.exceedsMaxBy > 0 && k.proposedSalary > k.currentSalary;
  const blocked = !c || c.blockers.length > 0 || !f.reason || f.reason.length < 3 || (k?.requiresException && !f.justification) || (c.overrideReasons.length > 0 && !f.justification) || (c.duplicate && (!f.overrideDuplicate || !f.justification));
  return (
    <Modal open={open} onClose={onClose} title="Compensation change" wide>
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-3 lg:col-span-2">
          <Field label="Change type" hint={CHANGE_TYPES.find((t) => t.key === f.changeType)?.hint}><select className="input" value={f.changeType} onChange={set('changeType')}>{CHANGE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
          {['GRADE_CHANGE', 'DEMOTION_ADJUSTMENT'].includes(f.changeType) && <Field label={f.changeType === 'GRADE_CHANGE' ? 'New grade' : 'New grade (optional)'}><select className="input" value={f.newGradeId} onChange={set('newGradeId')}><option value="">— keep current —</option>{(grades.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name}{g.currentBand ? ` (${fmtMoney(g.currentBand.min)}–${fmtMoney(g.currentBand.max)})` : ''}</option>)}</select></Field>}
          <div className="grid grid-cols-5 gap-2">
            <Field label="Enter as" className="col-span-2"><select className="input" value={f.mode} onChange={set('mode')}><option value="pct">Percent</option><option value="amt">Amount</option><option value="new">New salary</option></select></Field>
            <Field label={f.mode === 'pct' ? 'Increase %' : f.mode === 'amt' ? `Increase (${cur})` : `New salary (${cur})`} className="col-span-3"><input className="input" type="number" step="0.01" value={f.value} onChange={set('value')} autoFocus placeholder={c?.recommendation ? `Recommended ${c.recommendation.recommendedPct}%` : ''} /></Field>
          </div>
          <Field label="Effective date"><input className="input" type="date" value={f.effectiveDate} onChange={set('effectiveDate')} min={today().slice(0, 4) + '-01-01'} /></Field>
          <Field label="Reason"><textarea className="input min-h-16" value={f.reason} onChange={set('reason')} placeholder="Why is this change needed?" /></Field>
          <Field label="Comments (optional)"><input className="input" value={f.comments} onChange={set('comments')} /></Field>
          {!!(k?.requiresException || c?.overrideReasons?.length || c?.duplicate || (c?.budgetViolations?.length && f.overrideBudget)) && <Field label="Justification (required)" hint="Recorded in the audit trail and shown to every approver"><textarea className="input min-h-16 border-danger/40" value={f.justification} onChange={set('justification')} /></Field>}
          {c?.duplicate && can('compensation:override') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.overrideDuplicate} onChange={set('overrideDuplicate')} /> Override duplicate protection (authorised)</label>}
          {c?.budgetViolations?.length > 0 && can('compensation:override') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.overrideBudget} onChange={set('overrideBudget')} /> Override the budget limit (authorised)</label>}
        </div>
        <div className="space-y-3 lg:col-span-3">
          {!body ? <div className="flex h-full min-h-40 items-center justify-center rounded-2xl border border-dashed text-sm text-muted">Enter an amount to see the calculation.</div>
            : calc.isError ? <Alert tone="danger">{(calc.error as Error).message}</Alert>
            : !c ? <div className="skeleton h-48 w-full rounded-2xl" />
            : <>
              <div className="grid grid-cols-3 gap-2">
                <Kpi label="Current" value={fmtMoney(k.currentSalary, cur)} />
                <Kpi label={k.outcome === 'CAPPED' ? 'New (capped)' : 'New salary'} value={fmtMoney(k.finalSalary, cur)} tone={k.finalSalary > (c.band?.max ?? Infinity) ? 'danger' : 'success'} />
                <Kpi label="Increase" value={`${k.finalIncreaseAmount >= 0 ? '+' : ''}${fmtMoney(k.finalIncreaseAmount, cur)} (${pct(k.finalIncreasePct, 2)})`} />
              </div>
              {c.band ? <div className="rounded-2xl border p-3"><div className="flex items-center justify-between text-xs text-muted"><span>Salary band {c.employee.gradeCode ?? ''} ({c.employee.salaryBasis.toLowerCase()} salary)</span><span>Compa {pct(k.before?.compaRatio)} → <b className="text-fg">{pct(k.after?.compaRatio)}</b> · Range {pct(k.before?.rangePenetration)} → <b className="text-fg">{pct(k.after?.rangePenetration)}</b></span></div><BandBar min={c.band.min} mid={c.band.mid} max={c.band.max} current={k.currentSalary} proposed={k.proposedSalary} currency={cur} /></div> : <Alert tone="warning">No active salary band for this grade — band compliance cannot be verified.</Alert>}
              {c.recommendation && <p className="rounded-xl bg-brand-soft/50 px-3 py-2 text-sm">Merit matrix ({c.employee.ratingLabel ?? c.recommendation.ratingCode}, compa {pct(c.employee.compaRatio)}): recommended <b>{c.recommendation.recommendedPct}%</b>, maximum {c.recommendation.maxPct}% <button type="button" className="link ms-2 text-xs" onClick={() => setF((x: any) => ({ ...x, mode: 'pct', value: String(c.recommendation.recommendedPct) }))}>Use</button></p>}
              {needsDecision && <CeilingDecision exceedsBy={k.exceedsMaxBy} currency={cur} allowed={c.allowedCeilingActions} value={f.ceilingAction} onChange={(a) => setF((x: any) => ({ ...x, ceilingAction: a }))} onChangeGrade={onPromote} />}
              <AlertList alerts={c.alerts.filter((a: any) => a.code !== 'EXCEEDS_BAND_MAX')} />
              <p className="text-xs text-muted">Annual cost impact: <b className="text-fg">{fmtMoney(c.annualCost, cur)}</b></p>
              {c.blockers.length > 0 && !needsDecision && <Alert tone="danger">{c.blockers[0]}</Alert>}
            </>}
          {err && <Alert tone="danger">{err}</Alert>}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t pt-4">
        <button className="btn-ghost" onClick={onClose}>Close</button>
        <button className="btn-secondary" disabled={!!blocked || m.isPending} onClick={() => m.mutate(false)}>Save draft</button>
        <button className="btn-primary" disabled={!!blocked || m.isPending} onClick={() => m.mutate(true)}><CheckCircle2 size={15} /> Submit for approval</button>
      </div>
    </Modal>
  );
}

/** Promotion dialog: target grade/title → recommended salary from the configured rule and the target band. */
export function PromotionModal({ employeeId, open, onClose, onDone }: { employeeId: string; open: boolean; onClose: () => void; onDone: (r: any) => void }) {
  const [f, setF] = useState<any>({ newGradeId: '', newDesignationId: '', newDepartmentId: '', newSalary: '', effectiveDate: `${new Date().getFullYear()}-${String(new Date().getMonth() + 2 > 12 ? 1 : new Date().getMonth() + 2).padStart(2, '0')}-01`, promotionReason: '', managerRecommendation: '', hrComments: '', justification: '' });
  const [err, setErr] = useState<string | null>(null);
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades'), enabled: open });
  const titles = useQuery({ queryKey: ['org', 'designations'], queryFn: () => api<any[]>('/api/v1/org/designations'), enabled: open });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments'), enabled: open });
  const body = f.newGradeId ? { employeeId, newGradeId: f.newGradeId, newDesignationId: f.newDesignationId || null, newDepartmentId: f.newDepartmentId || null, newSalary: f.newSalary === '' ? null : Number(f.newSalary), effectiveDate: f.effectiveDate, justification: f.justification || null } : null;
  const dBody = useDebounced(body);
  const calc = useQuery({ queryKey: ['comp', 'promo-calc', dBody], queryFn: () => api<any>('/api/v1/compensation/promotions/calculate', { method: 'POST', json: dBody }), enabled: open && !!dBody, retry: false });
  const m = useMutation({ mutationFn: (submit: boolean) => api<any>('/api/v1/compensation/promotions', { method: 'POST', json: { ...body, promotionReason: f.promotionReason, managerRecommendation: f.managerRecommendation || null, hrComments: f.hrComments || null, submit } }), onSuccess: onDone, onError: (e: any) => setErr(e.message) });
  const set = (key: string) => (e: any) => { setErr(null); setF((x: any) => ({ ...x, [key]: e.target.value })); };
  const c = calc.data; const cur = c?.employee?.currency ?? 'AED';
  const needJust = c && (c.requiresException || c.overrideReasons.length > 0);
  return (
    <Modal open={open} onClose={onClose} title="Promotion" wide>
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-3 lg:col-span-2">
          <Field label="New grade"><select className="input" value={f.newGradeId} onChange={set('newGradeId')}><option value="">Select…</option>{(grades.data ?? []).filter((g) => g.status === 'ACTIVE').map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name}{g.currentBand ? ` (${fmtMoney(g.currentBand.min)}–${fmtMoney(g.currentBand.max)})` : ''}</option>)}</select></Field>
          <Field label="New job title"><select className="input" value={f.newDesignationId} onChange={set('newDesignationId')}><option value="">— keep current —</option>{(titles.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
          <Field label="New department (optional)"><select className="input" value={f.newDepartmentId} onChange={set('newDepartmentId')}><option value="">— keep current —</option>{(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="Effective date"><input className="input" type="date" value={f.effectiveDate} onChange={set('effectiveDate')} /></Field><Field label={`New salary (${cur})`} hint="Empty = rule recommendation"><input className="input" type="number" value={f.newSalary} onChange={set('newSalary')} placeholder={c ? String(c.recommendedSalary) : ''} /></Field></div>
          <Field label="Promotion reason"><textarea className="input min-h-16" value={f.promotionReason} onChange={set('promotionReason')} /></Field>
          <Field label="Manager recommendation"><textarea className="input min-h-12" value={f.managerRecommendation} onChange={set('managerRecommendation')} /></Field>
          <Field label="HR comments"><input className="input" value={f.hrComments} onChange={set('hrComments')} /></Field>
          {needJust && <Field label="Justification (required)"><textarea className="input min-h-16 border-danger/40" value={f.justification} onChange={set('justification')} /></Field>}
        </div>
        <div className="space-y-3 lg:col-span-3">
          {!body ? <div className="flex h-full min-h-40 items-center justify-center rounded-2xl border border-dashed text-sm text-muted">Choose the target grade.</div>
            : calc.isError ? <Alert tone="danger">{(calc.error as Error).message}</Alert> : !c ? <div className="skeleton h-48 w-full rounded-2xl" /> : <>
              <div className="grid grid-cols-3 gap-2"><Kpi label="Current" value={fmtMoney(c.employee.currentSalary, cur)} /><Kpi label="Recommended" value={fmtMoney(c.recommendedSalary, cur)} /><Kpi label="New salary" value={`${fmtMoney(c.newSalary, cur)} (${c.increasePct >= 0 ? '+' : ''}${pct(c.increasePct, 2)})`} tone={c.requiresException ? 'danger' : 'success'} /></div>
              <p className="rounded-xl bg-brand-soft/50 px-3 py-2 text-sm">{c.employee.gradeCode ?? '—'} → <b>{c.targetGrade.code}</b> · {c.explanation}</p>
              {c.band ? <div className="rounded-2xl border p-3"><p className="text-xs text-muted">Target band {c.targetGrade.code} · compa {pct(c.position?.compaRatio)} · range {pct(c.position?.rangePenetration)}</p><BandBar min={c.band.min} mid={c.band.mid} max={c.band.max} current={c.employee.currentSalary} proposed={c.newSalary} currency={cur} /></div> : <Alert tone="warning">The target grade has no active band.</Alert>}
              <AlertList alerts={c.alerts} />
              {c.blockers.length > 0 && <Alert tone="danger">{c.blockers[0]}</Alert>}
            </>}
          {err && <Alert tone="danger">{err}</Alert>}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t pt-4">
        <button className="btn-ghost" onClick={onClose}>Close</button>
        <button className="btn-secondary" disabled={!c || c.blockers.length > 0 || f.promotionReason.length < 3 || (needJust && !f.justification) || m.isPending} onClick={() => m.mutate(false)}>Save draft</button>
        <button className="btn-primary" disabled={!c || c.blockers.length > 0 || f.promotionReason.length < 3 || (needJust && !f.justification) || m.isPending} onClick={() => m.mutate(true)}>Submit for approval</button>
      </div>
    </Modal>
  );
}

/** Download a CSV report (Excel opens it) through the authenticated API client. */
export async function downloadCsv(path: string, filename: string) {
  const csv = await api<string>(path, { raw: true });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}
