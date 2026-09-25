'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, Field, Modal, Pagination, Tabs, TableSkeleton, cn } from '@/components/ui';
import { fmtDateTime, humanStatus } from '@/lib/format';
import { CompPage, StatusPill } from '@/components/compensation/common';

type Tab = 'policy' | 'ratings' | 'matrix' | 'promotion' | 'compression' | 'workflows' | 'audit';
export default function Page() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('policy');
  const tabs = [{ key: 'policy' as Tab, label: 'Policy & thresholds' }, { key: 'ratings' as Tab, label: 'Performance ratings' }, { key: 'matrix' as Tab, label: 'Merit matrix' }, { key: 'promotion' as Tab, label: 'Promotion rules' }, { key: 'compression' as Tab, label: 'Compression rules' }, { key: 'workflows' as Tab, label: 'Approval chains' }, ...(can('audit:read', 'reports:compensation') ? [{ key: 'audit' as Tab, label: 'Audit trail' }] : [])];
  return <CompPage title="Compensation settings" subtitle="Company policy is configuration: thresholds, ratings, merit percentages, promotion and compression rules and approval chains. Every change is versioned or audited."><Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'policy' && <Policy />}{tab === 'ratings' && <Ratings />}{tab === 'matrix' && <Matrix />}{tab === 'promotion' && <PromotionRules />}{tab === 'compression' && <CompressionRules />}{tab === 'workflows' && <Workflows />}{tab === 'audit' && <Audit />}
  </CompPage>;
}
const useSave = () => { const qc = useQueryClient(); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null); return { err, ok, setErr, done: (m: string) => { setErr(null); setOk(m); qc.invalidateQueries({ queryKey: ['comp'] }); }, fail: (e: any) => { setOk(null); setErr(e.details ? `${e.message}: ${JSON.stringify(e.details)}` : e.message); } }; };

