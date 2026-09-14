'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, TableSkeleton, Tabs } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMinutes, fmtTime, humanStatus, today } from '@/lib/format';

type Tab = 'daily' | 'exceptions' | 'raw' | 'corrections';
export default function Page() { return <AppShell><Suspense><Attendance /></Suspense></AppShell>; }

function Attendance() {
  const { can } = useAuth();
  const sp = useSearchParams();
  const [tab, setTab] = useState<Tab>((sp.get('tab') as Tab) ?? 'daily');
  return (
    <>
      <PageHeader title="Attendance" subtitle="Raw punches are immutable. Daily attendance is calculated from the ledger, shifts and approved corrections." actions={can('attendance:process') && <ProcessButton />} />
      <Tabs tabs={[{ key: 'daily', label: 'Daily' }, ...(can('attendance:read', 'attendance:read:team') ? [{ key: 'exceptions' as Tab, label: 'Exception queue' }, { key: 'corrections' as Tab, label: 'Corrections' }] : []), { key: 'raw', label: 'Raw ledger' }]} value={tab} onChange={setTab} />
      {tab === 'daily' && <Daily />}{tab === 'exceptions' && <Exceptions />}{tab === 'raw' && <Raw />}{tab === 'corrections' && <Corrections />}
    </>
  );
}

function ProcessButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState({ from: today(), to: today() });
  const m = useMutation({ mutationFn: () => api<any>('/api/v1/attendance/process', { method: 'POST', json: range }), onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance'] }) });
  return <><button className="btn-secondary" onClick={() => setOpen(true)}><RefreshCw size={15} />Recalculate</button><Modal open={open} onClose={() => setOpen(false)} title="Recalculate daily attendance"><div className="space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="From"><input type="date" className="input" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="To"><input type="date" className="input" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field></div><Alert tone="info">Recalculation is idempotent and never touches raw punches or locked timesheets. Ranges over 7 days run in the background.</Alert>{m.data && <Alert tone="success">{m.data.mode === 'queued' ? `Queued job ${m.data.jobId}` : `Processed ${m.data.processed} employee-days: ${Object.entries(m.data.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`}</Alert>}{m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Close</button><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Run</button></div></div></Modal></>;
}

function Daily() {
  const { can } = useAuth();
  const [f, setF] = useState({ from: today(), to: today(), status: '', siteId: '', page: 1 });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites'), enabled: can('org:read') });
  const q = useQuery({ queryKey: ['attendance', 'daily', f], queryFn: () => api<Paginated<any>>(`/api/v1/attendance/daily${qs({ ...f, pageSize: 50 })}`), placeholderData: (p) => p });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap gap-2 border-b p-3"><input type="date" className="input sm:w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} /><input type="date" className="input sm:w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} /><select className="input sm:w-44" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'MISSING_PUNCH', 'WEEK_OFF', 'PUBLIC_HOLIDAY'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select>{sites.data && <select className="input sm:w-52" value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value, page: 1 })}><option value="">All sites</option>{sites.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</div>
      {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Date</th><th>Employee</th><th>Site</th><th>Shift</th><th>Status</th><th>In</th><th>Out</th><th>Worked</th><th>Late</th><th>OT</th><th>Approved</th></tr></thead><tbody>{q.data.data.map((d) => <tr key={d.id}><td className="whitespace-nowrap">{fmtDate(d.date)}</td><td><Link href={`/employees/${d.employeeId}?tab=attendance`} className="font-medium hover:underline">{d.employeeNo} · {d.employeeName}</Link></td><td className="text-muted">{d.siteName ?? '—'}</td><td className="text-muted">{d.shiftCode ?? '—'}</td><td><Badge status={d.status} /></td><td>{fmtTime(d.firstInAt)}</td><td>{fmtTime(d.lastOutAt)}</td><td>{fmtMinutes(d.workedMinutes)}</td><td className={d.lateMinutes ? 'text-warning' : ''}>{fmtMinutes(d.lateMinutes)}</td><td>{fmtMinutes(d.overtimeMinutes)}</td><td className="text-success">{fmtMinutes(d.approvedOvertimeMinutes)}</td></tr>)}</tbody></table></div> : <EmptyState title="No attendance records" hint="Records appear once punches are ingested and processed for this range." />}
      {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
    </Card>
  );
}

