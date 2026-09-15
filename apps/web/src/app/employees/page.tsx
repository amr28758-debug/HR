'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Download, List, LayoutGrid, Rows3, Layers } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, TableSkeleton, Alert, cn } from '@/components/ui';
import { fmtDate, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Employees /></AppShell>; }

function Employees() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const sp = useSearchParams();
  const [f, setF] = useState({ q: '', status: sp.get('status') ?? '', siteId: '', departmentId: '', projectId: '', gradeId: '', nationality: '', probation: sp.get('probation') ?? '', contract: sp.get('contract') ?? '', missing: sp.get('missing') ?? '', page: 1, working: !sp.get('status') });
  const [view, setView] = useState<'table' | 'grid' | 'compact'>(() => (typeof window !== 'undefined' && (window.localStorage.getItem('bpw.dirView') as any)) || 'table');
  const [create, setCreate] = useState(sp.get('new') === '1');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(sp.get('bulk') === '1');
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites'), enabled: can('org:read') });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments'), enabled: can('org:read') });
  const projects = useQuery({ queryKey: ['org', 'projects'], queryFn: () => api<any[]>('/api/v1/org/projects'), enabled: can('org:read') });
  const grades = useQuery({ queryKey: ['jobs', 'grades'], queryFn: () => api<any[]>('/api/v1/jobs/grades'), enabled: can('jobs:read') });
  const pageSize = view === 'compact' ? 50 : 25;
  const list = useQuery({ queryKey: ['employees', f, pageSize], queryFn: () => api<Paginated<any>>(`/api/v1/employees${qs({ ...f, pageSize, working: f.status ? undefined : f.working })}`), placeholderData: (p) => p });
  const setView2 = (v: typeof view) => { setView(v); try { window.localStorage.setItem('bpw.dirView', v); } catch { /* ignore */ } };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const rows = list.data?.data ?? [];
  const allOnPage = rows.length > 0 && rows.every((e) => selected.has(e.id));
  const chips = [['probation', 'due', 'Probation due'], ['probation', 'overdue', 'Probation overdue'], ['contract', 'expiring', 'Contract expiring'], ['missing', 'iban', 'No IBAN'], ['missing', 'biometric', 'No biometric'], ['missing', 'salary', 'No salary']] as const;
  return (
    <>
      <PageHeader eyebrow="People" title="Directory" subtitle={list.data ? `${list.data.meta.total.toLocaleString()} people` : ''} actions={<>
        <div className="inline-flex rounded-xl border bg-surface p-0.5">{([['table', List], ['grid', LayoutGrid], ['compact', Rows3]] as const).map(([v, Icon]) => <button key={v} title={v} onClick={() => setView2(v)} className={cn('rounded-lg px-2.5 py-1.5 transition', view === v ? 'bg-brand text-brand-fg' : 'text-muted hover:text-fg')}><Icon size={15} /></button>)}</div>
        {can('bulk:run') && <button className="btn-secondary" onClick={() => setBulk(true)}><Layers size={15} />Bulk{selected.size ? ` (${selected.size})` : ''}</button>}
        {can('reports:hr') && <a className="btn-secondary" href="/api/v1/reports/hr/employee-list?format=csv" onClick={(e) => { e.preventDefault(); api<string>('/api/v1/reports/hr/employee-list?format=csv', { raw: true }).then((csv) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'employees.csv'; a.click(); }); }}><Download size={15} />Export</a>}
        {can('employees:create') && <button className="btn-primary" onClick={() => setCreate(true)}><Plus size={15} />New employee</button>}</>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b p-3">
          <input className="input sm:max-w-xs" placeholder="Search name, number, mobile…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
          <select className="input sm:w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">Working statuses</option>{['CANDIDATE', 'OFFER', 'ONBOARDING', 'ACTIVE', 'PROBATION', 'CONFIRMED', 'RESIGNED', 'CLEARANCE', 'TERMINATED', 'ARCHIVED'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select>
          {sites.data && <select className="input sm:w-44" value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value, page: 1 })}><option value="">All sites</option>{sites.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          {depts.data && <select className="input sm:w-44" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value, page: 1 })}><option value="">All departments</option>{depts.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          {projects.data && <select className="input sm:w-44" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value, page: 1 })}><option value="">All projects</option>{projects.data.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select>}
          {grades.data && <select className="input sm:w-32" value={f.gradeId} onChange={(e) => setF({ ...f, gradeId: e.target.value, page: 1 })}><option value="">All grades</option>{grades.data.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select>}
          <input className="input sm:w-24 uppercase" placeholder="Nat." maxLength={2} value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value.toUpperCase(), page: 1 })} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2 text-xs">{chips.map(([k, v, l]) => { const on = (f as any)[k] === v; return <button key={k + v} onClick={() => setF({ ...f, [k]: on ? '' : v, page: 1 })} className={cn('rounded-full px-2.5 py-1 font-semibold transition', on ? 'bg-accent text-white' : 'bg-surface-2 text-muted hover:text-fg')}>{l}</button>; })}{(f.probation || f.contract || f.missing || f.gradeId || f.nationality) && <button className="ms-2 text-muted underline" onClick={() => setF({ ...f, probation: '', contract: '', missing: '', gradeId: '', nationality: '', page: 1 })}>Clear</button>}</div>
        {list.isLoading ? <TableSkeleton /> : rows.length ? (
          view === 'grid' ? <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{rows.map((e) => <div key={e.id} className={cn('card card-hover relative p-4', selected.has(e.id) && 'ring-2 ring-accent')}>{can('bulk:run') && <input type="checkbox" className="absolute end-3 top-3" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />}<Link href={`/employees/${e.id}`} className="flex items-center gap-3"><Avatar name={e.fullNameEn} size="lg" /><span className="min-w-0"><span className="block truncate font-semibold hover:underline">{e.fullNameEn}</span><span className="block truncate text-[11px] text-muted">{e.employeeNo}{e.fullNameAr ? ` · ${e.fullNameAr}` : ''}</span></span></Link><p className="mt-3 truncate text-sm">{e.designation?.title ?? '—'}</p><p className="truncate text-xs text-muted">{[e.department?.name, e.site?.name].filter(Boolean).join(' · ') || '—'}</p><div className="mt-3 flex items-center justify-between"><Badge status={e.status} /><span className="text-[11px] text-muted">{e.joiningDate ? `Joined ${fmtDate(e.joiningDate)}` : ''}</span></div></div>)}</div>
          : view === 'compact' ? <ul className="divide-y">{rows.map((e) => <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm">{can('bulk:run') && <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />}<Link href={`/employees/${e.id}`} className="w-24 shrink-0 font-mono text-xs text-muted hover:underline">{e.employeeNo}</Link><Link href={`/employees/${e.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{e.fullNameEn}</Link><span className="hidden w-48 truncate text-muted md:block">{e.designation?.title ?? '—'}</span><span className="hidden w-40 truncate text-muted lg:block">{e.project?.code ?? e.site?.name ?? '—'}</span><Badge status={e.status} /></li>)}</ul>
          : <div className="overflow-x-auto"><table className="data"><thead><tr>{can('bulk:run') && <th className="w-8"><input type="checkbox" checked={allOnPage} onChange={() => setSelected((s) => { const n = new Set(s); if (allOnPage) rows.forEach((e) => n.delete(e.id)); else rows.forEach((e) => n.add(e.id)); return n; })} /></th>}<th>Employee</th><th>Designation</th><th>Department</th><th>Site</th><th>Project</th><th>Joined</th><th>Status</th></tr></thead><tbody>
            {rows.map((e) => <tr key={e.id} className={cn(selected.has(e.id) && 'bg-accent-soft/40')}>{can('bulk:run') && <td><input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} /></td>}<td><Link href={`/employees/${e.id}`} className="flex items-center gap-3"><Avatar name={e.fullNameEn} size="sm" /><span><span className="block font-medium hover:underline">{e.fullNameEn}</span><span className="block text-[11px] text-muted">{e.employeeNo}{e.fullNameAr ? ` · ${e.fullNameAr}` : ''}</span></span></Link></td><td>{e.designation?.title ?? '—'}</td><td>{e.department?.name ?? '—'}</td><td>{e.site?.name ?? '—'}</td><td>{e.project ? `${e.project.code}` : '—'}</td><td>{fmtDate(e.joiningDate)}</td><td><Badge status={e.status} /></td></tr>)}
          </tbody></table></div>
        ) : <EmptyState hint="Try a different filter or create a new employee." />}
        {list.data && <Pagination page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
      <CreateEmployee open={create} onClose={() => setCreate(false)} sites={sites.data ?? []} depts={depts.data ?? []} onCreated={() => qc.invalidateQueries({ queryKey: ['employees'] })} />
      <BulkModal open={bulk} onClose={() => setBulk(false)} ids={[...selected]} onDone={() => { setSelected(new Set()); qc.invalidateQueries({ queryKey: ['hr-requests'] }); }} />
    </>
  );
}