function Policy() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['comp', 'policy'], queryFn: () => api<any>('/api/v1/compensation/settings/policy') });
  const [v, setV] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { if (q.data) setV(structuredClone(q.data.value)); }, [q.data]);
  const s = useSave();
  const m = useMutation({ mutationFn: () => api<any>('/api/v1/compensation/settings/policy', { method: 'PUT', json: { value: v, reason } }), onSuccess: (r) => { setReason(''); s.done(`Saved as version ${r.version}`); }, onError: s.fail });
  if (!v) return <TableSkeleton />;
  const edit = can('compensation:settings');
  const t = v.statusThresholds;
  const setRange = (i: number, k: string, val: any) => { const ranges = t.ranges.map((r: any, j: number) => (j === i ? { ...r, [k]: k.endsWith('Pct') ? Number(val) : val } : r)); setV({ ...v, statusThresholds: { ...t, ranges } }); };
  const COLORS = ['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLUE', 'GREY'];
  const ACTIONS = ['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE'];
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Salary status thresholds" subtitle="By range penetration inside the band: [from%, to%). Below minimum, at maximum and above maximum are fixed categories with configurable labels.">
        <table className="data"><thead><tr><th>Code</th><th>Label</th><th>Colour</th><th>From %</th><th>To %</th><th /></tr></thead><tbody>{t.ranges.map((r: any, i: number) => <tr key={i}>
          <td><input className="input w-32" disabled={!edit} value={r.code} onChange={(e) => setRange(i, 'code', e.target.value.toUpperCase())} /></td><td><input className="input" disabled={!edit} value={r.label} onChange={(e) => setRange(i, 'label', e.target.value)} /></td>
          <td><select className="input w-28" disabled={!edit} value={r.color} onChange={(e) => setRange(i, 'color', e.target.value)}>{COLORS.map((c) => <option key={c}>{c}</option>)}</select></td>
          <td><input className="input w-20" type="number" disabled={!edit} value={r.fromPct} onChange={(e) => setRange(i, 'fromPct', e.target.value)} /></td><td><input className="input w-20" type="number" disabled={!edit} value={r.toPct} onChange={(e) => setRange(i, 'toPct', e.target.value)} /></td>
          <td>{edit && t.ranges.length > 1 && <button className="btn-ghost btn-sm" onClick={() => setV({ ...v, statusThresholds: { ...t, ranges: t.ranges.filter((_: any, j: number) => j !== i) } })}><Trash2 size={14} /></button>}</td></tr>)}</tbody></table>
        {edit && <button className="btn-ghost btn-sm mt-2" onClick={() => setV({ ...v, statusThresholds: { ...t, ranges: [...t.ranges, { code: 'NEW', label: 'New', color: 'YELLOW', fromPct: 0, toPct: 0 }] } })}><Plus size={14} /> Range</button>}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">{(['belowMin', 'atMax', 'aboveMax', 'noBand'] as const).map((k) => <div key={k} className="flex items-center gap-2"><StatusPill status={t[k]} /><input className="input" disabled={!edit} value={t[k].label} onChange={(e) => setV({ ...v, statusThresholds: { ...t, [k]: { ...t[k], label: e.target.value } } })} /><select className="input w-28" disabled={!edit} value={t[k].color} onChange={(e) => setV({ ...v, statusThresholds: { ...t, [k]: { ...t[k], color: e.target.value } } })}>{COLORS.map((c) => <option key={c}>{c}</option>)}</select></div>)}</div>
        <div className="mt-3 flex flex-wrap gap-2">{t.ranges.map((r: any) => <StatusPill key={r.code} status={r} />)}</div>
      </Card>
      <Card title="Rules">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Salary compared to the band" hint="BASIC: basic salary · GROSS: fixed monthly gross"><select className="input" disabled={!edit} value={v.bandBasis} onChange={(e) => setV({ ...v, bandBasis: e.target.value })}><option value="BASIC">Basic salary</option><option value="GROSS">Gross salary</option></select></Field>
          <Field label="Budget enforcement"><select className="input" disabled={!edit} value={v.budgetEnforcement} onChange={(e) => setV({ ...v, budgetEnforcement: e.target.value })}><option value="BLOCK">Block beyond the approved budget</option><option value="WARN">Warn only</option><option value="OFF">Off</option></select></Field>
          <Field label="Annual cost months" hint="12, or more when salary-linked bonuses exist"><input className="input" type="number" disabled={!edit} value={v.annualizationMonths} onChange={(e) => setV({ ...v, annualizationMonths: Number(e.target.value) })} /></Field>
          <Field label="Due for review after (months)"><input className="input" type="number" disabled={!edit} value={v.reviewDueMonths} onChange={(e) => setV({ ...v, reviewDueMonths: Number(e.target.value) })} /></Field>
          <Field label="Max increase % without override"><input className="input" type="number" disabled={!edit} value={v.maxIncreasePctWithoutOverride} onChange={(e) => setV({ ...v, maxIncreasePctWithoutOverride: Number(e.target.value) })} /></Field>
          <Field label="Direct salary entry (employee profile)"><select className="input" disabled={!edit} value={v.directSalaryEntry} onChange={(e) => setV({ ...v, directSalaryEntry: e.target.value })}><option value="ALLOWED">Allowed (flagged)</option><option value="INITIAL_ONLY">Joining salary only</option></select></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" disabled={!edit} checked={v.segregationOfDuties} onChange={(e) => setV({ ...v, segregationOfDuties: e.target.checked })} /> Segregation of duties — the preparer / submitter can never approve their own request</label>
          <div className="sm:col-span-2"><p className="mb-1.5 text-xs font-semibold text-muted">Allowed actions when a proposal exceeds the band maximum</p><div className="flex flex-wrap gap-3">{ACTIONS.map((a) => <label key={a} className="flex items-center gap-1.5 text-sm"><input type="checkbox" disabled={!edit} checked={v.ceilingActions.includes(a)} onChange={(e) => setV({ ...v, ceilingActions: e.target.checked ? [...v.ceilingActions, a] : v.ceilingActions.filter((x: string) => x !== a) })} />{humanStatus(a)}</label>)}</div></div>
        </div>
        {!v.signedOff && <div className="mt-4"><Alert tone="warning">These values are development examples — REQUIRE HR / FINANCE CONFIRMATION before production use.</Alert></div>}
        {edit && <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4"><Field label="Reason for the change (versioned)" className="min-w-64 flex-1"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field><label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" checked={v.signedOff} onChange={(e) => setV({ ...v, signedOff: e.target.checked })} /> HR/Finance signed off</label><button className="btn-primary" disabled={!reason || m.isPending} onClick={() => m.mutate()}>Save policy (v{(q.data?.version ?? 0) + 1})</button></div>}
        {s.err && <div className="mt-3"><Alert tone="danger">{s.err}</Alert></div>}{s.ok && <div className="mt-3"><Alert tone="success">{s.ok}</Alert></div>}
      </Card>
    </div>
  );
}

