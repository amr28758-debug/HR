'use client';
import { use, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Avatar, Badge, Card, EmptyState, Field, KeyValue, Modal, Tabs, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMinutes, fmtMoney, fmtTime, humanStatus, monthName } from '@/lib/format';

type Tab = 'overview' | 'personal' | 'employment' | 'attendance' | 'leave' | 'timesheet' | 'salary' | 'documents' | 'requests' | 'audit';
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <AppShell><Profile id={id} /></AppShell>; }

function Profile({ id }: { id: string }) {
  const { can, principal } = useAuth();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>((sp.get('tab') as Tab) ?? 'overview');
  const [transition, setTransition] = useState<string | null>(null);
  const e = useQuery({ queryKey: ['employee', id], queryFn: () => api<any>(`/api/v1/employees/${id}`) });
  const isSelf = principal?.employeeId === id;
  const canSalary = can('salary:read') || (isSelf && can('salary:read:own'));
  if (e.isLoading) return <TableSkeleton />;
  if (!e.data) return <Alert tone="danger">{(e.error as Error)?.message ?? 'Not found'}</Alert>;
  const d = e.data;
  const tabs: { key: Tab; label: string }[] = [{ key: 'overview', label: 'Overview' }, { key: 'personal', label: 'Personal' }, { key: 'employment', label: 'Employment' }, { key: 'attendance', label: 'Attendance' }, { key: 'leave', label: 'Leave' }, { key: 'timesheet', label: 'Timesheet' }, ...(canSalary ? [{ key: 'salary' as Tab, label: 'Salary' }] : []), { key: 'documents', label: 'Documents' }, { key: 'requests', label: 'Requests' }, ...(can('audit:read') ? [{ key: 'audit' as Tab, label: 'Audit' }] : [])];
  return (
    <>
      <div className="card mb-6 flex flex-wrap items-center gap-5 p-6">
        <Avatar name={d.fullNameEn} size="xl" />
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">{d.fullNameEn}</h1><Badge status={d.status} />{d.probationStatus === 'ON_PROBATION' && <Badge status="PROBATION">Probation ends {fmtDate(d.probationEndDate)}</Badge>}</div>
          <p className="mt-1 text-sm text-muted">{d.employeeNo}{d.fullNameAr ? ` · ${d.fullNameAr}` : ''} · {d.designation?.title ?? 'No designation'} · {d.department?.name ?? 'No department'}</p>
          <p className="mt-0.5 text-sm text-muted">{d.site?.name ?? '—'}{d.project ? ` · ${d.project.code} ${d.project.name}` : ''}{d.manager ? ` · Reports to ${d.manager.name}` : ''}</p></div>
        {can('employees:transition') && d.allowedTransitions.length > 0 && <div className="flex flex-wrap gap-2">{d.allowedTransitions.map((t: string) => <button key={t} className="btn-secondary btn-sm" onClick={() => setTransition(t)}>→ {humanStatus(t)}</button>)}</div>}
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview d={d} id={id} />}
      {tab === 'personal' && <Card title="Personal information"><KeyValue cols={3} items={[{ k: 'First name', v: d.firstName }, { k: 'Middle name', v: d.middleName }, { k: 'Last name', v: d.lastName }, { k: 'Arabic name', v: d.fullNameAr }, { k: 'Gender', v: humanStatus(d.gender) }, { k: 'Date of birth', v: fmtDate(d.dateOfBirth) }, { k: 'Nationality', v: d.nationality }, { k: 'Marital status', v: humanStatus(d.maritalStatus) }, { k: 'Mobile', v: d.mobile }, { k: 'Work email', v: d.workEmail }, { k: 'Personal email', v: d.personalEmail }, { k: 'Emergency contact', v: d.emergencyContactName ? `${d.emergencyContactName} (${d.emergencyContactRelation ?? '—'}) ${d.emergencyContactPhone ?? ''}` : null }]} />{d.banking && <div className="mt-6 border-t pt-5"><h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Banking · restricted</h4><KeyValue cols={3} items={[{ k: 'Bank', v: d.banking.bankName }, { k: 'Account name', v: d.banking.bankAccountName }, { k: 'IBAN', v: d.banking.bankIban }, { k: 'SWIFT', v: d.banking.bankSwift }, { k: 'WPS person ID', v: d.banking.wpsPersonId }]} /></div>}</Card>}
      {tab === 'employment' && <Employment d={d} id={id} />}
      {tab === 'attendance' && <AttendanceTab id={id} />}
      {tab === 'leave' && <LeaveTab id={id} />}
      {tab === 'timesheet' && <TimesheetTab id={id} />}
      {tab === 'salary' && canSalary && <SalaryTab id={id} />}
      {tab === 'documents' && <DocumentsTab id={id} />}
      {tab === 'requests' && <RequestsTab id={id} />}
      {tab === 'audit' && <AuditTab id={id} />}
      <TransitionModal id={id} to={transition} onClose={() => setTransition(null)} onDone={() => { qc.invalidateQueries({ queryKey: ['employee', id] }); setTransition(null); }} />
    </>
  );
}

