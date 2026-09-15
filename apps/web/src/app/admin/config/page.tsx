'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, SlidersHorizontal, ChevronRight, ShieldAlert } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Tabs, TableSkeleton } from '@/components/ui';
import { fmtDate, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Config /></AppShell>; }
type Tab = 'lookups' | 'workflows' | 'policies' | 'rules';

/** Configuration center: everything that is a rule, not code. Each item is versioned; legal values are flagged for sign-off. */
function Config() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('lookups');
  return (
    <>
      <PageHeader eyebrow="Administration" title="Configuration center" subtitle="Code lists, approval chains, payroll & overtime policies, leave rules and shift patterns. Everything here is data — changes are versioned and audited." />
      <div className="mb-4"><Alert tone="warning"><span className="flex items-center gap-2"><ShieldAlert size={16} />Values marked <b>REQUIRES HR/LEGAL SIGN-OFF</b> (gratuity, leave entitlements, overtime multipliers, termination grounds, document deadlines) are seeded as company examples and must be confirmed before go-live.</span></Alert></div>
      <Tabs tabs={[{ key: 'lookups', label: 'Code lists' }, { key: 'workflows', label: 'Approval chains' }, { key: 'policies', label: 'Payroll & leave policies' }, { key: 'rules', label: 'Overtime & shifts' }]} value={tab} onChange={setTab} />
      {tab === 'lookups' && <Lookups canWrite={can('config:write')} />}
      {tab === 'workflows' && <Workflows />}
      {tab === 'policies' && <Policies />}
      {tab === 'rules' && <Rules />}
    </>
  );
}

function Lookups({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lookups'], queryFn: () => api<any[]>('/api/v1/jobs/lookups') });
  const [edit, setEdit] = useState<any | null>(null);
  const m = useMutation({ mutationFn: () => api('/api/v1/jobs/lookups', { method: 'POST', json: { category: edit.category, code: edit.code, name: edit.name, nameAr: edit.nameAr || null, sortOrder: Number(edit.sortOrder ?? 100), isActive: edit.isActive !== false } }), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['lookups'] }); } });
  const cats = [...new Set((q.data ?? []).map((l) => l.category))].sort();
  return (
    <div className="space-y-4">
      {canWrite && <div className="flex justify-end"><button className="btn-primary btn-sm" onClick={() => setEdit({ category: cats[0] ?? 'BONUS_TYPE', code: '', name: '', nameAr: '', sortOrder: 100, isActive: true })}><Plus size={14} />Value</button></div>}
      {q.isLoading ? <TableSkeleton /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{cats.map((c) => <Card key={c} title={humanStatus(c)} subtitle={`${c} · ${q.data!.filter((l) => l.category === c).length} values`} padded={false}><ul>{q.data!.filter((l) => l.category === c).sort((a, b) => a.sortOrder - b.sortOrder).map((l) => <li key={l.id} className="flex items-center justify-between border-b px-4 py-2 text-sm last:border-0"><span className={!l.isActive ? 'line-through opacity-50' : ''}>{l.name}{l.nameAr && <span className="ms-2 text-xs text-muted">{l.nameAr}</span>}<span className="block font-mono text-[10px] text-muted">{l.code}</span></span>{canWrite && <button className="btn-ghost btn-sm" onClick={() => setEdit({ ...l, nameAr: l.nameAr ?? '' })}>Edit</button>}</li>)}</ul></Card>)}</div>}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit value' : 'New value'}>{edit && <div className="grid gap-3 sm:grid-cols-2"><Field label="Category"><input className="input" list="cats" disabled={!!edit.id} value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value.toUpperCase().replace(/\s+/g, '_') })} /><datalist id="cats">{cats.map((c) => <option key={c} value={c} />)}</datalist></Field><Field label="Code"><input className="input" disabled={!!edit.id} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase().replace(/\s+/g, '_') })} /></Field><Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Arabic name"><input className="input" dir="rtl" value={edit.nameAr} onChange={(e) => setEdit({ ...edit, nameAr: e.target.value })} /></Field><Field label="Sort order"><input type="number" className="input" value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value })} /></Field><label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={edit.isActive !== false} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} />Active</label><div className="flex justify-end sm:col-span-2"><button className="btn-primary" disabled={!edit.code || !edit.name} onClick={() => m.mutate()}>Save</button></div></div>}</Modal>
    </div>
  );
}

function Workflows() {
  const q = useQuery({ queryKey: ['workflow-defs'], queryFn: () => api<any[]>('/api/v1/workflows/definitions') });
  const { can } = useAuth();
  return <Card title="Approval chains" subtitle="Each business event maps to a versioned chain of steps (manager, role or user). Conditions can skip steps (e.g. amount thresholds)." padded={false} actions={can('workflows:write') && <Link href="/settings" className="btn-ghost btn-sm">Edit in settings <ChevronRight size={14} /></Link>}>
    {q.isLoading ? <TableSkeleton /> : q.data?.length ? <table className="data"><thead><tr><th>Event</th><th>Applies to</th><th>Steps</th><th>Version</th><th>Status</th></tr></thead><tbody>{q.data.filter((d) => d.isActive).map((d) => <tr key={d.id}><td className="font-medium">{d.name}<span className="block font-mono text-[10px] text-muted">{d.code}</span></td><td>{humanStatus(d.entityType)}</td><td className="text-xs">{(d.steps as any[]).map((s, i) => <span key={s.key} className="me-1 inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5"><b>{i + 1}</b> {s.key}{s.roleCode ? ` (${s.roleCode.replace(/_/g, ' ')})` : s.approverType === 'MANAGER' ? ' (line manager)' : ''}</span>)}</td><td>v{d.version}</td><td><Badge status="ACTIVE" /></td></tr>)}</tbody></table> : <EmptyState />}
  </Card>;
}