function Exceptions() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState({ status: 'OPEN', type: '', page: 1 });
  const q = useQuery({ queryKey: ['attendance', 'exceptions', f], queryFn: () => api<Paginated<any>>(`/api/v1/attendance/exceptions${qs({ ...f, pageSize: 50 })}`), placeholderData: (p) => p });
  const resolve = useMutation({ mutationFn: (v: { id: string; status: string }) => api(`/api/v1/attendance/exceptions/${v.id}/resolve`, { method: 'POST', json: { status: v.status } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance', 'exceptions'] }) });
  const [correct, setCorrect] = useState<any | null>(null);
  return (
    <Card padded={false}>
      <div className="flex flex-wrap gap-2 border-b p-3"><select className="input sm:w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}>{['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'].map((s) => <option key={s}>{s}</option>)}</select><select className="input sm:w-48" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, page: 1 })}><option value="">All types</option>{['ABSENT', 'LATE', 'EARLY_LEAVE', 'MISSING_IN', 'MISSING_OUT', 'DUPLICATE_PUNCH', 'EXCESSIVE_OT', 'UNAPPROVED_OT', 'OUTSIDE_SITE', 'UNMAPPED_USER'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select></div>
      {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Date</th><th>Employee</th><th>Site</th><th>Type</th><th>Severity</th><th>Details</th><th>Actions</th></tr></thead><tbody>{q.data.data.map((x) => <tr key={x.id}><td className="whitespace-nowrap">{fmtDate(x.date)}</td><td>{x.employeeId ? <Link href={`/employees/${x.employeeId}?tab=attendance`} className="font-medium hover:underline">{x.employeeNo} · {x.employeeName}</Link> : <span className="text-muted">Unmapped device user {x.details?.externalUserId}</span>}</td><td className="text-muted">{x.siteName ?? '—'}</td><td><Badge status={x.type === 'ABSENT' ? 'ABSENT' : x.type === 'LATE' ? 'LATE' : undefined}>{humanStatus(x.type)}</Badge></td><td><Badge status={x.severity} /></td><td className="max-w-xs truncate text-xs text-muted">{Object.entries(x.details ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td><td className="whitespace-nowrap">{x.status === 'OPEN' && can('attendance:exceptions:resolve') && <>{['MISSING_IN', 'MISSING_OUT', 'ABSENT'].includes(x.type) && can('attendance:correct') && <button className="btn-secondary btn-sm me-1" onClick={() => setCorrect(x)}>Correct</button>}<button className="btn-ghost btn-sm" onClick={() => resolve.mutate({ id: x.id, status: 'RESOLVED' })}>Resolve</button><button className="btn-ghost btn-sm text-muted" onClick={() => resolve.mutate({ id: x.id, status: 'DISMISSED' })}>Dismiss</button></>}</td></tr>)}</tbody></table></div> : <EmptyState title="Queue is clear" />}
      {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      <CorrectionModal target={correct} onClose={() => setCorrect(null)} />
    </Card>
  );
}

function CorrectionModal({ target, onClose }: { target: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ correctionType: 'ADD_PUNCH', time: '17:00', direction: 'OUT', overrideStatus: 'PRESENT', reason: '' });
  const m = useMutation({ mutationFn: () => api('/api/v1/attendance/corrections', { method: 'POST', json: { employeeId: target.employeeId, date: target.date, correctionType: form.correctionType, ...(form.correctionType === 'ADD_PUNCH' && { punchedAt: `${target.date}T${form.time}:00+04:00`, direction: form.direction }), ...(form.correctionType === 'OVERRIDE_DAY' && { overrideStatus: form.overrideStatus }), reason: form.reason } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance'] }); onClose(); } });
  if (!target) return null;
  return <Modal open onClose={onClose} title={`Correct ${target.employeeNo} · ${fmtDate(target.date)}`}><div className="space-y-3"><Field label="Correction"><select className="input" value={form.correctionType} onChange={(e) => setForm({ ...form, correctionType: e.target.value })}><option value="ADD_PUNCH">Add missing punch</option><option value="OVERRIDE_DAY">Override day status</option></select></Field>{form.correctionType === 'ADD_PUNCH' ? <div className="grid grid-cols-2 gap-3"><Field label="Time (site local)"><input type="time" className="input" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></Field><Field label="Direction"><select className="input" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option>IN</option><option>OUT</option></select></Field></div> : <Field label="Status"><select className="input" value={form.overrideStatus} onChange={(e) => setForm({ ...form, overrideStatus: e.target.value })}>{['PRESENT', 'HALF_DAY', 'ABSENT', 'ON_LEAVE'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select></Field>}<Field label="Reason (required, audited)"><textarea className="input h-20 py-2" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field><Alert tone="info">The raw punch ledger is never modified. This creates a correction that goes through Manager → HR approval, then the day is recalculated.</Alert>{m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending || form.reason.length < 5} onClick={() => m.mutate()}>Submit for approval</button></div></div></Modal>;
}

function Raw() {
  const [f, setF] = useState({ deviceCode: '', unprocessed: false, page: 1 });
  const q = useQuery({ queryKey: ['attendance', 'raw', f], queryFn: () => api<Paginated<any>>(`/api/v1/attendance/raw-events${qs({ ...f, unprocessed: f.unprocessed || undefined, pageSize: 50 })}`), placeholderData: (p) => p });
  return <Card padded={false}><div className="flex flex-wrap items-center gap-2 border-b p-3"><input className="input sm:w-48" placeholder="Device code" value={f.deviceCode} onChange={(e) => setF({ ...f, deviceCode: e.target.value, page: 1 })} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.unprocessed} onChange={(e) => setF({ ...f, unprocessed: e.target.checked, page: 1 })} />Unprocessed only</label><span className="ms-auto text-xs text-muted">Immutable ledger · every punch keeps its fingerprint and vendor payload</span></div>{q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Punched at</th><th>Device</th><th>Device user</th><th>Employee</th><th>Direction</th><th>Method</th><th>Source</th><th>Received</th><th>Processed</th></tr></thead><tbody>{q.data.data.map((e) => <tr key={e.id}><td className="whitespace-nowrap font-medium">{fmtDateTime(e.punchedAt)}</td><td>{e.deviceCode}</td><td>{e.externalUserId}</td><td>{e.employeeNo ?? <Badge status="HIGH">unmapped</Badge>}</td><td>{e.direction}</td><td className="text-muted">{e.verificationMethod}</td><td className="text-muted">{e.source}</td><td className="text-muted">{fmtDateTime(e.receivedAt)}</td><td>{e.processedAt ? <Badge status="DONE">yes</Badge> : <Badge status="PENDING">no</Badge>}</td></tr>)}</tbody></table></div> : <EmptyState title="No raw events" hint="Point your device gateway or COSEC export at POST /api/v1/attendance/events." />}{q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}</Card>;
}
function Corrections() {
  const q = useQuery({ queryKey: ['attendance', 'corrections'], queryFn: () => api<Paginated<any>>('/api/v1/attendance/corrections?pageSize=100') });
  return <Card padded={false}>{q.data?.data.length ? <table className="data"><thead><tr><th>Date</th><th>Employee</th><th>Type</th><th>Punch</th><th>Reason</th><th>Status</th></tr></thead><tbody>{q.data.data.map((c) => <tr key={c.id}><td>{fmtDate(c.date)}</td><td><Link className="hover:underline" href={`/employees/${c.employeeId}`}>{c.employeeId.slice(0, 8)}…</Link></td><td>{humanStatus(c.correctionType)}</td><td>{c.punchedAt ? `${fmtDateTime(c.punchedAt)} ${c.direction ?? ''}` : c.overrideStatus ?? '—'}</td><td className="text-muted">{c.reason}</td><td><Badge status={c.status} /></td></tr>)}</tbody></table> : <EmptyState title="No corrections" />}</Card>;
}
