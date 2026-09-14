'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Download } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, TableSkeleton, Alert } from '@/components/ui';
import { fmtDate } from '@/lib/format';

export default function Page() { return <AppShell><Employees /></AppShell>; }

function Employees() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState({ q: '', status: '', siteId: '', departmentId: '', page: 1, working: true });
  const [create, setCreate] = useState(false);
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites'), enabled: can('org:read') });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments'), enabled: can('org:read') });
  const list = useQuery({ queryKey: ['employees', f], queryFn: () => api<Paginated<any>>(`/api/v1/employees${qs({ ...f, pageSize: 25, working: f.status ? undefined : f.working })}`), placeholderData: (p) => p });
  return (
    <>
      <PageHeader title="Employees" subtitle={list.data ? `${list.data.meta.total.toLocaleString()} people` : ''} actions={<>{can('reports:hr') && <a className="btn-secondary" href="/api/v1/reports/hr/employee-list?format=csv" onClick={(e) => { e.preventDefault(); api<string>('/api/v1/reports/hr/employee-list?format=csv', { raw: true }).then((csv) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'employees.csv'; a.click(); }); }}><Download size={15} />Export</a>}{can('employees:create') && <button className="btn-primary" onClick={() => setCreate(true)}><Plus size={15} />New employee</button>}</>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b p-3">
          <input className="input sm:max-w-xs" placeholder="Search name, number, mobile…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
          <select className="input sm:w-44" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">Working statuses</option>{['CANDIDATE', 'OFFER', 'ONBOARDING', 'ACTIVE', 'PROBATION', 'CONFIRMED', 'RESIGNED', 'CLEARANCE', 'ARCHIVED'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
          {sites.data && <select className="input sm:w-52" value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value, page: 1 })}><option value="">All sites</option>{sites.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          {depts.data && <select className="input sm:w-52" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value, page: 1 })}><option value="">All departments</option>{depts.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        </div>
        {list.isLoading ? <TableSkeleton /> : list.data?.data.length ? (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Designation</th><th>Department</th><th>Site</th><th>Project</th><th>Joined</th><th>Status</th></tr></thead><tbody>
            {list.data.data.map((e) => <tr key={e.id}><td><Link href={`/employees/${e.id}`} className="flex items-center gap-3"><Avatar name={e.fullNameEn} size="sm" /><span><span className="block font-medium hover:underline">{e.fullNameEn}</span><span className="block text-[11px] text-muted">{e.employeeNo}{e.fullNameAr ? ` · ${e.fullNameAr}` : ''}</span></span></Link></td><td>{e.designation?.title ?? '—'}</td><td>{e.department?.name ?? '—'}</td><td>{e.site?.name ?? '—'}</td><td>{e.project?.code ?? '—'}</td><td>{fmtDate(e.joiningDate)}</td><td><Badge status={e.status} /></td></tr>)}
          </tbody></table></div>
        ) : <EmptyState hint="Try a different filter or create a new employee." />}
        {list.data && <Pagination page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
      <CreateEmployee open={create} onClose={() => setCreate(false)} sites={sites.data ?? []} depts={depts.data ?? []} onCreated={() => qc.invalidateQueries({ queryKey: ['employees'] })} />
    </>
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
