'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Pencil, FileSignature, ShieldAlert, AlertTriangle, Info, Clock, Users, Briefcase, CalendarDays, Coins, ChevronRight, MapPin, Building2, Phone, Mail, Flag } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Avatar, Badge, Card, EmptyState, Field, KeyValue, Modal, Tabs, TableSkeleton, Skeleton, cn } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMinutes, fmtMoney, fmtTime, humanStatus, monthName } from '@/lib/format';
import { ActionsMenu, ActionModal } from '@/components/employee/actions';

type Tab = 'overview' | 'personal' | 'employment' | 'job' | 'compensation' | 'attendance' | 'leave' | 'timesheet' | 'overtime' | 'payroll' | 'documents' | 'performance' | 'training' | 'disciplinary' | 'assets' | 'requests' | 'letters' | 'history' | 'audit';
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', personal: 'Personal', employment: 'Employment', job: 'Job & Organization', compensation: 'Compensation', attendance: 'Attendance', leave: 'Leave', timesheet: 'Timesheet', overtime: 'Overtime', payroll: 'Payroll', documents: 'Documents', performance: 'Performance', training: 'Training', disciplinary: 'Disciplinary', assets: 'Assets', requests: 'Requests', letters: 'Letters', history: 'History', audit: 'Audit' };
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <AppShell><Profile id={id} /></AppShell>; }

const HEALTH_CLS: Record<string, string> = { VALID: 'bg-success/10 text-success ring-success/20', EXPIRING_SOON: 'bg-warning/10 text-warning ring-warning/20', EXPIRED: 'bg-danger/10 text-danger ring-danger/20', MISSING: 'bg-surface-2 text-muted ring-border', NOT_APPLICABLE: 'bg-surface-2 text-muted/70 ring-border' };
const HEALTH_LABEL: Record<string, string> = { VALID: 'Valid', EXPIRING_SOON: 'Expiring soon', EXPIRED: 'Expired', MISSING: 'Missing', NOT_APPLICABLE: 'N/A' };

