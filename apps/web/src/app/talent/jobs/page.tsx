'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Tabs, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, fmtMoney, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Jobs /></AppShell>; }
type Tab = 'architecture' | 'grades' | 'descriptions';

function Jobs() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('architecture');
  return (
    <>
      <PageHeader eyebrow="Talent" title="Job architecture" subtitle="Job family → function → title → grade → career level. Grades carry salary bands; job descriptions are versioned and approved." />
      <Tabs tabs={[{ key: 'architecture', label: 'Families & titles' }, { key: 'grades', label: 'Grades & bands' }, { key: 'descriptions', label: 'Job descriptions' }]} value={tab} onChange={setTab} />
      {tab === 'architecture' && <Architecture canWrite={can('jobs:write')} />}
      {tab === 'grades' && <Grades canWrite={can('jobs:write')} canSalary={can('salary:read')} />}
      {tab === 'descriptions' && <Descriptions canWrite={can('jobs:write')} />}
    </>
  );
}

function Architecture({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const fam = useQuery({ queryKey: ['jobs', 'families'], queryFn: () => api<any[]>('/api/v1/jobs/families') });
  const titles = useQuery({ queryKey: ['jobs', 'titles'], queryFn: () => api<any[]>('/api/v1/jobs/titles') });
  const grades = useQuery({ queryKey: ['jobs', 'grades'], queryFn: () => api<any[]>('/api/v1/jobs/grades') });
  const levels = useQuery({ queryKey: ['jobs', 'career-levels'], queryFn: () => api<any[]>('/api/v1/jobs/career-levels') });
  const [newFam, setNewFam] = useState<{ code: string; name: string } | null>(null);
  const [newFn, setNewFn] = useState<{ jobFamilyId: string; code: string; name: string } | null>(null);
  const [link, setLink] = useState<any | null>(null);
  const inv = () => { qc.invalidateQueries({ queryKey: ['jobs'] }); qc.invalidateQueries({ queryKey: ['org', 'designations'] }); };
  const mFam = useMutation({ mutationFn: () => api('/api/v1/jobs/families', { method: 'POST', json: newFam }), onSuccess: () => { setNewFam(null); inv(); } });
  const mFn = useMutation({ mutationFn: () => api('/api/v1/jobs/functions', { method: 'POST', json: newFn }), onSuccess: () => { setNewFn(null); inv(); } });
  const mLink = useMutation({ mutationFn: () => api(`/api/v1/jobs/titles/${link.id}`, { method: 'PATCH', json: { jobFamilyId: link.jobFamilyId || null, jobFunctionId: link.jobFunctionId || null, defaultGradeId: link.defaultGradeId || null, careerLevelId: link.careerLevelId || null } }), onSuccess: () => { setLink(null); inv(); } });
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card title="Job families & functions" className="lg:col-span-2" actions={canWrite && <button className="btn-primary btn-sm" onClick={() => setNewFam({ code: '', name: '' })}><Plus size={14} />Family</button>}>
        {fam.isLoading ? <TableSkeleton /> : fam.data?.length ? <div className="space-y-3">{fam.data.map((f) => <div key={f.id} className="rounded-xl border p-3"><div className="flex items-center justify-between"><p className="font-semibold">{f.name} <span className="text-xs text-muted">{f.code}</span></p>{canWrite && <button className="btn-ghost btn-sm" onClick={() => setNewFn({ jobFamilyId: f.id, code: '', name: '' })}><Plus size={13} />Function</button>}</div><div className="mt-2 flex flex-wrap gap-1.5">{f.functions.map((fn: any) => <span key={fn.id} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium">{fn.name}</span>)}{!f.functions.length && <span className="text-xs text-muted">No functions yet</span>}</div></div>)}</div> : <EmptyState />}
      </Card>
      <Card title="Job titles" subtitle="Each title links to a family, function, default grade and career level" className="lg:col-span-3" padded={false}>
        {titles.isLoading ? <TableSkeleton /> : <div className="overflow-x-auto"><table className="data"><thead><tr><th>Title</th><th>Employees</th><th>Family / function</th><th>Default grade</th><th>Level</th><th></th></tr></thead><tbody>{titles.data?.map((t) => <tr key={t.id}><td className="font-medium">{t.title}</td><td>{t.employees}</td><td>{[t.jobFamilyName, t.jobFunctionName].filter(Boolean).join(' / ') || <span className="text-muted">unlinked</span>}</td><td>{t.defaultGradeCode ?? t.grade ?? '—'}</td><td>{t.careerLevelCode ?? '—'}</td><td>{canWrite && <button className="btn-ghost btn-sm" onClick={() => setLink({ id: t.id, title: t.title, jobFamilyId: t.jobFamilyId ?? '', jobFunctionId: t.jobFunctionId ?? '', defaultGradeId: t.defaultGradeId ?? '', careerLevelId: t.careerLevelId ?? '' })}>Link</button>}</td></tr>)}</tbody></table></div>}
      </Card>
      <Modal open={!!newFam} onClose={() => setNewFam(null)} title="New job family">{newFam && <div className="space-y-3"><Field label="Code"><input className="input" value={newFam.code} onChange={(e) => setNewFam({ ...newFam, code: e.target.value.toUpperCase() })} /></Field><Field label="Name"><input className="input" value={newFam.name} onChange={(e) => setNewFam({ ...newFam, name: e.target.value })} /></Field><div className="flex justify-end"><button className="btn-primary" onClick={() => mFam.mutate()}>Create</button></div></div>}</Modal>
      <Modal open={!!newFn} onClose={() => setNewFn(null)} title="New job function">{newFn && <div className="space-y-3"><Field label="Code"><input className="input" value={newFn.code} onChange={(e) => setNewFn({ ...newFn, code: e.target.value.toUpperCase() })} /></Field><Field label="Name"><input className="input" value={newFn.name} onChange={(e) => setNewFn({ ...newFn, name: e.target.value })} /></Field><div className="flex justify-end"><button className="btn-primary" onClick={() => mFn.mutate()}>Create</button></div></div>}</Modal>
      <Modal open={!!link} onClose={() => setLink(null)} title={link ? `Link “${link.title}”` : ''}>{link && <div className="space-y-3">
        <Field label="Job family"><select className="input" value={link.jobFamilyId} onChange={(e) => setLink({ ...link, jobFamilyId: e.target.value, jobFunctionId: '' })}><option value="">—</option>{fam.data?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
        <Field label="Job function"><select className="input" value={link.jobFunctionId} onChange={(e) => setLink({ ...link, jobFunctionId: e.target.value })}><option value="">—</option>{fam.data?.find((f) => f.id === link.jobFamilyId)?.functions.map((fn: any) => <option key={fn.id} value={fn.id}>{fn.name}</option>)}</select></Field>
        <Field label="Default grade"><select className="input" value={link.defaultGradeId} onChange={(e) => setLink({ ...link, defaultGradeId: e.target.value })}><option value="">—</option>{grades.data?.map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name}</option>)}</select></Field>
        <Field label="Career level"><select className="input" value={link.careerLevelId} onChange={(e) => setLink({ ...link, careerLevelId: e.target.value })}><option value="">—</option>{levels.data?.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></Field>
        <div className="flex justify-end"><button className="btn-primary" onClick={() => mLink.mutate()}>Save</button></div></div>}</Modal>
    </div>
  );
}

function Grades({ canWrite, canSalary }: { canWrite: boolean; canSalary: boolean }) {
  const qc = useQueryClient();
  const grades = useQuery({ queryKey: ['jobs', 'grades'], queryFn: () => api<any[]>('/api/v1/jobs/grades') });
  const levels = useQuery({ queryKey: ['jobs', 'career-levels'], queryFn: () => api<any[]>('/api/v1/jobs/career-levels') });
  const [edit, setEdit] = useState<any | null>(null);
  const m = useMutation({ mutationFn: () => api('/api/v1/jobs/grades', { method: 'POST', json: { code: edit.code, name: edit.name, careerLevelId: edit.careerLevelId || null, minSalary: edit.minSalary === '' ? null : Number(edit.minSalary), midSalary: edit.midSalary === '' ? null : Number(edit.midSalary), maxSalary: edit.maxSalary === '' ? null : Number(edit.maxSalary), sortOrder: Number(edit.sortOrder ?? 100) } }), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['jobs'] }); } });
  const maxBand = Math.max(1, ...(grades.data ?? []).map((g) => g.maxSalary ?? 0));
  return (
    <div className="space-y-4">
      <Alert tone="warning">Salary bands are company policy examples seeded for demonstration — REQUIRES HR CONFIRMATION before use in decisions.</Alert>
      <Card title="Grades" subtitle="Band, occupancy and average basic" padded={false} actions={canWrite && <button className="btn-primary btn-sm" onClick={() => setEdit({ code: '', name: '', careerLevelId: '', minSalary: '', midSalary: '', maxSalary: '', sortOrder: 100 })}><Plus size={14} />Grade</button>}>
        {grades.isLoading ? <TableSkeleton /> : <div className="overflow-x-auto"><table className="data"><thead><tr><th>Grade</th><th>Level</th><th>Band (AED)</th><th className="w-64">Range</th><th>Employees</th>{canSalary && <th>Avg basic</th>}<th></th></tr></thead><tbody>{grades.data?.map((g) => <tr key={g.id}><td className="font-semibold">{g.code}<span className="block text-[11px] font-normal text-muted">{g.name}</span></td><td>{g.careerLevel ?? '—'}</td><td className="tabular-nums">{g.minSalary !== null ? `${fmtMoney(g.minSalary)} – ${fmtMoney(g.maxSalary)}` : '—'}<span className="block text-[11px] text-muted">mid {g.midSalary !== null ? fmtMoney(g.midSalary) : '—'}</span></td><td>{g.minSalary !== null && <div className="relative h-2 rounded-full bg-surface-2"><div className="absolute h-2 rounded-full bg-gradient-to-r from-brand to-accent" style={{ insetInlineStart: `${(g.minSalary / maxBand) * 100}%`, width: `${((g.maxSalary - g.minSalary) / maxBand) * 100}%` }} /></div>}</td><td>{g.employees}</td>{canSalary && <td className={cn('tabular-nums', g.avgBasic !== null && g.minSalary !== null && (g.avgBasic < g.minSalary || g.avgBasic > g.maxSalary) && 'text-warning')}>{g.avgBasic !== null ? fmtMoney(g.avgBasic) : '—'}</td>}<td>{canWrite && <button className="btn-ghost btn-sm" onClick={() => setEdit({ ...g, careerLevelId: g.careerLevelId ?? '', minSalary: g.minSalary ?? '', midSalary: g.midSalary ?? '', maxSalary: g.maxSalary ?? '' })}>Edit</button>}</td></tr>)}</tbody></table></div>}
      </Card>
      <Card title="Career levels" padded={false}>{levels.data && <table className="data"><thead><tr><th>Rank</th><th>Code</th><th>Name</th><th>Description</th></tr></thead><tbody>{levels.data.map((l) => <tr key={l.id}><td>{l.rank}</td><td className="font-semibold">{l.code}</td><td>{l.name}</td><td className="text-muted">{l.description ?? '—'}</td></tr>)}</tbody></table>}</Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit grade ${edit.code}` : 'New grade'}>{edit && <div className="grid gap-3 sm:grid-cols-2"><Field label="Code"><input className="input" value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field><Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Career level"><select className="input" value={edit.careerLevelId} onChange={(e) => setEdit({ ...edit, careerLevelId: e.target.value })}><option value="">—</option>{levels.data?.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></Field><Field label="Sort order"><input type="number" className="input" value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value })} /></Field><Field label="Min basic"><input type="number" className="input" value={edit.minSalary} onChange={(e) => setEdit({ ...edit, minSalary: e.target.value })} /></Field><Field label="Mid"><input type="number" className="input" value={edit.midSalary} onChange={(e) => setEdit({ ...edit, midSalary: e.target.value })} /></Field><Field label="Max basic"><input type="number" className="input" value={edit.maxSalary} onChange={(e) => setEdit({ ...edit, maxSalary: e.target.value })} /></Field><div className="flex items-end justify-end"><button className="btn-primary" onClick={() => m.mutate()}>Save</button></div></div>}</Modal>
    </div>
  );
}

function Descriptions({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['jobs', 'descriptions'], queryFn: () => api<any[]>('/api/v1/jobs/descriptions') });
  const titles = useQuery({ queryKey: ['org', 'designations'], queryFn: () => api<any[]>('/api/v1/org/designations') });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['jd-detail', sel], queryFn: () => api<any>(`/api/v1/jobs/descriptions/${sel}`), enabled: !!sel });
  const [create, setCreate] = useState<any | null>(null);
  const [ver, setVer] = useState<any | null>(null);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const inv = () => { qc.invalidateQueries({ queryKey: ['jobs'] }); qc.invalidateQueries({ queryKey: ['jd-detail'] }); };
  const mCreate = useMutation({ mutationFn: () => api<any>('/api/v1/jobs/descriptions', { method: 'POST', json: { code: create.code, designationId: create.designationId, location: create.location || null, effectiveFrom: create.effectiveFrom, purpose: create.purpose || null, responsibilities: lines(create.responsibilities ?? ''), qualifications: lines(create.qualifications ?? ''), skills: lines(create.skills ?? ''), kpis: lines(create.kpis ?? ''), requiredCertifications: lines(create.certs ?? '') } }), onSuccess: (r) => { setCreate(null); inv(); setSel(r.id); } });
  const mVer = useMutation({ mutationFn: () => api(`/api/v1/jobs/descriptions/${sel}/versions`, { method: 'POST', json: { effectiveFrom: ver.effectiveFrom, purpose: ver.purpose || null, responsibilities: lines(ver.responsibilities ?? ''), qualifications: lines(ver.qualifications ?? ''), skills: lines(ver.skills ?? ''), kpis: lines(ver.kpis ?? ''), requiredCertifications: lines(ver.certs ?? '') } }), onSuccess: () => { setVer(null); inv(); } });
  const approve = useMutation({ mutationFn: (vid: string) => api(`/api/v1/jobs/descriptions/${sel}/versions/${vid}/approve`, { method: 'POST' }), onSuccess: inv });
  const linkEmp = useMutation({ mutationFn: () => api(`/api/v1/jobs/descriptions/${sel}/link-employees`, { method: 'POST' }), onSuccess: inv });
  const F = (label: string, k: string, o: any, setO: (x: any) => void, area = false) => <Field label={label}>{area ? <textarea className="input min-h-20" placeholder="One item per line" value={o[k] ?? ''} onChange={(e) => setO({ ...o, [k]: e.target.value })} /> : <input className="input" type={k === 'effectiveFrom' ? 'date' : 'text'} value={o[k] ?? ''} onChange={(e) => setO({ ...o, [k]: e.target.value })} />}</Field>;
  const form = (o: any, setO: (x: any) => void) => <>{F('Effective from', 'effectiveFrom', o, setO)}{F('Purpose', 'purpose', o, setO)}{F('Responsibilities', 'responsibilities', o, setO, true)}{F('Qualifications', 'qualifications', o, setO, true)}{F('Skills', 'skills', o, setO, true)}{F('KPIs', 'kpis', o, setO, true)}{F('Required certifications', 'certs', o, setO, true)}</>;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card title="Job descriptions" className="lg:col-span-2" padded={false} actions={canWrite && <button className="btn-primary btn-sm" onClick={() => setCreate({ code: '', designationId: '', effectiveFrom: new Date().toISOString().slice(0, 10) })}><Plus size={14} />New JD</button>}>
        {list.isLoading ? <TableSkeleton /> : list.data?.length ? <ul>{list.data.map((j) => <li key={j.id}><button onClick={() => setSel(j.id)} className={cn('flex w-full items-center justify-between gap-2 border-b px-4 py-3 text-start transition hover:bg-brand-soft/40', sel === j.id && 'bg-brand-soft/60')}><span><span className="block text-sm font-semibold">{j.title}</span><span className="block text-[11px] text-muted">{j.code} · v{j.currentVersion} · {j.employees} employees{j.grade ? ` · ${j.grade}` : ''}</span></span><Badge status={j.status} /></button></li>)}</ul> : <EmptyState hint="Create the first job description." />}
      </Card>
      <Card title={detail.data ? `${detail.data.title} · ${detail.data.code}` : 'Select a JD'} className="lg:col-span-3" actions={sel && canWrite && <><button className="btn-secondary btn-sm" onClick={() => linkEmp.mutate()}>Link employees</button><button className="btn-primary btn-sm" onClick={() => setVer({ effectiveFrom: new Date().toISOString().slice(0, 10) })}><Plus size={14} />Version</button></>}>
        {!sel ? <EmptyState title="Pick a job description" hint="Versions, approvals and content appear here." /> : detail.isLoading ? <TableSkeleton /> : detail.data && <div className="space-y-4">
          {detail.data.versions.map((v: any) => <div key={v.id} className={cn('rounded-2xl border p-4', v.status === 'APPROVED' && 'border-success/40 bg-success/5')}>
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">Version {v.version} <span className="text-xs font-normal text-muted">effective {fmtDate(v.effectiveFrom)}{v.approvedAt ? ` · approved ${fmtDate(v.approvedAt)}` : ''}</span></p><span className="flex items-center gap-2"><Badge status={v.status === 'SUPERSEDED' ? 'ARCHIVED' : v.status} />{v.status === 'DRAFT' && canWrite && <button className="btn-primary btn-sm" onClick={() => approve.mutate(v.id)}>Approve</button>}</span></div>
            {v.purpose && <p className="mt-2 text-sm text-muted">{v.purpose}</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">{[['Responsibilities', v.responsibilities], ['Qualifications', v.qualifications], ['Skills', v.skills], ['KPIs', v.kpis], ['Required certifications', v.requiredCertifications], ['Technical competencies', v.technicalCompetencies], ['Behavioural competencies', v.behaviouralCompetencies]].filter(([, l]: any) => l?.length).map(([t, l]: any) => <div key={t}><p className="text-[10px] font-bold uppercase tracking-wider text-muted">{t}</p><ul className="mt-1 list-disc ps-5 text-sm">{l.map((x: string) => <li key={x}>{x}</li>)}</ul></div>)}</div>
          </div>)}
        </div>}
      </Card>
      <Modal open={!!create} onClose={() => setCreate(null)} title="New job description" wide>{create && <div className="grid gap-3 sm:grid-cols-2"><Field label="Code"><input className="input" placeholder="JD-CIV-SE" value={create.code} onChange={(e) => setCreate({ ...create, code: e.target.value.toUpperCase() })} /></Field><Field label="Job title"><select className="input" value={create.designationId} onChange={(e) => setCreate({ ...create, designationId: e.target.value })}><option value="">Choose…</option>{titles.data?.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>{F('Location', 'location', create, setCreate)}{form(create, setCreate)}<div className="flex justify-end sm:col-span-2"><button className="btn-primary" disabled={!create.code || !create.designationId} onClick={() => mCreate.mutate()}>Create draft</button></div></div>}</Modal>
      <Modal open={!!ver} onClose={() => setVer(null)} title="New draft version" wide>{ver && <div className="grid gap-3 sm:grid-cols-2">{form(ver, setVer)}<div className="flex justify-end sm:col-span-2"><button className="btn-primary" onClick={() => mVer.mutate()}>Save draft</button></div></div>}</Modal>
    </div>
  );
}