function Policies() {
  const { can } = useAuth();
  const pay = useQuery({ queryKey: ['payroll-policies'], queryFn: () => api<any[]>('/api/v1/payroll/policies'), enabled: can('payroll:read') });
  const leave = useQuery({ queryKey: ['leave-types'], queryFn: () => api<any[]>('/api/v1/leave/types'), enabled: can('leave:read') });
  return <div className="grid gap-4 xl:grid-cols-2">
    <Card title="Payroll policies" subtitle="Versioned; the run picks the policy effective for its period" padded={false}>{pay.isLoading ? <TableSkeleton /> : pay.data?.length ? <table className="data"><thead><tr><th>Policy</th><th>Effective</th><th>Version</th><th>Key settings</th></tr></thead><tbody>{pay.data.map((p) => <tr key={p.id}><td className="font-medium">{p.name ?? p.code}</td><td>{fmtDate(p.effectiveFrom)}{p.effectiveTo ? ` → ${fmtDate(p.effectiveTo)}` : ''}</td><td>v{p.version}</td><td className="text-xs text-muted">{Object.entries(p.config ?? {}).slice(0, 6).map(([k, v]) => `${humanStatus(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}</td></tr>)}</tbody></table> : <EmptyState />}<p className="px-4 py-3 text-xs text-muted">Gratuity, unpaid-leave and overtime formulas — REQUIRES HR/LEGAL SIGN-OFF.</p></Card>
    <Card title="Leave types & entitlements" padded={false}>{leave.isLoading ? <TableSkeleton /> : leave.data?.length ? <table className="data"><thead><tr><th>Type</th><th>Code</th><th>Paid</th><th>Annual days</th><th>Accrual</th></tr></thead><tbody>{leave.data.map((t) => <tr key={t.id}><td className="font-medium">{t.name}</td><td className="font-mono text-xs">{t.code}</td><td>{t.isPaid ? 'Paid' : 'Unpaid'}</td><td>{t.annualDays ?? t.entitlementDays ?? '—'}</td><td>{humanStatus(t.accrualMethod ?? t.accrual ?? '—')}</td></tr>)}</tbody></table> : <EmptyState />}<p className="px-4 py-3 text-xs text-muted">Statutory entitlements (annual, sick, maternity, Hajj…) — REQUIRES HR/LEGAL SIGN-OFF.</p></Card>
  </div>;
}

function Rules() {
  const { can } = useAuth();
  const ot = useQuery({ queryKey: ['ot-rules'], queryFn: () => api<any[]>('/api/v1/overtime/rules'), enabled: can('overtime:read') });
  const wp = useQuery({ queryKey: ['work-patterns'], queryFn: () => api<any[]>('/api/v1/shifts/work-patterns'), enabled: can('shifts:read') });
  return <div className="grid gap-4 xl:grid-cols-2">
    <Card title="Overtime rules" padded={false} actions={<Link href="/overtime" className="btn-ghost btn-sm">Manage <ChevronRight size={14} /></Link>}>{ot.isLoading ? <TableSkeleton /> : ot.data?.length ? <table className="data"><thead><tr><th>Rule</th><th>Day kind</th><th>Multiplier</th><th>Scope</th><th>Approval</th></tr></thead><tbody>{ot.data.map((r) => <tr key={r.id}><td className="font-medium">{r.name}</td><td>{humanStatus(r.dayKind)}</td><td>×{r.multiplier}</td><td>{humanStatus(r.scope)}</td><td className="text-xs">{r.requiresManagerApproval ? 'Manager' : '—'}{r.requiresHrApprovalOverMinutes ? ` · HR over ${r.requiresHrApprovalOverMinutes}m` : ''}</td></tr>)}</tbody></table> : <EmptyState />}<p className="px-4 py-3 text-xs text-muted">Multipliers (1.25 / 1.5 / holiday) — REQUIRES HR/LEGAL SIGN-OFF.</p></Card>
    <Card title="Work patterns" padded={false} actions={<Link href="/shifts" className="btn-ghost btn-sm">Manage <ChevronRight size={14} /></Link>}>{wp.isLoading ? <TableSkeleton /> : wp.data?.length ? <table className="data"><thead><tr><th>Pattern</th><th>Code</th><th>Week-off</th></tr></thead><tbody>{wp.data.map((p) => <tr key={p.id}><td className="font-medium">{p.name}</td><td className="font-mono text-xs">{p.code}</td><td className="text-xs">{Array.isArray(p.weekOffDays) ? p.weekOffDays.join(', ') : JSON.stringify(p.pattern ?? p.days ?? '—')}</td></tr>)}</tbody></table> : <EmptyState />}</Card>
    <div className="xl:col-span-2"><Card title="More configuration"><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{[['/talent/jobs', 'Grades & salary bands'], ['/documents/letters', 'Letter templates'], ['/talent/training', 'Training catalog'], ['/talent/performance', 'Performance cycles'], ['/organization', 'Departments, sites, projects, cost centers'], ['/shifts', 'Shifts, holidays & assignments'], ['/devices', 'Biometric devices'], ['/settings', 'Users, roles, integrations, audit']].map(([h, l]) => <Link key={h} href={h} className="flex items-center justify-between rounded-xl border px-3.5 py-3 text-sm font-medium transition hover:bg-brand-soft/50"><span className="flex items-center gap-2"><SlidersHorizontal size={14} className="text-brand" />{l}</span><ChevronRight size={14} className="text-muted" /></Link>)}</div></Card></div>
  </div>;
}