function Profile({ id }: { id: string }) {
  const { can } = useAuth();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>((sp.get('tab') as Tab) ?? 'overview');
  const [action, setAction] = useState<string | null>(null);
  const [transition, setTransition] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const e = useQuery({ queryKey: ['employee', id], queryFn: () => api<any>(`/api/v1/employees/${id}`) });
  const s = useQuery({ queryKey: ['employee-summary', id], queryFn: () => api<any>(`/api/v1/employees/${id}/summary`) });
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);
  if (e.isLoading || s.isLoading) return <div className="space-y-4"><Skeleton className="h-48 rounded-2xl" /><TableSkeleton /></div>;
  if (!e.data || !s.data) return <Alert tone="danger">{(e.error as Error)?.message ?? (s.error as Error)?.message ?? 'Not found'}</Alert>;
  const d = e.data, sm = s.data, h = sm.header;
  const tabs = (sm.tabs as Tab[]).map((k) => ({ key: k, label: TAB_LABELS[k], count: k === 'requests' ? sm.counts.openRequests || undefined : k === 'documents' ? sm.counts.expiringDocuments || undefined : undefined }));
  const refresh = () => { qc.invalidateQueries({ queryKey: ['employee', id] }); qc.invalidateQueries({ queryKey: ['employee-summary', id] }); qc.invalidateQueries({ queryKey: ['hr-requests', id] }); qc.invalidateQueries({ queryKey: ['timeline', id] }); qc.invalidateQueries({ queryKey: ['compensation', id] }); qc.invalidateQueries({ queryKey: ['letters', id] }); };
  const critical = sm.attention.filter((a: any) => a.level === 'critical').length, warnings = sm.attention.filter((a: any) => a.level === 'warning').length;
  return (
    <>
      {toast && <div className="fixed inset-x-0 top-20 z-50 mx-auto w-fit rounded-2xl bg-brand-deep px-5 py-3 text-sm font-medium text-white shadow-pop rise">{toast}</div>}
      <div className="card rise relative z-20 mb-5">
        <div className="relative h-28 rounded-t-2xl bg-hero overflow-hidden"><div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgb(255_255_255/0.12),transparent_45%)]" /></div>
        <div className="flex flex-wrap items-start gap-5 px-6 pb-5">
          <Avatar name={h.name} size="xl" className="relative z-10 -mt-12 ring-4 ring-surface shadow-lift" />
          <div className="min-w-0 flex-1 pt-3">
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold tracking-tight">{h.name}</h1><Badge status={h.status} />{h.probation.status === 'ON_PROBATION' && <Badge status="PROBATION">Probation · {h.probation.daysLeft !== null ? `${h.probation.daysLeft}d left` : 'no end date'}</Badge>}{critical > 0 && <Badge status="EXPIRED">{critical} critical</Badge>}{warnings > 0 && <Badge status="EXPIRING">{warnings} warnings</Badge>}</div>
            <p className="mt-1 text-sm text-muted"><span className="font-semibold text-fg">{h.employeeNo}</span>{h.nameAr ? ` · ${h.nameAr}` : ''} · {h.designation ?? 'No designation'} · {h.department ?? 'No department'}{h.grade ? ` · Grade ${h.grade}` : ''}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {[[MapPin, h.site], [Building2, h.project], [Users, h.manager ? `Reports to ${h.manager.name}` : null], [CalendarDays, h.joiningDate ? `Joined ${fmtDate(h.joiningDate)}${h.tenure ? ` · ${h.tenure.label}` : ''}` : null], [Briefcase, humanStatus(h.employmentType)], [Flag, h.nationality]].filter(([, v]) => v).map(([Icon, v]: any) => <span key={String(v)} className="inline-flex items-center gap-1.5 rounded-full border bg-surface-2/60 px-2.5 py-1 font-medium text-muted"><Icon size={12} />{v}</span>)}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-3">
            {can('employees:update') && <Link href={`/employees/${id}/edit`} className="btn-secondary"><Pencil size={15} />Edit</Link>}
            {(can('letters:generate') || sm.actions.find((a: any) => a.key === 'generate-letter')?.enabled) && <button className="btn-secondary" onClick={() => setAction('generate-letter')}><FileSignature size={15} />Generate letter</button>}
            <ActionsMenu actions={sm.actions} onPick={(k) => setAction(k)} />
          </div>
        </div>
        <div className="grid gap-px overflow-hidden rounded-b-2xl border-t bg-border sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Employment health" value={critical ? `${critical} critical` : warnings ? `${warnings} to review` : 'All valid'} tone={critical ? 'danger' : warnings ? 'warning' : 'success'} hint={`${sm.health.filter((x: any) => x.status === 'VALID').length}/${sm.health.filter((x: any) => x.status !== 'NOT_APPLICABLE').length} indicators valid`} onClick={() => setTab('overview')} />
          <SummaryCard label={`Attendance · ${monthName(Number(sm.attendance.period.slice(5)))}`} value={`${sm.attendance.presentDays} present`} tone={sm.attendance.absentDays ? 'warning' : 'default'} hint={`${sm.attendance.absentDays} absent · ${sm.attendance.lateCount} late · ${fmtMinutes(sm.attendance.overtimeMinutes)} OT`} onClick={() => setTab('attendance')} />
          <SummaryCard label="Leave" value={sm.leave.length ? `${sm.leave.find((l: any) => l.code === 'ANNUAL')?.balance ?? sm.leave[0].balance} days` : '—'} hint={sm.leave.length ? `${sm.leave.find((l: any) => l.code === 'ANNUAL') ? 'Annual' : sm.leave[0].leaveType} balance · ${sm.leave.reduce((a: number, l: any) => a + l.pending, 0)} pending` : 'No balances'} onClick={() => setTab('leave')} />
          {sm.compensation.visible ? <SummaryCard label="Compensation" value={fmtMoney(sm.compensation.gross)} tone="accent" hint={`Basic ${fmtMoney(sm.compensation.basic)} · v${sm.compensation.version ?? 0}${sm.compensation.activeLoans ? ` · ${sm.compensation.activeLoans} loan` : ''}${sm.compensation.lastChange?.delta ? ` · last change ${sm.compensation.lastChange.delta > 0 ? '+' : ''}${fmtMoney(sm.compensation.lastChange.delta)}` : ''}`} onClick={() => setTab('compensation')} />
            : <SummaryCard label="Open items" value={`${sm.counts.openRequests} requests`} hint={`${sm.counts.documents} documents · ${sm.counts.trainings} trainings · ${sm.counts.assets} assets`} onClick={() => setTab('requests')} />}
        </div>
      </div>
      <div className="overflow-x-auto pb-1"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      <div className="mt-4">
        {tab === 'overview' && <Overview sm={sm} d={d} id={id} go={setTab} />}
        {tab === 'personal' && <Card title="Personal information"><KeyValue cols={3} items={[{ k: 'First name', v: d.firstName }, { k: 'Middle name', v: d.middleName }, { k: 'Last name', v: d.lastName }, { k: 'Arabic name', v: d.fullNameAr }, { k: 'Gender', v: humanStatus(d.gender) }, { k: 'Date of birth', v: fmtDate(d.dateOfBirth) }, { k: 'Nationality', v: d.nationality }, { k: 'Marital status', v: humanStatus(d.maritalStatus) }, { k: 'Mobile', v: d.mobile }, { k: 'Work email', v: d.workEmail }, { k: 'Personal email', v: d.personalEmail }, { k: 'Emergency contact', v: d.emergencyContactName ? `${d.emergencyContactName} (${d.emergencyContactRelation ?? '—'}) ${d.emergencyContactPhone ?? ''}` : null }]} /></Card>}
        {tab === 'employment' && <Employment d={d} id={id} />}
        {tab === 'job' && <JobTab d={d} sm={sm} id={id} />}
        {tab === 'compensation' && <CompensationTab id={id} status={h.status} lastWorkingDate={h.lastWorkingDate} />}
        {tab === 'attendance' && <AttendanceTab id={id} />}
        {tab === 'leave' && <LeaveTab id={id} />}
        {tab === 'timesheet' && <TimesheetTab id={id} />}
        {tab === 'overtime' && <OvertimeTab id={id} />}
        {tab === 'payroll' && <PayrollTab id={id} />}
        {tab === 'documents' && <DocumentsTab id={id} />}
        {tab === 'performance' && <PerformanceTab id={id} />}
        {tab === 'training' && <TrainingTab id={id} />}
        {tab === 'disciplinary' && <DisciplinaryTab id={id} />}
        {tab === 'assets' && <AssetsTab id={id} />}
        {tab === 'requests' && <RequestsTab id={id} />}
        {tab === 'letters' && <LettersTab id={id} />}
        {tab === 'history' && <HistoryTab id={id} />}
        {tab === 'audit' && <AuditTab id={id} />}
      </div>
      <ActionModal employeeId={id} action={action} gross={sm.compensation?.gross} onClose={() => setAction(null)} onDone={(r) => { setAction(null); refresh(); setToast(r.requestNo ? `${r.requestNo} submitted · ${humanStatus(r.status)}` : r.letterNo ? `Letter ${r.letterNo} issued` : 'Done'); if (r.requestNo) setTab('requests'); if (r.letterNo) setTab('letters'); }} />
      <TransitionModal id={id} to={transition} onClose={() => setTransition(null)} onDone={() => { refresh(); setTransition(null); }} />
    </>
  );
}

