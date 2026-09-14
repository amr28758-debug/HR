'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Modal, PageHeader, Pagination, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtMinutes, humanStatus, monthName } from '@/lib/format';

export default function Page() { return <AppShell><Timesheets /></AppShell>; }
function Timesheets() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const n = new Date();
  const [f, setF] = useState({ year: n.getFullYear(), month: n.getMonth() + 1, status: '', siteId: '', page: 1 });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites'), enabled: can('org:read') });
  const q = useQuery({ queryKey: ['timesheets', f], queryFn: () => api<Paginated<any>>(`/api/v1/timesheets${qs({ ...f, pageSize: 50 })}`), placeholderData: (p) => p });
  const gen = useMutation({ mutationFn: () => api<any>('/api/v1/timesheets/generate', { method: 'POST', json: { year: f.year, month: f.month, siteId: f.siteId || undefined } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['timesheets'] }) });
  const act = useMutation({ mutationFn: (v: { id: string; action: string }) => api(`/api/v1/timesheets/${v.id}/${v.action}`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['timesheets'] }) });
  const [detail, setDetail] = useState<string | null>(null);
  const d = useQuery({ queryKey: ['timesheet', detail], queryFn: () => api<any>(`/api/v1/timesheets/${detail}`), enabled: !!detail });
  const totals = q.data?.data.reduce((s, t) => ({ present: s.present + t.presentDays, absent: s.absent + t.absentDays, ot: s.ot + t.overtimeMinutes, unap: s.unap + t.unapprovedOvertimeMinutes, missing: s.missing + t.missingPunchDays }), { present: 0, absent: 0, ot: 0, unap: 0, missing: 0 });
  return (
    <>
      <PageHeader title="Timesheets" subtitle="The bridge between attendance and payroll. Generated from daily attendance; locked when payroll is locked." actions={can('timesheets:generate') && <button className="btn-primary" disabled={gen.isPending} onClick={() => gen.mutate()}>{gen.isPending ? 'Generating…' : `Generate ${monthName(f.month)} ${f.year}`}</button>} />
      {gen.data && <div className="mb-4"><Alert tone="success">Generated {gen.data.generated} timesheets ({gen.data.skippedLocked} locked skipped).</Alert></div>}
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b p-3"><select className="input sm:w-36" value={f.month} onChange={(e) => setF({ ...f, month: Number(e.target.value), page: 1 })}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>)}</select><input type="number" className="input sm:w-28" value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value), page: 1 })} /><select className="input sm:w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['GENERATED', 'APPROVED', 'LOCKED'].map((s) => <option key={s}>{s}</option>)}</select>{sites.data && <select className="input sm:w-52" value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value, page: 1 })}><option value="">All sites</option>{sites.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}{totals && q.data?.data.length ? <span className="ms-auto self-center text-xs text-muted">Page totals · present {totals.present} · absent {totals.absent} · OT {fmtMinutes(totals.ot)} · unapproved OT {fmtMinutes(totals.unap)} · missing punch {totals.missing}</span> : null}</div>
        {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Site</th><th>Status</th><th>Sched</th><th>Present</th><th>Absent</th><th>Paid leave</th><th>Unpaid</th><th>Missing</th><th>Normal</th><th>OT</th><th>Unapp. OT</th><th>Late</th><th></th></tr></thead><tbody>{q.data.data.map((t) => <tr key={t.id} className={t.missingPunchDays ? 'bg-warning/5' : ''}><td><Link href={`/employees/${t.employeeId}?tab=timesheet`} className="font-medium hover:underline">{t.employeeNo} · {t.employeeName}</Link></td><td className="text-muted">{t.siteName ?? '—'}</td><td><Badge status={t.status} /></td><td>{t.scheduledDays}</td><td>{t.presentDays}</td><td className={t.absentDays ? 'text-danger' : ''}>{t.absentDays}</td><td>{t.paidLeaveDays}</td><td>{t.unpaidLeaveDays}</td><td className={t.missingPunchDays ? 'text-warning' : ''}>{t.missingPunchDays}</td><td>{fmtMinutes(t.normalMinutes)}</td><td className="text-success">{fmtMinutes(t.overtimeMinutes)}</td><td className="text-muted">{fmtMinutes(t.unapprovedOvertimeMinutes)}</td><td>{fmtMinutes(t.lateMinutes)}</td><td className="whitespace-nowrap text-end"><button className="btn-ghost btn-sm" onClick={() => setDetail(t.id)}>Days</button>{t.status === 'GENERATED' && can('timesheets:approve') && <button className="btn-ghost btn-sm text-success" onClick={() => act.mutate({ id: t.id, action: 'approve' })}>Approve</button>}{t.status !== 'LOCKED' && can('timesheets:generate') && <button className="btn-ghost btn-sm" onClick={() => act.mutate({ id: t.id, action: 'regenerate' })}>Regenerate</button>}</td></tr>)}</tbody></table></div> : <EmptyState title="No timesheets for this period" hint="Generate them from daily attendance." />}
        {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={d.data ? `${d.data.employeeNo} · ${d.data.employeeName} · ${monthName(d.data.month)} ${d.data.year}` : 'Timesheet'} wide>{d.data && <div className="max-h-[60vh] overflow-auto"><table className="data"><thead><tr><th>Date</th><th>Status</th><th>Kind</th><th>Sched</th><th>Worked</th><th>Normal</th><th>OT</th><th>Late</th><th>Paid</th></tr></thead><tbody>{d.data.lines.map((l: any) => <tr key={l.date}><td>{fmtDate(l.date)}</td><td><Badge status={l.status} /></td><td className="text-muted">{humanStatus(l.dayKind)}{l.leaveTypeCode ? ` · ${l.leaveTypeCode}` : ''}</td><td>{fmtMinutes(l.scheduledMinutes)}</td><td>{fmtMinutes(l.workedMinutes)}</td><td>{fmtMinutes(l.normalMinutes)}</td><td>{fmtMinutes(l.overtimeMinutes)}</td><td>{fmtMinutes(l.lateMinutes)}</td><td>{l.isPaid ? '✓' : '—'}</td></tr>)}</tbody></table></div>}</Modal>
    </>
  );
}
