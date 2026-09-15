'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, Field, PageHeader, TableSkeleton } from '@/components/ui';
import { EmployeePicker } from '@/components/employee-picker';

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <AppShell><Edit id={id} /></AppShell>; }

const PERSONAL: [string, string, string?][] = [['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'], ['fullNameAr', 'Arabic name'], ['dateOfBirth', 'Date of birth', 'date'], ['nationality', 'Nationality (ISO-2)'], ['mobile', 'Mobile'], ['workEmail', 'Work email', 'email'], ['personalEmail', 'Personal email', 'email'], ['emergencyContactName', 'Emergency contact'], ['emergencyContactPhone', 'Emergency phone'], ['emergencyContactRelation', 'Relation']];
const EMPLOYMENT: [string, string, string?][] = [['joiningDate', 'Joining date', 'date'], ['probationEndDate', 'Probation end', 'date'], ['contractStartDate', 'Contract start', 'date'], ['contractEndDate', 'Contract end', 'date'], ['matrixUserId', 'Matrix (biometric) user id'], ['grade', 'Grade (legacy code)']];

function Edit({ id }: { id: string }) {
  const { can } = useAuth();
  const router = useRouter();
  const e = useQuery({ queryKey: ['employee', id], queryFn: () => api<any>(`/api/v1/employees/${id}`) });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments') });
  const desigs = useQuery({ queryKey: ['org', 'designations'], queryFn: () => api<any[]>('/api/v1/org/designations') });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites') });
  const projects = useQuery({ queryKey: ['org', 'projects'], queryFn: () => api<any[]>('/api/v1/org/projects') });
  const ccs = useQuery({ queryKey: ['org', 'cost-centers'], queryFn: () => api<any[]>('/api/v1/org/cost-centers') });
  const [f, setF] = useState<Record<string, any>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (e.data) { const d = e.data; setF({ ...Object.fromEntries([...PERSONAL, ...EMPLOYMENT].map(([k]) => [k, d[k] ?? ''])), gender: d.gender, maritalStatus: d.maritalStatus, employmentType: d.employmentType, isOfficeStaff: d.isOfficeStaff, departmentId: d.department?.id ?? '', designationId: d.designation?.id ?? '', siteId: d.site?.id ?? '', projectId: d.project?.id ?? '', costCenterId: d.costCenter?.id ?? '', managerEmployeeId: d.manager?.id ?? '', reason: '' }); } }, [e.data]);
  const m = useMutation({
    mutationFn: () => { const body: Record<string, any> = {}; for (const [k, v] of Object.entries(f)) { const before = k in (e.data ?? {}) ? e.data[k] : ['departmentId', 'designationId', 'siteId', 'projectId', 'costCenterId', 'managerEmployeeId'].includes(k) ? (e.data?.[k.replace('Id', '')]?.id ?? '') : undefined; if (k === 'reason') { if (v) body.reason = v; continue; } if ((v ?? '') !== (before ?? '')) body[k] = v === '' ? null : v; } return api(`/api/v1/employees/${id}`, { method: 'PATCH', json: body }); },
    onSuccess: () => router.push(`/employees/${id}`), onError: (er: any) => setErr(er.message),
  });
  if (!can('employees:update')) return <Alert tone="danger">You do not have permission to edit employees.</Alert>;
  if (e.isLoading || !e.data) return <TableSkeleton />;
  const set = (k: string) => (ev: any) => setF({ ...f, [k]: ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value });
  const inp = (k: string, type = 'text') => <input type={type} className="input" value={f[k] ?? ''} onChange={set(k)} />;
  const sel = (k: string, opts: any[], label: (o: any) => string) => <select className="input" value={f[k] ?? ''} onChange={set(k)}><option value="">—</option>{opts.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}</select>;
  return (
    <>
      <PageHeader breadcrumb={<Link className="link" href={`/employees/${id}`}>{e.data.fullNameEn}</Link>} title="Edit profile" subtitle="Organisational changes here are recorded in employment history. Promotions, transfers and salary changes with approval should go through Actions on the profile." actions={<><Link href={`/employees/${id}`} className="btn-secondary">Cancel</Link><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Save changes'}</button></>} />
      {err && <div className="mb-4"><Alert tone="danger">{err}</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Personal"><div className="grid gap-3 sm:grid-cols-2">{PERSONAL.map(([k, l, t]) => <Field key={k} label={l}>{inp(k, t)}</Field>)}<Field label="Gender"><select className="input" value={f.gender ?? ''} onChange={set('gender')}>{['UNSPECIFIED', 'MALE', 'FEMALE'].map((g) => <option key={g}>{g}</option>)}</select></Field><Field label="Marital status"><select className="input" value={f.maritalStatus ?? ''} onChange={set('maritalStatus')}>{['UNSPECIFIED', 'SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'].map((g) => <option key={g}>{g}</option>)}</select></Field></div></Card>
        <Card title="Employment & organisation"><div className="grid gap-3 sm:grid-cols-2">{EMPLOYMENT.map(([k, l, t]) => <Field key={k} label={l}>{inp(k, t)}</Field>)}
          <Field label="Employment type"><select className="input" value={f.employmentType ?? ''} onChange={set('employmentType')}>{['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN', 'CONSULTANT'].map((g) => <option key={g}>{g}</option>)}</select></Field>
          <Field label="Department">{sel('departmentId', depts.data ?? [], (o) => o.name)}</Field><Field label="Designation">{sel('designationId', desigs.data ?? [], (o) => o.title)}</Field><Field label="Site">{sel('siteId', sites.data ?? [], (o) => o.name)}</Field><Field label="Project">{sel('projectId', projects.data ?? [], (o) => `${o.code} · ${o.name}`)}</Field><Field label="Cost center">{sel('costCenterId', ccs.data ?? [], (o) => `${o.code}${o.name ? ` · ${o.name}` : ''}`)}</Field>
          <Field label="Manager" className="sm:col-span-2"><EmployeePicker value={f.managerEmployeeId} exclude={[id]} onChange={(mid) => setF({ ...f, managerEmployeeId: mid ?? '' })} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={!!f.isOfficeStaff} onChange={set('isOfficeStaff')} />Office staff (gets IT onboarding items)</label>
          <Field label="Reason for change" className="sm:col-span-2">{inp('reason')}</Field></div></Card>
      </div>
    </>
  );
}