function Ratings() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['comp', 'ratings'], queryFn: () => api<any[]>('/api/v1/compensation/rating-levels') });
  const [rows, setRows] = useState<any[] | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { if (q.data) setRows(q.data.map((r) => ({ ...r }))); }, [q.data]);
  const s = useSave();
  const m = useMutation({ mutationFn: () => api('/api/v1/compensation/rating-levels', { method: 'PUT', json: { levels: rows!.map((r) => ({ ...r, minScore: Number(r.minScore), maxScore: Number(r.maxScore), sortOrder: Number(r.sortOrder) })), reason } }), onSuccess: () => s.done('Rating levels saved'), onError: s.fail });
  if (!rows) return <TableSkeleton />;
  const edit = can('compensation:settings');
  const set = (i: number, k: string, v: any) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Card title="Performance rating levels" subtitle="Maps the finalised review score (performance module, 1–5 scale) to the ratings used by the merit matrix and eligibility rules.">
      <table className="data"><thead><tr><th>Code</th><th>Label</th><th>Min score</th><th>Max score</th><th>Order</th><th>Active</th></tr></thead><tbody>{rows.map((r, i) => <tr key={i}><td><input className="input w-36" disabled={!edit} value={r.code} onChange={(e) => set(i, 'code', e.target.value.toUpperCase())} /></td><td><input className="input" disabled={!edit} value={r.label} onChange={(e) => set(i, 'label', e.target.value)} /></td><td><input className="input w-24" type="number" step="0.01" disabled={!edit} value={r.minScore} onChange={(e) => set(i, 'minScore', e.target.value)} /></td><td><input className="input w-24" type="number" step="0.01" disabled={!edit} value={r.maxScore} onChange={(e) => set(i, 'maxScore', e.target.value)} /></td><td><input className="input w-20" type="number" disabled={!edit} value={r.sortOrder} onChange={(e) => set(i, 'sortOrder', e.target.value)} /></td><td><input type="checkbox" disabled={!edit} checked={r.isActive} onChange={(e) => set(i, 'isActive', e.target.checked)} /></td></tr>)}</tbody></table>
      {edit && <div className="mt-3 flex flex-wrap items-end gap-2"><button className="btn-ghost btn-sm" onClick={() => setRows([...rows, { code: '', label: '', minScore: 0, maxScore: 0, sortOrder: (rows.length + 1) * 10, isActive: true }])}><Plus size={14} /> Level</button><span className="flex-1" /><input className="input w-64" placeholder="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn-primary" disabled={!reason || m.isPending} onClick={() => m.mutate()}>Save</button></div>}
      {s.err && <div className="mt-3"><Alert tone="danger">{s.err}</Alert></div>}{s.ok && <div className="mt-3"><Alert tone="success">{s.ok}</Alert></div>}
    </Card>
  );
}