function Overview({ d, id }: { d: any; id: string }) {
  const bal = useQuery({ queryKey: ['leave-balances', id], queryFn: () => api<any[]>(`/api/v1/leave/balances/${id}`) });
  const docs = useQuery({ queryKey: ['documents', id], queryFn: () => api<any[]>(`/api/v1/employees/${id}/documents`) });
  const month = new Date();
  const cal = useQuery({ queryKey: ['calendar', id, month.getFullYear(), month.getMonth() + 1], queryFn: () => api<any[]>(`/api/v1/attendance/calendar/${id}?year=${month.getFullYear()}&month=${month.getMonth() + 1}`) });
  const cnt = (s: string) => cal.data?.filter((x) => x.status === s).length ?? 0;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Employment"><KeyValue items={[{ k: 'Joined', v: fmtDate(d.joiningDate) }, { k: 'Type', v: humanStatus(d.employmentType) }, { k: 'Contract', v: `${fmtDate(d.contractStartDate)} → ${fmtDate(d.contractEndDate)}` }, { k: 'Grade', v: d.grade }, { k: 'Cost center', v: d.costCenter?.code }, { k: 'Matrix user ID', v: d.matrixUserId }]} /></Card>
      <Card title={`Attendance · ${monthName(month.getMonth() + 1)}`}><div className="grid grid-cols-2 gap-3">{[['PRESENT', 'Present'], ['ABSENT', 'Absent'], ['ON_LEAVE', 'On leave'], ['MISSING_PUNCH', 'Missing punch']].map(([s, l]) => <div key={s} className="rounded-xl bg-surface-2 p-3"><p className="text-[11px] uppercase tracking-wider text-muted">{l}</p><p className="text-xl font-semibold tabular-nums">{cnt(s)}</p></div>)}</div><p className="mt-3 text-xs text-muted">Late: {cal.data?.filter((x) => x.lateMinutes > 0).length ?? 0} days · OT: {fmtMinutes(cal.data?.reduce((s, x) => s + x.approvedOvertimeMinutes, 0))} approved</p></Card>
      <Card title="Leave balances">{bal.data?.map((b) => <div key={b.leaveTypeCode} className="flex items-center justify-between py-1.5 text-sm"><span>{b.leaveTypeName}</span><span className="tabular-nums"><b>{b.available}</b> <span className="text-muted">/ {b.balance} ({b.used} used)</span></span></div>)}{bal.data?.length === 0 && <EmptyState />}</Card>
      <Card title="Documents" className="lg:col-span-3">{docs.data?.length ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{docs.data.map((x) => <div key={x.id} className="rounded-xl border p-3"><div className="flex items-center justify-between"><span className="text-xs font-semibold">{humanStatus(x.documentType)}</span><Badge status={x.status} /></div><p className="mt-1 text-sm">{x.documentNumber ?? '—'}</p><p className="text-[11px] text-muted">Expires {fmtDate(x.expiryDate)}{x.daysToExpiry !== null ? ` · ${x.daysToExpiry}d` : ''}</p></div>)}</div> : <EmptyState title="No documents" />}</Card>
    </div>
  );
}

