'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, History } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, Field, Modal, Tabs, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtMoney } from '@/lib/format';
import { BandBar, CompPage, WfBadge } from '@/components/compensation/common';

export default function Page() { return <CompPage title="Salary structure" subtitle="Grades with effective-dated minimum / midpoint / maximum bands, and the job title → grade mapping. All values are configuration — never hard-coded."><Structure /></CompPage>; }
type Tab = 'grades' | 'mapping';

function Structure() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('grades');
  return <><Tabs tabs={[{ key: 'grades', label: 'Grades & salary bands' }, { key: 'mapping', label: 'Job title → grade' }]} value={tab} onChange={setTab} />{tab === 'grades' ? <Grades canEdit={can('compensation:config')} /> : <Mapping canEdit={can('compensation:config')} />}</>;
}

function Grades({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades') });
  const [grade, setGrade] = useState<any | null>(null);
  const [band, setBand] = useState<any | null>(null);
  const [hist, setHist] = useState<string | null>(null);
  const history = useQuery({ queryKey: ['comp', 'bands', hist], queryFn: () => api<any[]>(`/api/v1/compensation/salary-bands?history=true&gradeId=${hist}`), enabled: !!hist });
  const [err, setErr] = useState<string | null>(null);
  const inv = () => { qc.invalidateQueries({ queryKey: ['comp'] }); };
  const saveGrade = useMutation({ mutationFn: () => grade.id ? api(`/api/v1/compensation/grades/${grade.id}`, { method: 'PUT', json: { code: grade.code, name: grade.name, description: grade.description || null, notes: grade.notes || null, sortOrder: Number(grade.sortOrder), status: grade.status } }) : api('/api/v1/compensation/grades', { method: 'POST', json: { code: grade.code, name: grade.name, description: grade.description || null, notes: grade.notes || null, sortOrder: Number(grade.sortOrder), status: grade.status } }), onSuccess: () => { setGrade(null); inv(); }, onError: (e: any) => setErr(e.message) });
  const saveBand = useMutation({ mutationFn: () => band.id ? api(`/api/v1/compensation/salary-bands/${band.id}`, { method: 'PUT', json: { min: Number(band.min), mid: Number(band.mid), max: Number(band.max), notes: band.notes || null, reason: band.reason } }) : api('/api/v1/compensation/salary-bands', { method: 'POST', json: { gradeId: band.gradeId, min: Number(band.min), mid: band.mid ? Number(band.mid) : undefined, max: Number(band.max), currency: band.currency || 'AED', effectiveFrom: band.effectiveFrom, notes: band.notes || undefined } }), onSuccess: () => { setBand(null); inv(); }, onError: (e: any) => setErr(e.message) });
  const b = band ? { min: Number(band.min), mid: Number(band.mid || (Number(band.min) + Number(band.max)) / 2), max: Number(band.max) } : null;
  return (
    <>
      <Card padded={false} title="Grades" subtitle="Band in force today; add a new band version to change it from a future date (history is kept)" actions={canEdit && <button className="btn-primary btn-sm" onClick={() => { setErr(null); setGrade({ code: '', name: '', description: '', notes: '', sortOrder: 100, status: 'ACTIVE' }); }}><Plus size={14} /> Grade</button>}>
        {grades.isLoading ? <TableSkeleton /> : grades.data?.length ? <div className="overflow-x-auto"><table className="data">
          <thead><tr><th>Grade</th><th>Minimum</th><th>Midpoint</th><th>Maximum</th><th className="min-w-48">Band</th><th>Effective</th><th>Employees</th><th>Titles</th><th>Status</th><th /></tr></thead>
          <tbody>{grades.data.map((g) => <tr key={g.id}>
            <td><b>{g.code}</b><div className="text-xs text-muted">{g.name}{g.description && g.description !== `Grade ${g.code}` ? ` · ${g.description}` : ''}</div></td>
            <td className="tabular-nums">{fmtMoney(g.currentBand?.min ?? null, g.currentBand?.currency)}</td><td className="tabular-nums">{fmtMoney(g.currentBand?.mid ?? null, g.currentBand?.currency)}</td><td className="tabular-nums">{fmtMoney(g.currentBand?.max ?? null, g.currentBand?.currency)}</td>
            <td>{g.currentBand ? <BandBar min={g.currentBand.min} mid={g.currentBand.mid} max={g.currentBand.max} compact /> : <span className="text-xs text-danger">no active band</span>}</td>
            <td className="text-xs">{g.currentBand ? `${fmtDate(g.currentBand.effectiveFrom)}${g.currentBand.effectiveTo ? ` → ${fmtDate(g.currentBand.effectiveTo)}` : ''}` : '—'}</td>
            <td>{g.employees}</td><td>{g.titles}</td><td><WfBadge status={g.status} /></td>
            <td className="whitespace-nowrap text-end"><button className="btn-ghost btn-sm" title="Band history" onClick={() => setHist(g.id)}><History size={14} /></button>{canEdit && <><button className="btn-ghost btn-sm" title="Edit grade" onClick={() => { setErr(null); setGrade({ ...g, description: g.description ?? '', notes: g.notes ?? '' }); }}><Pencil size={14} /></button><button className="btn-secondary btn-sm" onClick={() => { setErr(null); setBand({ gradeId: g.id, gradeCode: g.code, min: g.currentBand?.min ?? '', mid: g.currentBand?.mid ?? '', max: g.currentBand?.max ?? '', currency: g.currentBand?.currency ?? 'AED', effectiveFrom: `${new Date().getFullYear() + 1}-01-01`, notes: '' }); }}>New band</button></>}</td>
          </tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No grades" /></div>}
      </Card>
      <Modal open={!!grade} onClose={() => setGrade(null)} title={grade?.id ? `Edit grade ${grade.code}` : 'New grade'}>{grade && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Grade code"><input className="input" value={grade.code} onChange={(e) => setGrade({ ...grade, code: e.target.value })} /></Field>
        <Field label="Grade name"><input className="input" value={grade.name} onChange={(e) => setGrade({ ...grade, name: e.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-2"><input className="input" value={grade.description} onChange={(e) => setGrade({ ...grade, description: e.target.value })} /></Field>
        <Field label="Order (hierarchy)" hint="Lower = more junior; used for promotion and compression checks"><input className="input" type="number" value={grade.sortOrder} onChange={(e) => setGrade({ ...grade, sortOrder: e.target.value })} /></Field>
        <Field label="Status"><select className="input" value={grade.status} onChange={(e) => setGrade({ ...grade, status: e.target.value })}><option>ACTIVE</option><option>INACTIVE</option></select></Field>
        <Field label="Notes" className="sm:col-span-2"><textarea className="input min-h-16" value={grade.notes} onChange={(e) => setGrade({ ...grade, notes: e.target.value })} /></Field>
        {err && <div className="sm:col-span-2"><Alert tone="danger">{err}</Alert></div>}
        <div className="flex justify-end gap-2 sm:col-span-2"><button className="btn-ghost" onClick={() => setGrade(null)}>Cancel</button><button className="btn-primary" disabled={!grade.code || !grade.name || saveGrade.isPending} onClick={() => saveGrade.mutate()}>Save</button></div>
      </div>}</Modal>
      <Modal open={!!band} onClose={() => setBand(null)} title={band?.id ? 'Edit band' : `New salary band — ${band?.gradeCode ?? ''}`}>{band && <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3"><Field label="Minimum"><input className="input" type="number" value={band.min} onChange={(e) => setBand({ ...band, min: e.target.value })} /></Field><Field label="Midpoint" hint="Empty = (min + max) / 2"><input className="input" type="number" value={band.mid} onChange={(e) => setBand({ ...band, mid: e.target.value })} /></Field><Field label="Maximum"><input className="input" type="number" value={band.max} onChange={(e) => setBand({ ...band, max: e.target.value })} /></Field></div>
        {b && b.min > 0 && b.max > b.min && <BandBar min={b.min} mid={b.mid} max={b.max} currency={band.currency} />}
        {!band.id && <div className="grid grid-cols-2 gap-3"><Field label="Effective from" hint="The current open band is closed the day before"><input className="input" type="date" value={band.effectiveFrom} onChange={(e) => setBand({ ...band, effectiveFrom: e.target.value })} /></Field><Field label="Currency"><input className="input" maxLength={3} value={band.currency} onChange={(e) => setBand({ ...band, currency: e.target.value.toUpperCase() })} /></Field></div>}
        <Field label="Notes"><input className="input" value={band.notes} onChange={(e) => setBand({ ...band, notes: e.target.value })} /></Field>
        {band.id && <Field label="Reason for the change (audited)"><input className="input" value={band.reason ?? ''} onChange={(e) => setBand({ ...band, reason: e.target.value })} /></Field>}
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setBand(null)}>Cancel</button><button className="btn-primary" disabled={!band.min || !band.max || (band.id && !band.reason) || saveBand.isPending} onClick={() => saveBand.mutate()}>Save band</button></div>
      </div>}</Modal>
      <Modal open={!!hist} onClose={() => setHist(null)} title="Band history" wide>{history.isLoading ? <TableSkeleton rows={3} /> : <table className="data"><thead><tr><th>From</th><th>To</th><th>Min</th><th>Mid</th><th>Max</th><th>Status</th><th>Notes</th><th /></tr></thead><tbody>{history.data?.map((x) => <tr key={x.id}><td>{fmtDate(x.effectiveFrom)}</td><td>{fmtDate(x.effectiveTo)}</td><td className="tabular-nums">{fmtMoney(x.min, x.currency)}</td><td className="tabular-nums">{fmtMoney(x.mid, x.currency)}</td><td className="tabular-nums">{fmtMoney(x.max, x.currency)}</td><td><WfBadge status={x.status} /></td><td className="text-xs">{x.notes}</td><td>{canEdit && <button className="btn-ghost btn-sm" onClick={() => { setHist(null); setErr(null); setBand({ ...x, notes: x.notes ?? '' }); }}><Pencil size={14} /></button>}</td></tr>)}</tbody></table>}</Modal>
    </>
  );
}

function Mapping({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const rows = useQuery({ queryKey: ['comp', 'mappings'], queryFn: () => api<any[]>('/api/v1/compensation/job-grade-mappings') });
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades') });
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({ mutationFn: (x: { id: string; gradeId: string | null; fill: boolean }) => api(`/api/v1/compensation/job-grade-mappings/${x.id}`, { method: 'PUT', json: { gradeId: x.gradeId, fillMissingEmployeeGrades: x.fill, reason: 'Updated from salary structure' } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp'] }), onError: (e: any) => setErr(e.message) });
  return (
    <Card padded={false} title="Job title → grade" subtitle="A title maps to one grade. Assigning grades to employees who have none is data completion; changing an existing grade goes through a promotion / grade change request.">
      {err && <div className="p-4"><Alert tone="danger">{err}</Alert></div>}
      {rows.isLoading ? <TableSkeleton /> : <div className="overflow-x-auto"><table className="data"><thead><tr><th>Job title</th><th>Grade</th><th>Employees</th><th>Without grade</th><th>In another grade</th><th /></tr></thead><tbody>{rows.data?.map((r) => <tr key={r.designationId}>
        <td className="font-medium">{r.title}<div className="text-xs text-muted">{r.code}</div></td>
        <td>{canEdit ? <select className="input w-32" value={r.gradeId ?? ''} onChange={(e) => m.mutate({ id: r.designationId, gradeId: e.target.value || null, fill: false })}><option value="">— none —</option>{grades.data?.map((g) => <option key={g.id} value={g.id}>{g.code}</option>)}</select> : r.gradeCode ?? <span className="text-danger">unmapped</span>}</td>
        <td>{r.employees}</td><td className={r.employeesWithoutGrade ? 'font-semibold text-orange-600' : ''}>{r.employeesWithoutGrade}</td><td>{r.employeesInOtherGrade}</td>
        <td>{canEdit && r.gradeId && r.employeesWithoutGrade > 0 && <button className="btn-secondary btn-sm" onClick={() => m.mutate({ id: r.designationId, gradeId: r.gradeId, fill: true })}>Assign {r.gradeCode} to {r.employeesWithoutGrade}</button>}</td>
      </tr>)}</tbody></table></div>}
    </Card>
  );
}