function Matrix() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['comp', 'matrices'], queryFn: () => api<any[]>('/api/v1/compensation/merit-matrices') });
  const ratings = useQuery({ queryKey: ['comp', 'ratings'], queryFn: () => api<any[]>('/api/v1/compensation/rating-levels') });
  const [m, setM] = useState<any | null>(null);
  const s = useSave();
  const save = useMutation({ mutationFn: () => { const body = { name: m.name, fiscalYear: m.fiscalYear ? Number(m.fiscalYear) : null, effectiveFrom: m.effectiveFrom, status: m.status, isDefault: m.isDefault, notes: m.notes || null, cells: m.cells.map((c: any) => ({ ratingCode: c.ratingCode, minCompa: c.minCompa === '' || c.minCompa === null ? null : Number(c.minCompa), maxCompa: c.maxCompa === '' || c.maxCompa === null ? null : Number(c.maxCompa), recommendedPct: Number(c.recommendedPct), maxPct: Number(c.maxPct) })) }; return m.id ? api(`/api/v1/compensation/merit-matrices/${m.id}`, { method: 'PUT', json: body }) : api('/api/v1/compensation/merit-matrices', { method: 'POST', json: body }); }, onSuccess: () => { setM(null); s.done('Merit matrix saved'); }, onError: s.fail });
  const edit = can('compensation:config');
  return (
    <>
      {s.ok && <div className="mb-3"><Alert tone="success">{s.ok}</Alert></div>}
      {q.isLoading ? <TableSkeleton /> : q.data?.length ? q.data.map((mx) => <Card key={mx.id} className="mb-4" title={<span className="flex items-center gap-2">{mx.name}{mx.isDefault && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand">default</span>}</span>} subtitle={`${humanStatus(mx.status)} · effective ${mx.effectiveFrom}${mx.fiscalYear ? ` · FY ${mx.fiscalYear}` : ''}`} actions={edit && <button className="btn-ghost btn-sm" onClick={() => setM(structuredClone(mx))}><Pencil size={14} /> Edit</button>}>
        <MatrixGrid cells={mx.cells} ratings={ratings.data ?? []} />
      </Card>) : <Card><EmptyState title="No merit matrix" /></Card>}
      {edit && <button className="btn-primary btn-sm" onClick={() => setM({ name: 'New merit matrix', fiscalYear: new Date().getFullYear() + 1, effectiveFrom: `${new Date().getFullYear() + 1}-01-01`, status: 'DRAFT', isDefault: false, notes: '', cells: (ratings.data ?? []).map((r) => ({ ratingCode: r.code, minCompa: null, maxCompa: null, recommendedPct: 0, maxPct: 0 })) })}><Plus size={14} /> New matrix</button>}
      <Modal open={!!m} onClose={() => setM(null)} title="Merit matrix" wide>{m && <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4"><Field label="Name" className="sm:col-span-2"><input className="input" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></Field><Field label="Effective from"><input className="input" type="date" value={m.effectiveFrom} onChange={(e) => setM({ ...m, effectiveFrom: e.target.value })} /></Field><Field label="Status"><select className="input" value={m.status} onChange={(e) => setM({ ...m, status: e.target.value })}><option>DRAFT</option><option>ACTIVE</option><option>RETIRED</option></select></Field></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={m.isDefault} onChange={(e) => setM({ ...m, isDefault: e.target.checked })} /> Default matrix (used for individual increments and merit reviews)</label>
        <table className="data"><thead><tr><th>Rating</th><th>Compa from (≥)</th><th>Compa to (&lt;)</th><th>Recommended %</th><th>Maximum %</th><th /></tr></thead><tbody>{m.cells.map((c: any, i: number) => { const set = (k: string, v: any) => setM({ ...m, cells: m.cells.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)) }); return <tr key={i}>
          <td><select className="input w-36" value={c.ratingCode} onChange={(e) => set('ratingCode', e.target.value)}>{ratings.data?.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></td>
          <td><input className="input w-24" type="number" placeholder="open" value={c.minCompa ?? ''} onChange={(e) => set('minCompa', e.target.value)} /></td><td><input className="input w-24" type="number" placeholder="open" value={c.maxCompa ?? ''} onChange={(e) => set('maxCompa', e.target.value)} /></td>
          <td><input className="input w-24" type="number" step="0.1" value={c.recommendedPct} onChange={(e) => set('recommendedPct', e.target.value)} /></td><td><input className="input w-24" type="number" step="0.1" value={c.maxPct} onChange={(e) => set('maxPct', e.target.value)} /></td>
          <td><button className="btn-ghost btn-sm" onClick={() => setM({ ...m, cells: m.cells.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button></td></tr>; })}</tbody></table>
        <button className="btn-ghost btn-sm" onClick={() => setM({ ...m, cells: [...m.cells, { ratingCode: ratings.data?.[0]?.code ?? '', minCompa: null, maxCompa: null, recommendedPct: 0, maxPct: 0 }] })}><Plus size={14} /> Row</button>
        {s.err && <Alert tone="danger">{s.err}</Alert>}
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setM(null)}>Cancel</button><button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save matrix</button></div>
      </div>}</Modal>
    </>
  );
}
function MatrixGrid({ cells, ratings }: { cells: any[]; ratings: any[] }) {
  const bounds = [...new Set(cells.flatMap((c) => [c.minCompa, c.maxCompa]).filter((x) => x !== null))].sort((a, b) => a - b);
  const cols = [null, ...bounds].map((lo, i) => ({ lo, hi: bounds[i] ?? null }));
  const find = (r: string, lo: number | null, hi: number | null) => { const mid = lo === null ? (hi ?? 0) - 1 : hi === null ? lo + 1 : (lo + hi) / 2; return cells.find((c) => c.ratingCode === r && (c.minCompa === null || mid >= c.minCompa) && (c.maxCompa === null || mid < c.maxCompa)); };
  const used = ratings.filter((r) => cells.some((c) => c.ratingCode === r.code));
  return (
    <div className="overflow-x-auto"><table className="data"><thead><tr><th>Rating \ compa-ratio</th>{cols.map((c, i) => <th key={i}>{c.lo === null ? `< ${c.hi ?? '∞'}%` : c.hi === null ? `≥ ${c.lo}%` : `${c.lo}–${c.hi}%`}</th>)}</tr></thead><tbody>{used.map((r) => <tr key={r.code}><td className="font-medium">{r.label}</td>{cols.map((c, i) => { const x = find(r.code, c.lo, c.hi); return <td key={i} className={cn('tabular-nums', x && x.recommendedPct >= 8 && 'bg-success/10', x && x.recommendedPct === 0 && 'text-muted')}>{x ? <><b>{x.recommendedPct}%</b> <span className="text-xs text-muted">max {x.maxPct}%</span></> : '—'}</td>; })}</tr>)}</tbody></table></div>
  );
}

function PromotionRules() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['comp', 'promotion-rules'], queryFn: () => api<any[]>('/api/v1/compensation/promotion-rules') });
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades') });
  const [r, setR] = useState<any | null>(null);
  const s = useSave();
  const n = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
  const save = useMutation({ mutationFn: () => { const body = { name: r.name, fromGradeId: r.fromGradeId || null, toGradeId: r.toGradeId || null, method: r.method, value: Number(r.value), minIncreasePct: n(r.minIncreasePct), maxIncreasePct: n(r.maxIncreasePct), capAtMax: r.capAtMax, priority: Number(r.priority), isActive: r.isActive, notes: r.notes || null }; return r.id ? api(`/api/v1/compensation/promotion-rules/${r.id}`, { method: 'PUT', json: body }) : api('/api/v1/compensation/promotion-rules', { method: 'POST', json: body }); }, onSuccess: () => { setR(null); s.done('Rule saved'); }, onError: s.fail });
  const METHODS: Record<string, string> = { PERCENT_INCREASE: '% on current salary', TO_MINIMUM: 'Raise to target minimum', TO_MIDPOINT: 'Raise to target midpoint', PERCENT_OF_MIDPOINT: '% of target midpoint', FIXED_AMOUNT: 'Fixed amount', GREATER_OF_PERCENT_OR_MINIMUM: 'Greater of % or target minimum' };
  const edit = can('compensation:config');
  return (
    <Card padded={false} title="Promotion salary rules" subtitle="The most specific active rule wins: from+to grade › to grade › from grade › default. HR may deviate with justification." actions={edit && <button className="btn-primary btn-sm" onClick={() => setR({ name: '', fromGradeId: '', toGradeId: '', method: 'GREATER_OF_PERCENT_OR_MINIMUM', value: 10, minIncreasePct: '', maxIncreasePct: '', capAtMax: true, priority: 100, isActive: true, notes: '' })}><Plus size={14} /> Rule</button>}>
      {s.ok && <div className="p-4"><Alert tone="success">{s.ok}</Alert></div>}
      {q.isLoading ? <TableSkeleton /> : <table className="data"><thead><tr><th>Rule</th><th>From</th><th>To</th><th>Method</th><th>Value</th><th>Min / max %</th><th>Cap at max</th><th>Active</th><th /></tr></thead><tbody>{q.data?.map((x) => <tr key={x.id}><td className="font-medium">{x.name}</td><td>{x.fromGrade ?? 'any'}</td><td>{x.toGrade ?? 'any'}</td><td>{METHODS[x.method]}</td><td>{x.value}</td><td>{x.minIncreasePct ?? '—'} / {x.maxIncreasePct ?? '—'}</td><td>{x.capAtMax ? 'yes' : 'no'}</td><td>{x.isActive ? 'yes' : 'no'}</td><td>{edit && <button className="btn-ghost btn-sm" onClick={() => setR({ ...x, fromGradeId: x.fromGradeId ?? '', toGradeId: x.toGradeId ?? '', minIncreasePct: x.minIncreasePct ?? '', maxIncreasePct: x.maxIncreasePct ?? '', notes: x.notes ?? '' })}><Pencil size={14} /></button>}</td></tr>)}</tbody></table>}
      <Modal open={!!r} onClose={() => setR(null)} title="Promotion rule">{r && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
        <Field label="From grade"><select className="input" value={r.fromGradeId} onChange={(e) => setR({ ...r, fromGradeId: e.target.value })}><option value="">Any</option>{grades.data?.map((g) => <option key={g.id} value={g.id}>{g.code}</option>)}</select></Field>
        <Field label="To grade"><select className="input" value={r.toGradeId} onChange={(e) => setR({ ...r, toGradeId: e.target.value })}><option value="">Any</option>{grades.data?.map((g) => <option key={g.id} value={g.id}>{g.code}</option>)}</select></Field>
        <Field label="Method"><select className="input" value={r.method} onChange={(e) => setR({ ...r, method: e.target.value })}>{Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Value (% or amount)"><input className="input" type="number" value={r.value} onChange={(e) => setR({ ...r, value: e.target.value })} /></Field>
        <Field label="Minimum increase %"><input className="input" type="number" value={r.minIncreasePct} onChange={(e) => setR({ ...r, minIncreasePct: e.target.value })} /></Field>
        <Field label="Maximum increase %"><input className="input" type="number" value={r.maxIncreasePct} onChange={(e) => setR({ ...r, maxIncreasePct: e.target.value })} /></Field>
        <Field label="Priority"><input className="input" type="number" value={r.priority} onChange={(e) => setR({ ...r, priority: e.target.value })} /></Field>
        <div className="flex items-end gap-4 pb-2 text-sm"><label className="flex items-center gap-1.5"><input type="checkbox" checked={r.capAtMax} onChange={(e) => setR({ ...r, capAtMax: e.target.checked })} /> Cap at target maximum</label><label className="flex items-center gap-1.5"><input type="checkbox" checked={r.isActive} onChange={(e) => setR({ ...r, isActive: e.target.checked })} /> Active</label></div>
        {s.err && <div className="sm:col-span-2"><Alert tone="danger">{s.err}</Alert></div>}
        <div className="flex justify-end gap-2 sm:col-span-2"><button className="btn-ghost" onClick={() => setR(null)}>Cancel</button><button className="btn-primary" disabled={!r.name || save.isPending} onClick={() => save.mutate()}>Save</button></div>
      </div>}</Modal>
    </Card>
  );
}