function SummaryCard({ label, value, hint, tone = 'default', onClick }: { label: string; value: string; hint?: string; tone?: 'default' | 'success' | 'warning' | 'danger' | 'accent'; onClick?: () => void }) {
  const cls = { default: 'text-fg', success: 'text-success', warning: 'text-warning', danger: 'text-danger', accent: 'text-accent' }[tone];
  return <button onClick={onClick} className="group bg-surface px-5 py-4 text-start transition hover:bg-brand-soft/40"><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{label}</p><p className={cn('mt-1 text-lg font-bold tabular-nums', cls)}>{value}</p>{hint && <p className="truncate text-xs text-muted">{hint}</p>}</button>;
}

function Overview({ sm, d, id, go }: { sm: any; d: any; id: string; go: (t: Tab) => void }) {
  const tl = useQuery({ queryKey: ['timeline', id, 'short'], queryFn: () => api<any[]>(`/api/v1/employees/${id}/timeline?limit=8`) });
  const LV: Record<string, any> = { critical: [ShieldAlert, 'text-danger bg-danger/10'], warning: [AlertTriangle, 'text-warning bg-warning/10'], info: [Info, 'text-info bg-info/10'] };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Employment health" subtitle="Legal & document status at a glance" className="lg:col-span-2">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{sm.health.map((h: any) => <button key={h.key} onClick={() => go(h.key === 'CONTRACT' || h.key === 'PROBATION' ? 'employment' : 'documents')} className={cn('flex items-center justify-between rounded-xl px-3.5 py-3 text-start ring-1 transition hover:brightness-95', HEALTH_CLS[h.status])}><span><span className="block text-sm font-semibold">{h.label}</span><span className="block text-[11px] opacity-80">{h.expiryDate ? `${h.status === 'EXPIRED' ? 'Expired' : 'Expires'} ${fmtDate(h.expiryDate)}${h.daysToExpiry !== null ? ` (${h.daysToExpiry}d)` : ''}` : HEALTH_LABEL[h.status]}</span></span><span className="text-[10px] font-bold uppercase tracking-wider">{HEALTH_LABEL[h.status]}</span></button>)}</div>
      </Card>
      <Card title="Needs attention" subtitle={sm.attention.length ? `${sm.attention.length} items` : 'Nothing outstanding'}>
        {sm.attention.length ? <ul className="space-y-2">{sm.attention.map((a: any, i: number) => { const [Icon, cls] = LV[a.level]; return <li key={i}><Link href={a.link ?? '#'} className="flex items-start gap-3 rounded-xl px-2 py-2 transition hover:bg-brand-soft/50"><span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', cls)}><Icon size={14} /></span><span className="text-sm">{a.text}</span></Link></li>; })}</ul> : <EmptyState title="All clear" hint="No expiries, gaps or pending items." />}
      </Card>
      <Card title={`Attendance · ${monthName(Number(sm.attendance.period.slice(5)))} ${sm.attendance.period.slice(0, 4)}`} actions={<button className="btn-ghost btn-sm" onClick={() => go('attendance')}>Open <ChevronRight size={14} /></button>}>
        <div className="grid grid-cols-2 gap-3">{[['Present', sm.attendance.presentDays, 'text-success'], ['Absent', sm.attendance.absentDays, sm.attendance.absentDays ? 'text-danger' : ''], ['Late', `${sm.attendance.lateCount}× · ${fmtMinutes(sm.attendance.lateMinutes)}`, sm.attendance.lateCount ? 'text-warning' : ''], ['Overtime', `${fmtMinutes(sm.attendance.overtimeMinutes)} · ${fmtMinutes(sm.attendance.approvedOvertimeMinutes)} appr.`, ''], ['Missing punch', sm.attendance.missingPunchDays, sm.attendance.missingPunchDays ? 'text-warning' : ''], ['Leave days', sm.attendance.leaveDays, '']].map(([l, v, c]: any) => <div key={l} className="rounded-xl bg-surface-2/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{l}</p><p className={cn('mt-1 text-lg font-bold tabular-nums', c)}>{v}</p></div>)}</div>
      </Card>
      {sm.compensation.visible ? <Card title="Compensation" subtitle="Restricted" actions={<button className="btn-ghost btn-sm" onClick={() => go('compensation')}>Open <ChevronRight size={14} /></button>}>
        <div className="grid grid-cols-2 gap-3"><div className="rounded-xl bg-accent-soft p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Gross</p><p className="mt-1 text-lg font-bold text-accent">{fmtMoney(sm.compensation.gross)}</p></div><div className="rounded-xl bg-surface-2/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Basic</p><p className="mt-1 text-lg font-bold">{fmtMoney(sm.compensation.basic)}</p></div><div className="rounded-xl bg-surface-2/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Loans</p><p className="mt-1 text-lg font-bold">{sm.compensation.activeLoans}{sm.compensation.outstanding ? <span className="ms-1 text-xs font-medium text-muted">{fmtMoney(sm.compensation.outstanding)} due</span> : null}</p></div><div className="rounded-xl bg-surface-2/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Pending</p><p className="mt-1 text-lg font-bold">{sm.compensation.pendingBonuses + sm.compensation.pendingDeductions}<span className="ms-1 text-xs font-medium text-muted">bonus/deduction</span></p></div></div>
        {sm.compensation.lastChange && <p className="mt-3 text-xs text-muted">Last change: {humanStatus(sm.compensation.lastChange.source)} effective {fmtDate(sm.compensation.lastChange.effectiveFrom)}{sm.compensation.lastChange.delta !== null ? ` (${sm.compensation.lastChange.delta >= 0 ? '+' : ''}${fmtMoney(sm.compensation.lastChange.delta)})` : ''}</p>}
      </Card> : <Card title="Leave balances" actions={<button className="btn-ghost btn-sm" onClick={() => go('leave')}>Open <ChevronRight size={14} /></button>}>{sm.leave.length ? sm.leave.map((b: any) => <div key={b.code} className="flex items-center justify-between border-b py-2 text-sm last:border-0"><span>{b.leaveType}</span><span className="tabular-nums"><b>{b.balance}</b> <span className="text-muted">· used {b.used} · pending {b.pending}</span></span></div>) : <EmptyState />}</Card>}
      <Card title="Recent activity" subtitle="Unified timeline" actions={<button className="btn-ghost btn-sm" onClick={() => go('history')}>Full history <ChevronRight size={14} /></button>}>
        {tl.isLoading ? <Skeleton className="h-24" /> : tl.data?.length ? <ol className="relative ms-2 space-y-3 border-s ps-4">{tl.data.map((x) => <li key={x.id} className="relative"><span className="absolute -start-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-surface" /><p className="text-sm font-medium">{x.title}</p><p className="text-[11px] text-muted">{fmtDateTime(x.occurredAt)}{x.actor ? ` · ${x.actor}` : ''}{x.description ? ` · ${x.description}` : ''}</p></li>)}</ol> : <EmptyState />}
      </Card>
      <Card title="Quick facts" className="lg:col-span-3"><KeyValue cols={3} items={[{ k: 'Employee no.', v: d.employeeNo }, { k: 'Status', v: <Badge status={d.status} /> }, { k: 'Joined', v: fmtDate(d.joiningDate) }, { k: 'Contract', v: `${fmtDate(d.contractStartDate)} → ${fmtDate(d.contractEndDate)}` }, { k: 'Grade / level', v: [sm.header.grade, sm.header.careerLevel].filter(Boolean).join(' · ') || null }, { k: 'Job family', v: sm.header.jobFamily }, { k: 'Cost center', v: sm.header.costCenter }, { k: 'Mobile', v: d.mobile }, { k: 'Work email', v: d.workEmail }]} /></Card>
    </div>
  );
}

function JobTab({ d, sm, id }: { d: any; sm: any; id: string }) {
  const jd = useQuery({ queryKey: ['jd', d.designation?.id], queryFn: () => api<any[]>(`/api/v1/jobs/descriptions?designationId=${d.designation?.id}`), enabled: !!d.designation?.id });
  const cur = jd.data?.find((x) => x.status === 'APPROVED') ?? jd.data?.[0];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Position"><KeyValue items={[{ k: 'Designation', v: d.designation?.title }, { k: 'Department', v: d.department?.name }, { k: 'Job family', v: sm.header.jobFamily }, { k: 'Grade', v: sm.header.grade }, { k: 'Career level', v: sm.header.careerLevel }, { k: 'Reports to', v: d.manager ? <Link className="link" href={`/employees/${d.manager.id}`}>{d.manager.name}</Link> : null }, { k: 'Project', v: d.project ? `${d.project.code} · ${d.project.name}` : null }, { k: 'Site', v: d.site?.name }, { k: 'Cost center', v: d.costCenter?.code }, { k: 'Employment type', v: humanStatus(d.employmentType) }]} /></Card>
      <Card title="Job description" subtitle={cur ? `${cur.code} · v${cur.currentVersion} · ${cur.status}` : 'No JD linked to this designation'} actions={<Link href="/talent/jobs" className="btn-ghost btn-sm">Job architecture <ChevronRight size={14} /></Link>}>
        {cur ? <JdPreview id={cur.id} /> : <EmptyState hint="Create a versioned JD under Talent → Jobs, grades & JDs." />}
      </Card>
      <Card title="Reporting line" className="lg:col-span-2"><OrgMini id={id} /></Card>
    </div>
  );
}
function JdPreview({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['jd-detail', id], queryFn: () => api<any>(`/api/v1/jobs/descriptions/${id}`) });
  const v = q.data?.versions?.find((x: any) => x.status === 'APPROVED') ?? q.data?.versions?.[0];
  if (!v) return <Skeleton className="h-20" />;
  return <div className="space-y-3 text-sm">{v.purpose && <p className="text-muted">{v.purpose}</p>}{[['Responsibilities', v.responsibilities], ['Qualifications', v.qualifications], ['Skills', v.skills], ['KPIs', v.kpis], ['Required certifications', v.requiredCertifications]].filter(([, l]: any) => l?.length).map(([t, l]: any) => <div key={t}><p className="text-[10px] font-bold uppercase tracking-wider text-muted">{t}</p><ul className="mt-1 list-disc ps-5">{l.map((x: string) => <li key={x}>{x}</li>)}</ul></div>)}</div>;
}
function OrgMini({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['org-chart', id], queryFn: () => api<any[]>(`/api/v1/employees/org-chart?rootId=${id}&depth=2`) });
  const me = q.data?.[0];
  if (!me) return <Skeleton className="h-16" />;
  return <div className="flex flex-wrap gap-3">{me.children.length ? me.children.map((c: any) => <Link key={c.id} href={`/employees/${c.id}`} className="flex items-center gap-3 rounded-xl border px-3 py-2 transition hover:bg-brand-soft/50"><Avatar name={c.name} size="sm" /><span><span className="block text-sm font-medium">{c.name}</span><span className="block text-[11px] text-muted">{c.designation ?? '—'}{c.totalReports ? ` · ${c.totalReports} reports` : ''}</span></span></Link>) : <p className="text-sm text-muted">No direct reports.</p>}<Link href={`/people/org-chart?rootId=${id}`} className="btn-ghost btn-sm self-center">Open org chart <ChevronRight size={14} /></Link></div>;
}

function CompensationTab({ id, status, lastWorkingDate }: { id: string; status: string; lastWorkingDate: string | null }) {
  const q = useQuery({ queryKey: ['compensation', id], queryFn: () => api<any>(`/api/v1/employees/${id}/compensation`) });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <TableSkeleton />;
  if (!q.data) return <Alert tone="danger">{(q.error as Error)?.message}</Alert>;
  const c = q.data, cur = c.versions[0];
  return (
    <div className="space-y-4">
      {cur && <div className="grid gap-4 sm:grid-cols-4"><div className="card p-5"><p className="text-[10px] font-bold uppercase tracking-wider text-muted">Gross</p><p className="mt-1 text-2xl font-bold text-accent">{fmtMoney(cur.gross, cur.currency)}</p><p className="text-xs text-muted">v{cur.version} · from {fmtDate(cur.effectiveFrom)}</p></div><div className="card p-5"><p className="text-[10px] font-bold uppercase tracking-wider text-muted">Basic</p><p className="mt-1 text-2xl font-bold">{fmtMoney(cur.basic, cur.currency)}</p><p className="text-xs text-muted">{Math.round((cur.basic / cur.gross) * 100)}% of gross</p></div><div className="card p-5"><p className="text-[10px] font-bold uppercase tracking-wider text-muted">Grade band</p>{c.grade ? <><p className="mt-1 text-2xl font-bold">{c.grade.code}</p><p className="text-xs text-muted">{fmtMoney(c.grade.min)} – {fmtMoney(c.grade.max)} · compa {c.grade.compaRatio ?? '—'}</p></> : <p className="mt-1 text-sm text-muted">No grade</p>}</div><div className="card p-5"><p className="text-[10px] font-bold uppercase tracking-wider text-muted">Loans outstanding</p><p className="mt-1 text-2xl font-bold">{fmtMoney(c.loans.filter((l: any) => l.status === 'ACTIVE').reduce((s: number, l: any) => s + l.outstanding, 0))}</p><p className="text-xs text-muted">{c.loans.filter((l: any) => l.status === 'ACTIVE').length} active</p></div></div>}
      <Card title="Salary history" subtitle="Every version with what changed" padded={false}>
        {c.versions.length ? <table className="data"><thead><tr><th>Version</th><th>Effective</th><th>Until</th><th>Basic</th><th>Gross</th><th>Change</th><th>Source</th><th>Reason</th><th>By</th><th></th></tr></thead><tbody>{c.versions.map((v: any) => <><tr key={v.id} className="cursor-pointer" onClick={() => setOpen(open === v.id ? null : v.id)}><td className="font-semibold">v{v.version}</td><td>{fmtDate(v.effectiveFrom)}</td><td>{v.effectiveTo ? fmtDate(v.effectiveTo) : <span className="text-success">current</span>}</td><td className="tabular-nums">{fmtMoney(v.basic)}</td><td className="tabular-nums font-semibold">{fmtMoney(v.gross)}</td><td>{v.grossDelta === null ? <span className="text-muted">initial</span> : <span className={v.grossDelta >= 0 ? 'text-success' : 'text-danger'}>{v.grossDelta >= 0 ? '+' : ''}{fmtMoney(v.grossDelta)} ({v.grossDeltaPct}%)</span>}</td><td><Badge status={v.source === 'MANUAL' ? 'DRAFT' : 'APPROVED'}>{humanStatus(v.source)}</Badge></td><td className="max-w-xs truncate text-muted">{v.reason}</td><td className="text-muted">{v.createdBy ?? '—'}</td><td><ChevronRight size={14} className={cn('transition', open === v.id && 'rotate-90')} /></td></tr>
          {open === v.id && <tr key={`${v.id}-lines`}><td colSpan={10} className="bg-surface-2/40"><div className="grid gap-2 p-2 sm:grid-cols-3 lg:grid-cols-5">{v.lines.map((l: any) => <div key={l.componentCode} className="rounded-lg bg-surface p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{l.componentName}</p><p className="text-sm font-semibold tabular-nums">{fmtMoney(l.amount)}</p>{l.delta !== null && l.delta !== 0 && <p className={cn('text-[11px]', l.delta > 0 ? 'text-success' : 'text-danger')}>{l.delta > 0 ? '+' : ''}{fmtMoney(l.delta)} vs {fmtMoney(l.previous ?? 0)}</p>}</div>)}</div></td></tr>}</>)}</tbody></table> : <EmptyState hint="Use Actions → Change salary to create the first structure." />}
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Loans & advances" padded={false}>{c.loans.length ? <table className="data"><thead><tr><th>Type</th><th>Principal</th><th>Instalment</th><th>Outstanding</th><th>Progress</th><th>Status</th></tr></thead><tbody>{c.loans.map((l: any) => <tr key={l.id}><td>{humanStatus(l.loanType)}</td><td>{fmtMoney(l.principal)}</td><td>{fmtMoney(l.installment)}</td><td className="font-semibold">{fmtMoney(l.outstanding)}</td><td>{l.paidInstallments}/{l.totalInstallments}</td><td><Badge status={l.status} /></td></tr>)}</tbody></table> : <EmptyState />}</Card>
        <Card title="Bonuses" padded={false}>{c.bonuses.length ? <table className="data"><thead><tr><th>Type</th><th>Amount</th><th>Period</th><th>Status</th></tr></thead><tbody>{c.bonuses.map((b: any) => <tr key={b.id}><td>{humanStatus(b.bonusType)}<span className="block text-[11px] text-muted">{b.reason}</span></td><td>{b.amount !== null ? fmtMoney(b.amount) : `${b.percentage}% of basic`}</td><td>{b.period}</td><td><Badge status={b.status} /></td></tr>)}</tbody></table> : <EmptyState />}</Card>
        <Card title="Deductions" padded={false}>{c.deductions.length ? <table className="data"><thead><tr><th>Component</th><th>Amount</th><th>Period</th><th>Status</th></tr></thead><tbody>{c.deductions.map((b: any) => <tr key={b.id}><td>{humanStatus(b.componentCode)}<span className="block text-[11px] text-muted">{b.reason}</span></td><td>{fmtMoney(b.amount)}</td><td>{b.period}</td><td><Badge status={b.status} /></td></tr>)}</tbody></table> : <EmptyState />}</Card>
      </div>
      <SettlementCard id={id} status={status} lastWorkingDate={lastWorkingDate} />
    </div>
  );
}

/** Final settlement preview — DRAFT until the settlement policy is signed off by HR/Legal. */
function SettlementCard({ id, status, lastWorkingDate }: { id: string; status: string; lastWorkingDate: string | null }) {
  const { can } = useAuth();
  const [lwd, setLwd] = useState(lastWorkingDate ?? '');
  const [run, setRun] = useState(false);
  const q = useQuery({ queryKey: ['settlement', id, lwd], queryFn: () => api<any>(`/api/v1/employees/${id}/final-settlement${qs({ lastWorkingDate: lwd || undefined })}`), enabled: run && (!!lwd || !!lastWorkingDate), retry: false });
  const exiting = ['RESIGNED', 'TERMINATED', 'CLEARANCE'].includes(status);
  if (!can('payroll:read') && !can('salary:read')) return null;
  return (
    <Card title="Final settlement" subtitle={exiting ? 'End-of-service statement for this exit' : 'Preview what an exit would cost on a given date'} actions={<><input type="date" className="input h-8 w-40" value={lwd} onChange={(e) => { setLwd(e.target.value); setRun(false); }} /><button className="btn-secondary btn-sm" disabled={!lwd} onClick={() => setRun(true)}>Calculate</button></>}>
      {q.isError && <Alert tone="danger">{(q.error as Error).message}</Alert>}
      {q.data ? <div className="space-y-3">
        <Alert tone={q.data.policySignedOff ? 'info' : 'warning'}>{q.data.policySignedOff ? 'Calculated with the signed-off settlement policy.' : 'DRAFT — settlement policy not yet signed off by HR/Legal. Figures are indicative and must not be paid out.'}</Alert>
        <div className="grid gap-3 sm:grid-cols-4"><div className="rounded-xl bg-surface-2/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Service</p><p className="mt-1 text-lg font-bold">{q.data.service.years}y {q.data.service.months}m {q.data.service.days}d</p><p className="text-[11px] text-muted">{q.data.service.totalDays} days counted</p></div><div className="rounded-xl bg-surface-2/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Earnings</p><p className="mt-1 text-lg font-bold text-success">{fmtMoney(q.data.totalEarnings)}</p></div><div className="rounded-xl bg-surface-2/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Deductions</p><p className="mt-1 text-lg font-bold text-danger">{fmtMoney(q.data.totalDeductions)}</p></div><div className="rounded-xl bg-accent-soft p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Net settlement</p><p className="mt-1 text-lg font-bold text-accent">{fmtMoney(q.data.net)}</p></div></div>
        <table className="data"><thead><tr><th>Item</th><th>Basis</th><th className="text-end">Amount</th></tr></thead><tbody>{q.data.lines.map((l: any) => <tr key={l.code}><td className="font-medium">{l.label}</td><td className="text-xs text-muted">{l.detail}</td><td className={cn('text-end tabular-nums font-semibold', l.kind === 'DEDUCTION' && 'text-danger')}>{l.kind === 'DEDUCTION' ? '−' : ''}{fmtMoney(l.amount)}</td></tr>)}</tbody></table>
        {q.data.warnings.map((w: string) => <p key={w} className="text-xs text-warning">⚠ {w}</p>)}
        <p className="text-[11px] text-muted">Inputs: basic {fmtMoney(q.data.inputs.basicSalary)} · unpaid leave {q.data.inputs.unpaidLeaveDays} d · leave balance {q.data.inputs.leaveBalanceDays} d · loans {fmtMoney(q.data.inputs.outstandingLoans)} · notice shortfall {q.data.inputs.noticeShortfallDays} d{q.data.inputs.finalPeriodRun ? ` · final run ${q.data.inputs.finalPeriodRun}` : ' · final period not yet run'}</p>
      </div> : <p className="text-sm text-muted">Pick a last working date and calculate. Gratuity bands, caps and encashment basis come from the payroll policy (Configuration center).</p>}
    </Card>
  );
}

function OvertimeTab({ id }: { id: string }) {
  const ot = useQuery({ queryKey: ['ot', id], queryFn: () => api<Paginated<any>>(`/api/v1/overtime/requests?employeeId=${id}&pageSize=100`) });
  const corr = useQuery({ queryKey: ['corrections', id], queryFn: () => api<Paginated<any>>(`/api/v1/attendance/corrections?employeeId=${id}&pageSize=100`) });
  return <div className="grid gap-4 lg:grid-cols-2"><Card title="Overtime requests" padded={false}>{ot.data?.data.length ? <table className="data"><thead><tr><th>Date</th><th>Requested</th><th>Approved</th><th>Kind</th><th>Status</th></tr></thead><tbody>{ot.data.data.map((r) => <tr key={r.id}><td>{fmtDate(r.attendanceDate)}</td><td>{fmtMinutes(r.requestedMinutes)}</td><td>{fmtMinutes(r.approvedMinutes)}</td><td>{humanStatus(r.dayKind)}</td><td><Badge status={r.status} /></td></tr>)}</tbody></table> : <EmptyState />}</Card><Card title="Attendance corrections" padded={false}>{corr.data?.data.length ? <table className="data"><thead><tr><th>Date</th><th>Type</th><th>Reason</th><th>Status</th></tr></thead><tbody>{corr.data.data.map((r) => <tr key={r.id}><td>{fmtDate(r.attendanceDate)}</td><td>{humanStatus(r.correctionType)}</td><td className="max-w-xs truncate">{r.reason}</td><td><Badge status={r.status} /></td></tr>)}</tbody></table> : <EmptyState />}</Card></div>;
}
function PayrollTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['payroll-history', id], queryFn: () => api<any[]>(`/api/v1/payroll/employee-history/${id}`), retry: false });
  return <Card title="Payroll history" subtitle="One row per payroll run; payslips are available once the run is locked" padded={false}>{q.isLoading ? <TableSkeleton /> : q.data?.length ? <table className="data"><thead><tr><th>Period</th><th>Run</th><th>Gross</th><th>Earnings</th><th>Deductions</th><th>Net</th><th>Run status</th><th>Payslip</th></tr></thead><tbody>{q.data.map((p: any) => <tr key={p.id}><td className="font-medium">{monthName(p.month)} {p.year}</td><td className="font-mono text-xs">{p.runCode}</td><td className="tabular-nums">{fmtMoney(p.grossSalary)}</td><td className="tabular-nums">{fmtMoney(p.totalEarnings)}</td><td className="tabular-nums">{fmtMoney(p.totalDeductions)}</td><td className="tabular-nums font-semibold">{fmtMoney(p.netSalary)}</td><td><span className="inline-flex items-center gap-2"><Badge status={p.runStatus} />{p.hasExceptions && <Badge status="PENDING" dot={false}>exceptions</Badge>}</span></td><td>{p.payslipNo ? <Link className="link text-xs" href={`/payroll/employees/${p.id}`}>{p.payslipNo}</Link> : '—'}</td></tr>)}</tbody></table> : <EmptyState hint="Payroll rows appear once the employee is included in a run." />}</Card>;
}
function PerformanceTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['reviews', id], queryFn: () => api<any[]>(`/api/v1/people/performance/reviews?employeeId=${id}`) });
  return <Card title="Performance reviews" padded={false} actions={<Link href="/talent/performance" className="btn-ghost btn-sm">Performance module <ChevronRight size={14} /></Link>}>{q.data?.length ? <table className="data"><thead><tr><th>Cycle</th><th>Reviewer</th><th>Self</th><th>Manager</th><th>Final</th><th>Goals</th><th>Status</th></tr></thead><tbody>{q.data.map((r) => <tr key={r.id}><td className="font-medium">{r.cycleName}</td><td>{r.reviewer ?? '—'}</td><td>{r.selfRating ?? '—'}</td><td>{r.managerRating ?? '—'}</td><td className="font-semibold">{r.finalRating ?? '—'}</td><td>{r.goals?.length ?? 0}</td><td><Badge status={r.status} /></td></tr>)}</tbody></table> : <EmptyState hint="No reviews yet. Launch a cycle under Talent → Performance." />}</Card>;
}
function TrainingTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['training', id], queryFn: () => api<any[]>(`/api/v1/people/training/records?employeeId=${id}`) });
  return <Card title="Training & certifications" padded={false}>{q.data?.length ? <table className="data"><thead><tr><th>Course</th><th>Category</th><th>Scheduled</th><th>Completed</th><th>Score</th><th>Certificate</th><th>Expiry</th><th>Status</th></tr></thead><tbody>{q.data.map((r) => <tr key={r.id}><td className="font-medium">{r.title}<span className="block text-[11px] text-muted">{r.code}</span></td><td>{humanStatus(r.category)}</td><td>{fmtDate(r.scheduledDate)}</td><td>{fmtDate(r.completedAt)}</td><td>{r.score ?? '—'}</td><td>{r.certificateNo ?? '—'}</td><td>{r.certificateExpiry ? <span className="inline-flex items-center gap-2">{fmtDate(r.certificateExpiry)}{r.expiryStatus && <Badge status={r.expiryStatus} />}</span> : '—'}</td><td><Badge status={r.status} /></td></tr>)}</tbody></table> : <EmptyState hint="Use Actions → Assign training." />}</Card>;
}
function DisciplinaryTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['disciplinary', id], queryFn: () => api<any[]>(`/api/v1/people/disciplinary?employeeId=${id}`) });
  return <Card title="Disciplinary cases" subtitle="Confidential — restricted to authorised roles" padded={false}>{q.data?.length ? <table className="data"><thead><tr><th>Case</th><th>Category</th><th>Severity</th><th>Incident</th><th>Action</th><th>Status</th></tr></thead><tbody>{q.data.map((c) => <tr key={c.id}><td className="font-medium">{c.caseNo}<span className="block max-w-sm truncate text-[11px] text-muted">{c.description}</span></td><td>{humanStatus(c.category)}</td><td><Badge status={c.severity} /></td><td>{fmtDate(c.incidentDate)}</td><td>{humanStatus(c.actionTaken)}</td><td><Badge status={c.status} /></td></tr>)}</tbody></table> : <EmptyState title="No cases" />}</Card>;
}
function AssetsTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['assets', id], queryFn: () => api<any[]>(`/api/v1/assets/employee/${id}`) });
  return <Card title="Assigned assets" padded={false} actions={<Link href="/assets" className="btn-ghost btn-sm">Asset register <ChevronRight size={14} /></Link>}>{q.data?.length ? <table className="data"><thead><tr><th>Tag</th><th>Asset</th><th>Category</th><th>Assigned</th><th>Returned</th><th>Condition</th></tr></thead><tbody>{q.data.map((a) => <tr key={a.id}><td className="font-mono text-xs">{a.assetTag}</td><td className="font-medium">{a.name}</td><td>{humanStatus(a.category)}</td><td>{fmtDate(a.assignedAt)}</td><td>{a.returnedAt ? fmtDate(a.returnedAt) : <Badge status="ACTIVE">In use</Badge>}</td><td>{a.conditionIn ?? a.conditionOut ?? '—'}</td></tr>)}</tbody></table> : <EmptyState title="No assets assigned" />}</Card>;
}
function RequestsTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['hr-requests', id], queryFn: () => api<Paginated<any>>(`/api/v1/hr-requests?employeeId=${id}&pageSize=100`) });
  return <Card title="HR requests" subtitle="Every business action with its approval trail" padded={false}>{q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <table className="data"><thead><tr><th>Request</th><th>Type</th><th>What changes</th><th>Effective</th><th>Step</th><th>Status</th><th>Raised</th></tr></thead><tbody>{q.data.data.map((r) => <tr key={r.id}><td><Link className="link font-medium" href={`/requests/${r.id}`}>{r.requestNo}</Link><span className="block max-w-xs truncate text-[11px] text-muted">{r.title}</span></td><td>{humanStatus(r.type)}</td><td className="text-xs">{r.changes.slice(0, 3).map((c: any) => <span key={c.field} className="me-2 inline-block rounded-md bg-surface-2 px-1.5 py-0.5">{humanStatus(c.field)}: {String(c.from ?? '—')} → <b>{String(c.to ?? '—')}</b></span>)}</td><td>{fmtDate(r.effectiveDate)}</td><td>{r.currentStep ? <Badge status="PENDING">{humanStatus(r.currentStep)}</Badge> : '—'}</td><td><Badge status={r.status} /></td><td className="text-muted">{fmtDateTime(r.requestedAt)}{r.requestedBy ? ` · ${r.requestedBy}` : ''}</td></tr>)}</tbody></table> : <EmptyState hint="Use the Actions menu to raise a request." />}</Card>;
}
function LettersTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['letters', id], queryFn: () => api<Paginated<any>>(`/api/v1/letters?employeeId=${id}&pageSize=100`) });
  const openHtml = async (lid: string) => { const html = await api<string>(`/api/v1/letters/${lid}/html`, { raw: true }); const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } };
  return <Card title="Letters issued" padded={false}>{q.data?.data.length ? <table className="data"><thead><tr><th>Letter no.</th><th>Template</th><th>Language</th><th>Addressee / purpose</th><th>Issued</th><th>Status</th><th></th></tr></thead><tbody>{q.data.data.map((l) => <tr key={l.id}><td className="font-mono text-xs">{l.letterNo}</td><td className="font-medium">{l.templateName}</td><td>{l.language}</td><td className="text-xs text-muted">{[l.addressee, l.purpose].filter(Boolean).join(' · ') || '—'}</td><td>{fmtDateTime(l.issuedAt)}{l.issuedBy ? ` · ${l.issuedBy}` : ''}</td><td><Badge status={l.status === 'ISSUED' ? 'APPROVED' : l.status} >{l.status}</Badge></td><td><button className="btn-ghost btn-sm" onClick={() => openHtml(l.id)}>Open / print</button></td></tr>)}</tbody></table> : <EmptyState hint="Generate a letter from the header button." />}</Card>;
}
function HistoryTab({ id }: { id: string }) {
  const [types, setTypes] = useState<string>('');
  const q = useQuery({ queryKey: ['timeline', id, types], queryFn: () => api<any[]>(`/api/v1/employees/${id}/timeline${qs({ types, limit: 300 })}`) });
  const all = ['STATUS', 'PROMOTION', 'TRANSFER', 'SALARY', 'INCREMENT', 'BONUS', 'DEDUCTION', 'LOAN', 'ADVANCE', 'LEAVE', 'OVERTIME', 'ATTENDANCE_CORRECTION', 'DOCUMENT', 'LETTER', 'TRAINING', 'PERFORMANCE', 'DISCIPLINARY', 'REQUEST', 'JOINED'];
  const TONE: Record<string, string> = { PROMOTION: 'bg-accent', SALARY: 'bg-accent', INCREMENT: 'bg-accent', BONUS: 'bg-success', DEDUCTION: 'bg-danger', DISCIPLINARY: 'bg-danger', STATUS: 'bg-brand', TRANSFER: 'bg-info', LEAVE: 'bg-info', DOCUMENT: 'bg-warning', LETTER: 'bg-brand' };
  return <Card title="Employee timeline" subtitle="Business events in one place — the technical audit trail is under the Audit tab" actions={<select className="input sm:w-56" value={types} onChange={(e) => setTypes(e.target.value)}><option value="">All events</option>{all.map((t) => <option key={t} value={t}>{humanStatus(t)}</option>)}</select>}>
    {q.isLoading ? <TableSkeleton /> : q.data?.length ? <ol className="relative ms-2 space-y-4 border-s ps-5">{q.data.map((x) => <li key={x.id} className="relative"><span className={cn('absolute -start-[25px] top-1 h-3 w-3 rounded-full ring-4 ring-surface', TONE[x.type] ?? 'bg-muted')} /><div className="flex flex-wrap items-baseline gap-x-3"><p className="text-sm font-semibold">{x.title}</p><span className="text-[10px] font-bold uppercase tracking-wider text-muted">{humanStatus(x.type)}</span>{x.visibility === 'RESTRICTED' && <Badge status="HIGH" dot={false}>Restricted</Badge>}</div>{x.description && <p className="text-sm text-muted">{x.description}</p>}<p className="text-[11px] text-muted">{fmtDateTime(x.occurredAt)}{x.actor ? ` · by ${x.actor}` : ''}</p></li>)}</ol> : <EmptyState />}
  </Card>;
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

