'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, Field, Modal, StatTile, TableSkeleton, cn } from '@/components/ui';
import { fmtMoney, humanStatus } from '@/lib/format';
import { CompPage, WfBadge, downloadCsv, pct } from '@/components/compensation/common';

export default function Page() { return <CompPage title="Compensation budgets" subtitle="Allocated vs proposed (pending + approved) vs approved annual cost. Approvals beyond an approved budget are blocked unless the policy says otherwise."><Budgets /></CompPage>; }

function Budgets() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const q = useQuery({ queryKey: ['comp', 'budgets', year], queryFn: () => api<any[]>(`/api/v1/compensation/budgets?year=${year}`) });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments') });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites') });
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades') });
  const [edit, setEdit] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => edit.id ? api(`/api/v1/compensation/budgets/${edit.id}`, { method: 'PUT', json: { name: edit.name, amount: Number(edit.amount), status: edit.status, notes: edit.notes || null, reason: edit.reason } }) : api('/api/v1/compensation/budgets', { method: 'POST', json: { name: edit.name, fiscalYear: Number(edit.fiscalYear), budgetType: edit.budgetType, scopeType: edit.scopeType, scopeId: edit.scopeType === 'COMPANY' ? null : edit.scopeId, amount: Number(edit.amount), notes: edit.notes || null } }), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['comp'] }); }, onError: (e: any) => setErr(e.message) });
  const rows = q.data ?? [];
  const annual = rows.find((b) => b.budgetType === 'ANNUAL' && b.scopeType === 'COMPANY');
  const scopes = edit?.scopeType === 'DEPARTMENT' ? depts.data?.map((d) => ({ id: d.id, l: d.name })) : edit?.scopeType === 'SITE' ? sites.data?.map((d) => ({ id: d.id, l: d.name })) : edit?.scopeType === 'GRADE' ? grades.data?.map((g) => ({ id: g.id, l: g.code })) : [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2"><select className="input w-32" value={year} onChange={(e) => setYear(Number(e.target.value))}>{[-1, 0, 1, 2].map((i) => new Date().getFullYear() + i).map((y) => <option key={y} value={y}>FY {y}</option>)}</select><span className="ms-auto" />{can('reports:compensation') && <button className="btn-secondary btn-sm" onClick={() => downloadCsv(`/api/v1/compensation/reports/budgets?format=csv&year=${year}`, `compensation-budgets-${year}.csv`)}>Export</button>}{can('compensation:budget') && <button className="btn-primary btn-sm" onClick={() => { setErr(null); setEdit({ name: '', fiscalYear: year, budgetType: 'INCREMENT', scopeType: 'COMPANY', scopeId: '', amount: '', notes: '' }); }}><Plus size={14} /> Budget</button>}</div>
      {annual && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Annual budget" value={fmtMoney(annual.usage.allocated, annual.currency)} />
        <StatTile label="Proposed cost" value={fmtMoney(annual.usage.proposedCost, annual.currency)} hint="pending + approved" tone="info" />
        <StatTile label="Approved cost" value={fmtMoney(annual.usage.approvedCost, annual.currency)} tone="success" />
        <StatTile label="Remaining" value={fmtMoney(annual.usage.remaining, annual.currency)} tone={annual.usage.remaining < 0 ? 'danger' : 'accent'} />
        <StatTile label="Utilisation" value={pct(annual.usage.utilizationPct)} tone={(annual.usage.utilizationPct ?? 0) > 100 ? 'danger' : (annual.usage.utilizationPct ?? 0) > 90 ? 'warning' : 'default'} />
      </div>}
      <Card padded={false} title={`Budgets FY ${year}`}>
        {q.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Budget</th><th>Type</th><th>Scope</th><th>Allocated</th><th>Proposed</th><th>Approved</th><th>Remaining</th><th className="min-w-40">Utilisation</th><th>Status</th><th /></tr></thead><tbody>{rows.map((b) => { const u = b.usage; const w = Math.min(100, u.utilizationPct ?? 0), wa = Math.min(100, u.approvedUtilizationPct ?? 0); return <tr key={b.id}>
          <td className="font-medium">{b.name}{b.notes && <div className="text-xs text-muted">{b.notes}</div>}</td><td>{humanStatus(b.budgetType)}</td><td>{b.scopeType === 'COMPANY' ? 'Company' : `${humanStatus(b.scopeType)}: ${b.scopeName ?? '—'}`}</td>
          <td className="tabular-nums">{fmtMoney(u.allocated, b.currency)}</td><td className="tabular-nums">{fmtMoney(u.proposedCost, b.currency)}</td><td className="tabular-nums">{fmtMoney(u.approvedCost, b.currency)}</td><td className={cn('tabular-nums', u.remaining < 0 && 'font-semibold text-danger')}>{fmtMoney(u.remaining, b.currency)}</td>
          <td><div className="relative h-2.5 overflow-hidden rounded-full bg-surface-2"><div className="absolute inset-y-0 start-0 bg-info/40" style={{ width: `${w}%` }} /><div className={cn('absolute inset-y-0 start-0', u.exceeded ? 'bg-danger' : 'bg-success')} style={{ width: `${wa}%` }} /></div><div className="mt-1 text-[11px] text-muted">{pct(u.utilizationPct)} proposed · {pct(u.approvedUtilizationPct)} approved</div></td>
          <td><WfBadge status={b.status} /></td><td>{can('compensation:budget') && <button className="btn-ghost btn-sm" onClick={() => { setErr(null); setEdit({ ...b, notes: b.notes ?? '', reason: '' }); }}><Pencil size={14} /></button>}</td>
        </tr>; })}</tbody></table></div> : <div className="p-5"><EmptyState title="No budgets for this year" hint="Define annual, increment, promotion and adjustment budgets — company-wide or per department, grade or site." /></div>}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Change budget' : 'New budget'}>{edit && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        {!edit.id && <><Field label="Fiscal year"><input className="input" type="number" value={edit.fiscalYear} onChange={(e) => setEdit({ ...edit, fiscalYear: e.target.value })} /></Field>
          <Field label="Type"><select className="input" value={edit.budgetType} onChange={(e) => setEdit({ ...edit, budgetType: e.target.value })}>{['ANNUAL', 'INCREMENT', 'PROMOTION', 'ADJUSTMENT'].map((t) => <option key={t} value={t}>{humanStatus(t)}</option>)}</select></Field>
          <Field label="Scope"><select className="input" value={edit.scopeType} onChange={(e) => setEdit({ ...edit, scopeType: e.target.value, scopeId: '' })}>{['COMPANY', 'DEPARTMENT', 'GRADE', 'SITE'].map((t) => <option key={t} value={t}>{humanStatus(t)}</option>)}</select></Field>
          {edit.scopeType !== 'COMPANY' && <Field label={humanStatus(edit.scopeType)}><select className="input" value={edit.scopeId} onChange={(e) => setEdit({ ...edit, scopeId: e.target.value })}><option value="">Select…</option>{scopes?.map((s) => <option key={s.id} value={s.id}>{s.l}</option>)}</select></Field>}</>}
        <Field label="Amount (annual cost)"><input className="input" type="number" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></Field>
        {edit.id && <Field label="Status"><select className="input" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{['DRAFT', 'ACTIVE', 'CLOSED'].map((t) => <option key={t}>{t}</option>)}</select></Field>}
        <Field label="Notes" className="sm:col-span-2"><input className="input" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
        {edit.id && <Field label="Reason for the change (audited)" className="sm:col-span-2"><input className="input" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>}
        {err && <div className="sm:col-span-2"><Alert tone="danger">{err}</Alert></div>}
        <div className="flex justify-end gap-2 sm:col-span-2"><button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" disabled={save.isPending || !edit.name || edit.amount === '' || (edit.id && !edit.reason) || (!edit.id && edit.scopeType !== 'COMPANY' && !edit.scopeId)} onClick={() => save.mutate()}>Save</button></div>
      </div>}</Modal>
    </div>
  );
}