function CompressionRules() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['comp', 'compression-rules'], queryFn: () => api<any[]>('/api/v1/compensation/compression-rules') });
  const titles = useQuery({ queryKey: ['org', 'designations'], queryFn: () => api<any[]>('/api/v1/org/designations') });
  const [r, setR] = useState<any | null>(null);
  const s = useSave();
  const n = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
  const save = useMutation({ mutationFn: () => { const body = { name: r.name, scope: r.scope, lowerDesignationId: r.lowerDesignationId || null, upperDesignationId: r.upperDesignationId || null, jobFunctionId: r.jobFunctionId || null, minDifferenceAmount: n(r.minDifferenceAmount), minDifferencePct: n(r.minDifferencePct), compare: r.compare, isActive: r.isActive }; return r.id ? api(`/api/v1/compensation/compression-rules/${r.id}`, { method: 'PUT', json: body }) : api('/api/v1/compensation/compression-rules', { method: 'POST', json: body }); }, onSuccess: () => { setR(null); s.done('Rule saved'); }, onError: s.fail });
  const edit = can('compensation:config');
  return (
    <Card padded={false} title="Salary compression rules" subtitle="Flag unusually small differences between hierarchical levels. Detection only — salaries are never changed automatically." actions={edit && <button className="btn-primary btn-sm" onClick={() => setR({ name: '', scope: 'DESIGNATION_PAIR', lowerDesignationId: '', upperDesignationId: '', jobFunctionId: '', minDifferenceAmount: '', minDifferencePct: 5, compare: 'AVERAGE', isActive: true })}><Plus size={14} /> Rule</button>}>
      {s.ok && <div className="p-4"><Alert tone="success">{s.ok}</Alert></div>}
      {q.isLoading ? <TableSkeleton /> : <table className="data"><thead><tr><th>Rule</th><th>Hierarchy</th><th>Min difference</th><th>Compare</th><th>Active</th><th /></tr></thead><tbody>{q.data?.map((x) => <tr key={x.id}><td className="font-medium">{x.name}</td><td className="text-sm">{x.scope === 'DESIGNATION_PAIR' ? `${x.lowerTitle} → ${x.upperTitle}` : x.scope === 'GRADE_SEQUENCE' ? 'Every adjacent grade' : 'Titles of a job function by career level'}</td><td>{[x.minDifferenceAmount !== null && `${x.minDifferenceAmount} AED`, x.minDifferencePct !== null && `${x.minDifferencePct}%`].filter(Boolean).join(' and ')}</td><td>{humanStatus(x.compare)}</td><td>{x.isActive ? 'yes' : 'no'}</td><td>{edit && <button className="btn-ghost btn-sm" onClick={() => setR({ ...x, lowerDesignationId: x.lowerDesignationId ?? '', upperDesignationId: x.upperDesignationId ?? '', jobFunctionId: x.jobFunctionId ?? '', minDifferenceAmount: x.minDifferenceAmount ?? '', minDifferencePct: x.minDifferencePct ?? '' })}><Pencil size={14} /></button>}</td></tr>)}</tbody></table>}
      <Modal open={!!r} onClose={() => setR(null)} title="Compression rule">{r && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
        <Field label="Hierarchy" className="sm:col-span-2"><select className="input" value={r.scope} onChange={(e) => setR({ ...r, scope: e.target.value })}><option value="DESIGNATION_PAIR">Two job titles (junior → senior)</option><option value="GRADE_SEQUENCE">Every adjacent grade</option></select></Field>
        {r.scope === 'DESIGNATION_PAIR' && <><Field label="Junior title"><select className="input" value={r.lowerDesignationId} onChange={(e) => setR({ ...r, lowerDesignationId: e.target.value })}><option value="">Select…</option>{titles.data?.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field><Field label="Senior title"><select className="input" value={r.upperDesignationId} onChange={(e) => setR({ ...r, upperDesignationId: e.target.value })}><option value="">Select…</option>{titles.data?.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field></>}
        <Field label="Minimum difference (amount)"><input className="input" type="number" value={r.minDifferenceAmount} onChange={(e) => setR({ ...r, minDifferenceAmount: e.target.value })} /></Field>
        <Field label="Minimum difference (%)"><input className="input" type="number" value={r.minDifferencePct} onChange={(e) => setR({ ...r, minDifferencePct: e.target.value })} /></Field>
        <Field label="Compare"><select className="input" value={r.compare} onChange={(e) => setR({ ...r, compare: e.target.value })}><option value="AVERAGE">Average salaries</option><option value="MEDIAN">Median salaries</option><option value="MAX_LOWER_VS_MIN_UPPER">Highest junior vs lowest senior</option></select></Field>
        <label className="flex items-end gap-1.5 pb-2 text-sm"><input type="checkbox" checked={r.isActive} onChange={(e) => setR({ ...r, isActive: e.target.checked })} /> Active</label>
        {s.err && <div className="sm:col-span-2"><Alert tone="danger">{s.err}</Alert></div>}
        <div className="flex justify-end gap-2 sm:col-span-2"><button className="btn-ghost" onClick={() => setR(null)}>Cancel</button><button className="btn-primary" disabled={!r.name || save.isPending} onClick={() => save.mutate()}>Save</button></div>
      </div>}</Modal>
    </Card>
  );
}

function Workflows() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['comp', 'workflows'], queryFn: () => api<any[]>('/api/v1/compensation/settings/workflows') });
  const [w, setW] = useState<any | null>(null);
  const s = useSave();
  const save = useMutation({ mutationFn: () => api(`/api/v1/compensation/settings/workflows/${w.code}`, { method: 'PUT', json: { name: w.name, steps: w.steps.map((x: any) => ({ key: x.key, approverType: x.approverType, ...(x.approverType === 'ROLE' ? { roleCode: x.roleCode } : {}), ...(x.statusOnApprove ? { statusOnApprove: x.statusOnApprove } : {}), ...(x.conditional ? { condition: { field: 'requiresException', op: 'eq', value: true } } : x.condition ? { condition: x.condition } : {}) })), reason: w.reason } }), onSuccess: () => { setW(null); s.done('Approval chain saved as a new version'); }, onError: s.fail });
  const ROLES = ['HR_MANAGER', 'HR_ADMIN', 'FINANCE', 'FINANCE_MANAGER', 'MANAGEMENT', 'PAYROLL_OFFICER', 'SUPER_ADMIN'];
  const STATUSES = ['UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'APPROVED'];
  const edit = can('compensation:settings');
  return (
    <>
      {s.ok && <div className="mb-3"><Alert tone="success">{s.ok}</Alert></div>}
      <div className="grid gap-4 xl:grid-cols-2">{q.data?.map((d) => <Card key={d.code} title={d.name} subtitle={`${d.code} · v${d.version}`} actions={edit && <button className="btn-ghost btn-sm" onClick={() => setW({ ...d, reason: '', steps: d.steps.map((x: any) => ({ ...x, conditional: x.condition?.field === 'requiresException' })) })}><Pencil size={14} /> Edit</button>}>
        <ol className="flex flex-wrap items-center gap-2 text-sm"><li className="rounded-full bg-surface-2 px-3 py-1">Submitted</li>{d.steps.map((x: any, i: number) => <li key={i} className="flex items-center gap-2"><span className="text-muted">→</span><span className="rounded-full bg-brand-soft px-3 py-1">{x.approverType === 'MANAGER' ? 'Line manager' : humanStatus(x.roleCode ?? x.userId)}{x.condition && <span className="ms-1 text-[11px] text-orange-600">(if {x.condition.field} {x.condition.op} {String(x.condition.value)})</span>}</span></li>)}<li className="flex items-center gap-2"><span className="text-muted">→</span><span className="rounded-full bg-success/10 px-3 py-1 text-success">Completed</span></li></ol>
      </Card>)}</div>
      <Modal open={!!w} onClose={() => setW(null)} title={w ? `Approval chain — ${w.code}` : ''} wide>{w && <div className="space-y-3">
        <Field label="Name"><input className="input" value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} /></Field>
        <table className="data"><thead><tr><th>Step key</th><th>Approver</th><th>Role</th><th>Status after approval</th><th>Only for exceptions</th><th /></tr></thead><tbody>{w.steps.map((x: any, i: number) => { const set = (k: string, v: any) => setW({ ...w, steps: w.steps.map((y: any, j: number) => (j === i ? { ...y, [k]: v } : y)) }); return <tr key={i}>
          <td><input className="input w-36" value={x.key} onChange={(e) => set('key', e.target.value)} /></td>
          <td><select className="input w-36" value={x.approverType} onChange={(e) => set('approverType', e.target.value)}><option value="ROLE">Role</option><option value="MANAGER">Line manager</option></select></td>
          <td>{x.approverType === 'ROLE' && <select className="input w-44" value={x.roleCode ?? ''} onChange={(e) => set('roleCode', e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{humanStatus(r)}</option>)}</select>}</td>
          <td><select className="input w-44" value={x.statusOnApprove ?? ''} onChange={(e) => set('statusOnApprove', e.target.value || undefined)}><option value="">(from role)</option>{STATUSES.map((st) => <option key={st} value={st}>{humanStatus(st)}</option>)}</select></td>
          <td><input type="checkbox" checked={!!x.conditional} onChange={(e) => set('conditional', e.target.checked)} /></td>
          <td className="whitespace-nowrap"><button className="btn-ghost btn-sm" disabled={i === 0} onClick={() => { const st = [...w.steps]; [st[i - 1], st[i]] = [st[i], st[i - 1]]; setW({ ...w, steps: st }); }}>↑</button><button className="btn-ghost btn-sm" onClick={() => setW({ ...w, steps: w.steps.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button></td>
        </tr>; })}</tbody></table>
        <button className="btn-ghost btn-sm" onClick={() => setW({ ...w, steps: [...w.steps, { key: `step_${w.steps.length + 1}`, approverType: 'ROLE', roleCode: 'HR_MANAGER' }] })}><Plus size={14} /> Step</button>
        <Alert tone="info">Not every organisation needs every step. Changes create a new version; requests already in flight keep their chain. A chain with no applicable step is refused — salary changes are never auto-approved.</Alert>
        <Field label="Reason (audited)"><input className="input" value={w.reason} onChange={(e) => setW({ ...w, reason: e.target.value })} /></Field>
        {s.err && <Alert tone="danger">{s.err}</Alert>}
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setW(null)}>Cancel</button><button className="btn-primary" disabled={!w.reason || !w.steps.length || save.isPending} onClick={() => save.mutate()}>Save new version</button></div>
      </div>}</Modal>
    </>
  );
}

function Audit() {
  const [f, setF] = useState({ action: '', page: 1 });
  const q = useQuery({ queryKey: ['comp', 'audit', f], queryFn: () => api<Paginated<any>>(`/api/v1/compensation/audit${qs({ ...f, pageSize: 50 })}`) });
  return (
    <Card padded={false} title="Compensation audit trail" subtitle="Immutable: salary, grade, band, budget, policy and workflow changes, approvals and rejections" actions={<select className="input w-56" value={f.action} onChange={(e) => setF({ action: e.target.value, page: 1 })}><option value="">All actions</option>{['compensation.change', 'compensation.review', 'compensation.promotion', 'compensation.band', 'compensation.grade', 'compensation.budget', 'compensation.policy', 'compensation.workflow', 'compensation.matrix', 'employee.salary', 'hr_request'].map((a) => <option key={a} value={a}>{a}</option>)}</select>}>
      {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Old value</th><th>New value</th><th>Reason</th><th>IP</th></tr></thead><tbody>{q.data.data.map((a) => <tr key={a.id}><td className="whitespace-nowrap text-xs">{fmtDateTime(a.at)}</td><td className="text-xs">{a.user ?? 'system'}</td><td className="text-xs font-medium">{a.action}</td><td className="text-xs">{a.entityType}<div className="text-muted">{a.entityId?.slice(0, 8)}</div></td><td className="max-w-56 truncate text-xs" title={JSON.stringify(a.oldValue)}>{a.oldValue ? JSON.stringify(a.oldValue) : '—'}</td><td className="max-w-56 truncate text-xs" title={JSON.stringify(a.newValue)}>{a.newValue ? JSON.stringify(a.newValue) : '—'}</td><td className="text-xs">{a.reason ?? ''}</td><td className="text-xs">{a.ip ?? ''}</td></tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No audit entries" /></div>}
      {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
    </Card>
  );
}