/** Bulk operations: preview (eligibility per employee) → confirm → per-employee result. Each confirmed row becomes an HR request. */
function BulkModal({ open, onClose, ids, onDone }: { open: boolean; onClose: () => void; ids: string[]; onDone: () => void }) {
  const [action, setAction] = useState('TRAINING');
  const [f, setF] = useState<Record<string, any>>({});
  const [result, setResult] = useState<any | null>(null);
  const courses = useQuery({ queryKey: ['training', 'catalog'], queryFn: () => api<any[]>('/api/v1/people/training/catalog'), enabled: open && action === 'TRAINING' });
  const projects = useQuery({ queryKey: ['org', 'projects'], queryFn: () => api<any[]>('/api/v1/org/projects'), enabled: open && action === 'TRANSFER' });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites'), enabled: open && action === 'TRANSFER' });
  const templates = useQuery({ queryKey: ['letters', 'templates'], queryFn: () => api<any[]>('/api/v1/letters/templates'), enabled: open && action === 'LETTER' });
  const n = new Date();
  const payload = () => { const p: Record<string, any> = {}; for (const [k, v] of Object.entries(f)) if (v !== '' && v !== undefined && !['effectiveDate', 'reason'].includes(k)) p[k] = ['amount', 'percentage', 'periodYear', 'periodMonth', 'cost'].includes(k) ? Number(v) : v; if (['BONUS', 'DEDUCTION'].includes(action)) { p.periodYear ??= n.getFullYear(); p.periodMonth ??= n.getMonth() + 1; } return p; };
  const run = useMutation({ mutationFn: (confirm: boolean) => api<any>('/api/v1/employees/bulk', { method: 'POST', json: { employeeIds: ids, action, payload: payload(), effectiveDate: f.effectiveDate || undefined, reason: f.reason || undefined, confirm } }), onSuccess: (r) => { setResult(r); if (r.mode === 'APPLIED') onDone(); } });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const sel = (k: string, opts: { v: string; l: string }[], ph: string) => <select className="input" value={f[k] ?? ''} onChange={set(k)}><option value="">{ph}</option>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>;
  return (
    <Modal open={open} onClose={() => { setResult(null); onClose(); }} title={`Bulk operation · ${ids.length} selected`} wide>
      {ids.length === 0 ? <Alert tone="info">Select employees in the directory first (checkboxes), then open Bulk.</Alert> : <div className="space-y-3">
        <Field label="Action"><select className="input" value={action} onChange={(e) => { setAction(e.target.value); setF({}); setResult(null); }}>{[['TRAINING', 'Assign training'], ['TRANSFER', 'Transfer (project / site)'], ['BONUS', 'Bonus'], ['DEDUCTION', 'Deduction'], ['LETTER', 'Generate letter'], ['SALARY_CHANGE', 'Salary change (%)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        {action === 'TRAINING' && <div className="grid gap-3 sm:grid-cols-2"><Field label="Course">{sel('courseId', (courses.data ?? []).map((c) => ({ v: c.id, l: `${c.code} · ${c.title}` })), 'Choose…')}</Field><Field label="Scheduled date"><input type="date" className="input" value={f.scheduledDate ?? ''} onChange={set('scheduledDate')} /></Field></div>}
        {action === 'TRANSFER' && <div className="grid gap-3 sm:grid-cols-2"><Field label="Project">{sel('projectId', (projects.data ?? []).map((c) => ({ v: c.id, l: `${c.code} · ${c.name}` })), 'Keep current')}</Field><Field label="Site">{sel('siteId', (sites.data ?? []).map((c) => ({ v: c.id, l: c.name })), 'Keep current')}</Field></div>}
        {action === 'BONUS' && <div className="grid gap-3 sm:grid-cols-3"><Field label="Bonus type"><input className="input" value={f.bonusType ?? 'PERFORMANCE'} onChange={set('bonusType')} /></Field><Field label="Amount (AED)"><input type="number" className="input" value={f.amount ?? ''} onChange={set('amount')} /></Field><Field label="or % of basic"><input type="number" className="input" value={f.percentage ?? ''} onChange={set('percentage')} /></Field></div>}
        {action === 'DEDUCTION' && <div className="grid gap-3 sm:grid-cols-2"><Field label="Component">{sel('componentCode', [{ v: 'PENALTY', l: 'Penalty' }, { v: 'ASSET_DAMAGE', l: 'Asset damage' }], 'PENALTY')}</Field><Field label="Amount (AED)"><input type="number" className="input" value={f.amount ?? ''} onChange={set('amount')} /></Field></div>}
        {action === 'LETTER' && <Field label="Template">{sel('templateCode', (templates.data ?? []).map((t) => ({ v: t.code, l: t.name })), 'Choose…')}</Field>}
        {action === 'SALARY_CHANGE' && <Field label="Change all fixed earnings by %"><input type="number" step={0.5} className="input" value={f.percentage ?? ''} onChange={set('percentage')} /></Field>}
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Effective date"><input type="date" className="input" value={f.effectiveDate ?? ''} onChange={set('effectiveDate')} /></Field><Field label="Reason"><input className="input" value={f.reason ?? ''} onChange={set('reason')} /></Field></div>
        {result && <div className="rounded-2xl border"><div className="flex items-center justify-between border-b px-4 py-2 text-sm"><span className="font-semibold">{result.mode === 'PREVIEW' ? 'Preview' : 'Result'} · {result.eligible} of {result.total} {result.mode === 'PREVIEW' ? 'eligible' : 'succeeded'}</span>{result.skipped > 0 && <Badge status="PENDING">{result.skipped} skipped</Badge>}</div><div className="max-h-64 overflow-y-auto"><table className="data"><thead><tr><th>Employee</th><th>Status</th><th>Outcome</th><th>Request</th></tr></thead><tbody>{result.results.map((r: any) => <tr key={r.employeeId}><td>{r.name}<span className="block text-[11px] text-muted">{r.employeeNo}</span></td><td><Badge status={r.status} /></td><td className={r.ok ? 'text-success' : 'text-danger'}>{r.message}</td><td>{r.requestId ? <Link className="link text-xs" href={`/requests/${r.requestId}`}>{r.requestNo}</Link> : '—'}</td></tr>)}</tbody></table></div></div>}
        {run.isError && <Alert tone="danger">{(run.error as Error).message}</Alert>}
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => run.mutate(false)} disabled={run.isPending}>Preview</button><button className="btn-primary" disabled={run.isPending || result?.mode !== 'PREVIEW'} onClick={() => run.mutate(true)}>Confirm {result?.eligible ? `(${result.eligible})` : ''}</button></div>
        {result?.mode !== 'PREVIEW' && !result && <p className="text-xs text-muted">Run a preview first — it shows who is eligible and what will change before anything is submitted.</p>}
      </div>}
    </Modal>
  );
}

function CreateEmployee({ open, onClose, sites, depts, onCreated }: { open: boolean; onClose: () => void; sites: any[]; depts: any[]; onCreated: () => void }) {
  const [form, setForm] = useState<any>({ firstName: '', lastName: '', gender: 'MALE', employmentType: 'FULL_TIME', status: 'CANDIDATE', isOfficeStaff: false });
  const desigs = useQuery({ queryKey: ['org', 'designations'], queryFn: () => api<any[]>('/api/v1/org/designations'), enabled: open });
  const m = useMutation({ mutationFn: () => api('/api/v1/employees', { method: 'POST', json: Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '')) }), onSuccess: () => { onCreated(); onClose(); } });
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New employee" wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name"><input className="input" value={form.firstName} onChange={set('firstName')} /></Field><Field label="Last name"><input className="input" value={form.lastName} onChange={set('lastName')} /></Field>
        <Field label="Arabic name"><input className="input" dir="rtl" value={form.fullNameAr ?? ''} onChange={set('fullNameAr')} /></Field><Field label="Employee number" hint="Leave blank to auto-generate"><input className="input" placeholder="BP-26-…" value={form.employeeNo ?? ''} onChange={set('employeeNo')} /></Field>
        <Field label="Gender"><select className="input" value={form.gender} onChange={set('gender')}>{['MALE', 'FEMALE', 'UNSPECIFIED'].map((g) => <option key={g}>{g}</option>)}</select></Field><Field label="Nationality (ISO-2)"><input className="input" maxLength={2} value={form.nationality ?? ''} onChange={set('nationality')} /></Field>
        <Field label="Mobile"><input className="input" value={form.mobile ?? ''} onChange={set('mobile')} /></Field><Field label="Work email"><input className="input" type="email" value={form.workEmail ?? ''} onChange={set('workEmail')} /></Field>
        <Field label="Joining date"><input className="input" type="date" value={form.joiningDate ?? ''} onChange={set('joiningDate')} /></Field><Field label="Employment type"><select className="input" value={form.employmentType} onChange={set('employmentType')}>{['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN', 'DAILY_WAGE'].map((g) => <option key={g}>{g}</option>)}</select></Field>
        <Field label="Site"><select className="input" value={form.siteId ?? ''} onChange={set('siteId')}><option value="">—</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Department"><select className="input" value={form.departmentId ?? ''} onChange={set('departmentId')}><option value="">—</option>{depts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Designation"><select className="input" value={form.designationId ?? ''} onChange={set('designationId')}><option value="">—</option>{desigs.data?.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Field><Field label="Matrix user ID" hint="Biometric device user id"><input className="input" value={form.matrixUserId ?? ''} onChange={set('matrixUserId')} /></Field>
        <Field label="Initial status"><select className="input" value={form.status} onChange={set('status')}>{['CANDIDATE', 'OFFER', 'ACTIVE', 'PROBATION'].map((g) => <option key={g}>{g}</option>)}</select></Field><label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={form.isOfficeStaff} onChange={set('isOfficeStaff')} />Office staff (gets email / M365 / laptop onboarding tasks)</label>
      </div>
      {m.error && <div className="mt-4"><Alert tone="danger">{(m.error as Error).message}</Alert></div>}
      <div className="mt-5 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending || !form.firstName || !form.lastName} onClick={() => m.mutate()}>Create</button></div>
    </Modal>
  );
}