function Employment({ d, id }: { d: any; id: string }) {
  const h = useQuery({ queryKey: ['history', id], queryFn: () => api<any>(`/api/v1/employees/${id}/history`) });
  const cl = useQuery({ queryKey: ['checklists', id], queryFn: () => api<any[]>(`/api/v1/employees/${id}/checklists`) });
  const qc = useQueryClient();
  const complete = useMutation({ mutationFn: (taskId: string) => api(`/api/v1/employees/checklist-tasks/${taskId}/complete`, { method: 'POST', json: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['checklists', id] }) });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Current position"><KeyValue items={[{ k: 'Department', v: d.department?.name }, { k: 'Designation', v: d.designation?.title }, { k: 'Site', v: d.site?.name }, { k: 'Project', v: d.project ? `${d.project.code} · ${d.project.name}` : null }, { k: 'Manager', v: d.manager ? `${d.manager.name} (${d.manager.employeeNo})` : null }, { k: 'Grade', v: d.grade }, { k: 'Probation', v: humanStatus(d.probationStatus) }, { k: 'Confirmed on', v: fmtDate(d.confirmationDate) }, { k: 'Last working date', v: fmtDate(d.lastWorkingDate) }]} /></Card>
      <Card title="Status history" padded={false}><table className="data"><thead><tr><th>From</th><th>To</th><th>Effective</th><th>Reason</th><th>By</th></tr></thead><tbody>{h.data?.status.map((s: any, i: number) => <tr key={i}><td>{s.fromStatus ? <Badge status={s.fromStatus} /> : '—'}</td><td><Badge status={s.toStatus} /></td><td>{fmtDate(s.effectiveDate)}</td><td className="text-muted">{s.reason ?? '—'}</td><td className="text-muted">{s.changedBy ?? 'system'}</td></tr>)}</tbody></table></Card>
      <Card title="Employment movements" padded={false}><table className="data"><thead><tr><th>From</th><th>To</th><th>Type</th><th>Department</th><th>Designation</th><th>Site</th><th>Project</th></tr></thead><tbody>{h.data?.employment.map((s: any, i: number) => <tr key={i}><td>{fmtDate(s.effectiveFrom)}</td><td>{fmtDate(s.effectiveTo)}</td><td><Badge>{humanStatus(s.changeType)}</Badge></td><td>{s.department ?? '—'}</td><td>{s.designation ?? '—'}</td><td>{s.site ?? '—'}</td><td>{s.project ?? '—'}</td></tr>)}</tbody></table></Card>
      <Card title="Onboarding / clearance checklists">{cl.data?.length ? cl.data.map((c) => <div key={c.id} className="mb-4"><div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">{c.template}</span><Badge status={c.status === 'COMPLETED' ? 'DONE' : 'OPEN'}>{c.status}</Badge></div><ul className="space-y-1">{c.tasks.map((t: any) => <li key={t.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={t.status !== 'PENDING'} disabled={t.status !== 'PENDING' || complete.isPending} onChange={() => complete.mutate(t.id)} /><span className={t.status !== 'PENDING' ? 'text-muted line-through' : ''}>{t.title}</span><span className="ms-auto text-[10px] uppercase text-muted">{t.group}{t.ownerRole ? ` · ${t.ownerRole.replace(/_/g, ' ')}` : ''}</span></li>)}</ul>{complete.error && <Alert tone="danger">{(complete.error as Error).message}</Alert>}</div>) : <EmptyState title="No checklists" hint="Generated automatically when the employee enters ONBOARDING or CLEARANCE." />}</Card>
    </div>
  );
}

function AttendanceTab({ id }: { id: string }) {
  const [ym, setYm] = useState(() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() + 1 }; });
  const cal = useQuery({ queryKey: ['calendar', id, ym.y, ym.m], queryFn: () => api<any[]>(`/api/v1/attendance/calendar/${id}?year=${ym.y}&month=${ym.m}`) });
  return (
    <Card title={`${monthName(ym.m)} ${ym.y}`} padded={false} actions={<><button className="btn-ghost btn-sm" onClick={() => setYm(ym.m === 1 ? { y: ym.y - 1, m: 12 } : { y: ym.y, m: ym.m - 1 })}>‹</button><button className="btn-ghost btn-sm" onClick={() => setYm(ym.m === 12 ? { y: ym.y + 1, m: 1 } : { y: ym.y, m: ym.m + 1 })}>›</button></>}>
      {cal.isLoading ? <TableSkeleton /> : cal.data?.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Date</th><th>Status</th><th>Shift</th><th>In</th><th>Out</th><th>Worked</th><th>Late</th><th>Early</th><th>OT</th><th>Approved OT</th><th>Punches</th></tr></thead><tbody>{cal.data.map((d) => <tr key={d.date}><td className="font-medium">{fmtDate(d.date)}</td><td><Badge status={d.status} /></td><td className="text-muted">{d.shiftCode ?? '—'}</td><td>{fmtTime(d.firstInAt)}</td><td>{fmtTime(d.lastOutAt)}</td><td>{fmtMinutes(d.workedMinutes)}</td><td className={d.lateMinutes ? 'text-warning' : ''}>{fmtMinutes(d.lateMinutes)}</td><td>{fmtMinutes(d.earlyLeaveMinutes)}</td><td>{fmtMinutes(d.overtimeMinutes)}</td><td className="text-success">{fmtMinutes(d.approvedOvertimeMinutes)}</td><td className="text-muted">{d.punchCount}</td></tr>)}</tbody></table></div> : <EmptyState title="No attendance for this month" />}
    </Card>
  );
}
function LeaveTab({ id }: { id: string }) {
  const bal = useQuery({ queryKey: ['leave-balances', id], queryFn: () => api<any[]>(`/api/v1/leave/balances/${id}`) });
  const req = useQuery({ queryKey: ['leave-requests', id], queryFn: () => api<Paginated<any>>(`/api/v1/leave/requests?employeeId=${id}`) });
  return <div className="grid gap-4 lg:grid-cols-3"><Card title="Balances" padded={false}><table className="data"><thead><tr><th>Type</th><th>Accrued</th><th>Used</th><th>Pending</th><th>Available</th></tr></thead><tbody>{bal.data?.map((b) => <tr key={b.leaveTypeCode}><td>{b.leaveTypeName}</td><td>{b.opening + b.accrued}</td><td>{b.used}</td><td>{b.pending}</td><td className="font-semibold">{b.available}</td></tr>)}</tbody></table></Card><Card title="Requests" padded={false} className="lg:col-span-2"><table className="data"><thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Reason</th></tr></thead><tbody>{req.data?.data.map((r) => <tr key={r.id}><td>{r.leaveTypeName}</td><td>{fmtDate(r.startDate)}</td><td>{fmtDate(r.endDate)}</td><td>{r.totalDays}</td><td><Badge status={r.status} /></td><td className="text-muted">{r.reason ?? '—'}</td></tr>)}</tbody></table>{req.data?.data.length === 0 && <EmptyState />}</Card></div>;
}
function TimesheetTab({ id }: { id: string }) {
  const n = new Date();
  const ts = useQuery({ queryKey: ['timesheets', id, n.getFullYear()], queryFn: async () => { const all: any[] = []; for (let m = 1; m <= 12; m++) { const r = await api<Paginated<any>>(`/api/v1/timesheets?year=${n.getFullYear()}&month=${m}&employeeId=${id}`); all.push(...r.data); } return all; } });
  return <Card title={`Timesheets · ${n.getFullYear()}`} padded={false}>{ts.isLoading ? <TableSkeleton /> : ts.data?.length ? <table className="data"><thead><tr><th>Month</th><th>Status</th><th>Scheduled</th><th>Present</th><th>Absent</th><th>Paid leave</th><th>Unpaid</th><th>Worked</th><th>OT</th><th>Late</th></tr></thead><tbody>{ts.data.map((t) => <tr key={t.id}><td className="font-medium">{monthName(t.month)}</td><td><Badge status={t.status} /></td><td>{t.scheduledDays}</td><td>{t.presentDays}</td><td>{t.absentDays}</td><td>{t.paidLeaveDays}</td><td>{t.unpaidLeaveDays}</td><td>{fmtMinutes(t.workedMinutes)}</td><td>{fmtMinutes(t.overtimeMinutes)}</td><td>{fmtMinutes(t.lateMinutes)}</td></tr>)}</tbody></table> : <EmptyState title="No timesheets generated" />}</Card>;
}
function SalaryTab({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['salary', id], queryFn: () => api<any[]>(`/api/v1/employees/${id}/salary`) });
  const comps = useQuery({ queryKey: ['components'], queryFn: () => api<any[]>('/api/v1/payroll/components'), enabled: can('salary:write') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ effectiveFrom: string; reason: string; lines: Record<string, number> }>({ effectiveFrom: new Date().toISOString().slice(0, 10), reason: '', lines: {} });
  const m = useMutation({ mutationFn: () => api(`/api/v1/employees/${id}/salary`, { method: 'POST', json: { effectiveFrom: form.effectiveFrom, reason: form.reason || undefined, lines: Object.entries(form.lines).filter(([, v]) => v > 0).map(([componentCode, amount]) => ({ componentCode, amount })) } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['salary', id] }); setOpen(false); } });
  const current = s.data?.[0];
  return (
    <div className="space-y-4">
      {current && <div className="grid gap-4 sm:grid-cols-3"><div className="card p-5"><p className="text-xs uppercase tracking-wider text-muted">Basic</p><p className="text-2xl font-semibold">{fmtMoney(current.basicSalary, current.currency)}</p></div><div className="card p-5"><p className="text-xs uppercase tracking-wider text-muted">Gross (fixed pay)</p><p className="text-2xl font-semibold">{fmtMoney(current.grossSalary, current.currency)}</p></div><div className="card p-5"><p className="text-xs uppercase tracking-wider text-muted">Effective</p><p className="text-2xl font-semibold">{fmtDate(current.effectiveFrom)}</p><p className="text-xs text-muted">version {current.version}</p></div></div>}
      <Card title="Salary structure versions" actions={can('salary:write') && <button className="btn-primary btn-sm" onClick={() => { setForm({ ...form, lines: Object.fromEntries((current?.lines ?? []).map((l: any) => [l.componentCode, l.amount])) }); setOpen(true); }}>New version</button>} padded={false}>
        {s.data?.length ? <table className="data"><thead><tr><th>Version</th><th>Effective</th><th>Until</th><th>Components</th><th>Gross</th><th>Reason</th></tr></thead><tbody>{s.data.map((v) => <tr key={v.id}><td>v{v.version}</td><td>{fmtDate(v.effectiveFrom)}</td><td>{fmtDate(v.effectiveTo)}</td><td className="text-xs">{v.lines.map((l: any) => `${l.componentCode} ${l.amount.toLocaleString()}`).join(' · ')}</td><td className="font-semibold">{fmtMoney(v.grossSalary, v.currency)}</td><td className="text-muted">{v.reason ?? '—'}</td></tr>)}</tbody></table> : <EmptyState title="No salary structure" hint="Payroll cannot be calculated until a salary structure is defined." />}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New salary structure version">
        <div className="space-y-3"><Field label="Effective from"><input type="date" className="input" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} /></Field>{comps.data?.filter((c) => c.isFixedPay).map((c) => <Field key={c.code} label={c.name}><input type="number" min={0} className="input" value={form.lines[c.code] ?? ''} onChange={(e) => setForm({ ...form, lines: { ...form.lines, [c.code]: Number(e.target.value) } })} /></Field>)}<Field label="Reason"><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>{m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Save</button></div></div>
      </Modal>
    </div>
  );
}
function DocumentsTab({ id }: { id: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['documents', id], queryFn: () => api<any[]>(`/api/v1/employees/${id}/documents`) });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ documentType: 'EMIRATES_ID', documentNumber: '', issueDate: '', expiryDate: '', reminderDaysBefore: 30 });
  const m = useMutation({ mutationFn: () => api(`/api/v1/employees/${id}/documents`, { method: 'POST', json: Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '')) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['documents', id] }); setOpen(false); } });
  const del = useMutation({ mutationFn: (docId: string) => api(`/api/v1/employees/${id}/documents/${docId}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['documents', id] }) });
  return (
    <Card title="Documents" padded={false} actions={can('employees:documents:write') && <button className="btn-primary btn-sm" onClick={() => setOpen(true)}>Add document</button>}>
      {docs.data?.length ? <table className="data"><thead><tr><th>Type</th><th>Number</th><th>Issued</th><th>Expiry</th><th>Status</th><th>Reminder</th><th></th></tr></thead><tbody>{docs.data.map((x) => <tr key={x.id}><td className="font-medium">{humanStatus(x.documentType)}</td><td>{x.documentNumber ?? '—'}</td><td>{fmtDate(x.issueDate)}</td><td>{fmtDate(x.expiryDate)}{x.daysToExpiry !== null && <span className="ms-1 text-xs text-muted">({x.daysToExpiry}d)</span>}</td><td><Badge status={x.status} /></td><td className="text-muted">{x.reminderDaysBefore}d before</td><td className="text-end">{can('employees:documents:write') && <button className="btn-ghost btn-sm text-danger" onClick={() => confirm('Remove document?') && del.mutate(x.id)}>Remove</button>}</td></tr>)}</tbody></table> : <EmptyState title="No documents" />}
      <Modal open={open} onClose={() => setOpen(false)} title="Add document"><div className="space-y-3"><Field label="Type"><select className="input" value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })}>{['EMIRATES_ID', 'PASSPORT', 'VISA', 'LABOUR_CARD', 'INSURANCE', 'CONTRACT', 'DRIVING_LICENSE', 'CERTIFICATE', 'OTHER'].map((t) => <option key={t} value={t}>{humanStatus(t)}</option>)}</select></Field><Field label="Number"><input className="input" value={form.documentNumber} onChange={(e) => setForm({ ...form, documentNumber: e.target.value })} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Issue date"><input type="date" className="input" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></Field><Field label="Expiry date"><input type="date" className="input" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></Field></div><Field label="Remind days before expiry"><input type="number" className="input" value={form.reminderDaysBefore} onChange={(e) => setForm({ ...form, reminderDaysBefore: Number(e.target.value) })} /></Field><Alert tone="info">File upload goes to S3-compatible storage; pass the object key once the upload service is connected.</Alert>{m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Save</button></div></div></Modal>
    </Card>
  );
}
function RequestsTab({ id }: { id: string }) {
  const ot = useQuery({ queryKey: ['ot', id], queryFn: () => api<Paginated<any>>(`/api/v1/overtime/requests?employeeId=${id}`) });
  const corr = useQuery({ queryKey: ['corrections', id], queryFn: () => api<Paginated<any>>(`/api/v1/attendance/corrections?employeeId=${id}`) });
  return <div className="grid gap-4 lg:grid-cols-2"><Card title="Overtime requests" padded={false}><table className="data"><thead><tr><th>Date</th><th>Requested</th><th>Approved</th><th>Kind</th><th>Status</th></tr></thead><tbody>{ot.data?.data.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td>{fmtMinutes(r.requestedMinutes)}</td><td>{fmtMinutes(r.approvedMinutes)}</td><td>{humanStatus(r.dayKind)}</td><td><Badge status={r.status} /></td></tr>)}</tbody></table>{ot.data?.data.length === 0 && <EmptyState />}</Card><Card title="Attendance corrections" padded={false}><table className="data"><thead><tr><th>Date</th><th>Type</th><th>Reason</th><th>Status</th></tr></thead><tbody>{corr.data?.data.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td>{humanStatus(r.correctionType)}</td><td className="text-muted">{r.reason}</td><td><Badge status={r.status} /></td></tr>)}</tbody></table>{corr.data?.data.length === 0 && <EmptyState />}</Card></div>;
}
function AuditTab({ id }: { id: string }) {
  const a = useQuery({ queryKey: ['audit', id], queryFn: () => api<Paginated<any>>(`/api/v1/audit${qs({ entityId: id, pageSize: 100 })}`) });
  return <Card title="Audit trail" padded={false}><table className="data"><thead><tr><th>When</th><th>Action</th><th>By</th><th>Change</th><th>Reason</th></tr></thead><tbody>{a.data?.data.map((x) => <tr key={x.id}><td className="whitespace-nowrap">{fmtDateTime(x.occurredAt)}</td><td><Badge>{x.action}</Badge></td><td>{x.actorLabel ?? 'system'}</td><td className="max-w-md truncate text-xs text-muted" title={JSON.stringify({ old: x.oldValue, new: x.newValue })}>{x.newValue ? JSON.stringify(x.newValue).slice(0, 120) : '—'}</td><td className="text-muted">{x.reason ?? '—'}</td></tr>)}</tbody></table>{a.data?.data.length === 0 && <EmptyState />}</Card>;
}
function TransitionModal({ id, to, onClose, onDone }: { id: string; to: string | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [lwd, setLwd] = useState('');
  const m = useMutation({ mutationFn: () => api(`/api/v1/employees/${id}/transition`, { method: 'POST', json: { to, reason: reason || undefined, lastWorkingDate: lwd || undefined } }), onSuccess: onDone });
  return <Modal open={!!to} onClose={onClose} title={`Move to ${humanStatus(to)}`}><div className="space-y-3">{(to === 'RESIGNED' || to === 'TERMINATED') && <Field label="Last working date"><input type="date" className="input" value={lwd} onChange={(e) => setLwd(e.target.value)} /></Field>}<Field label="Reason"><textarea className="input h-24 py-2" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>{to === 'RESIGNED' && <Alert tone="info">Starts the RESIGNATION workflow: Manager → HR → IT → Finance → Admin, then clearance checklist.</Alert>}{m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Confirm</button></div></div></Modal>;
}
