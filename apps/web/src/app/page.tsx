'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Users, UserCheck, UserX, Palmtree, Timer, Wallet, FolderKanban, AlertTriangle, FileWarning, Clock } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { useAuth, useUi } from '@/lib/providers';
import { api } from '@/lib/api';
import { Card, StatTile, Badge, Skeleton, EmptyState } from '@/components/ui';
import { BarsChart, COLORS, TrendChart } from '@/components/charts';
import { fmtMoney, fmtNum, fmtTime, fmtMinutes, humanStatus } from '@/lib/format';

export default function Home() { return <AppShell><Dashboard /></AppShell>; }

function Dashboard() {
  const { can, principal } = useAuth();
  if (can('dashboard:executive')) return <Executive />;
  if (can('dashboard:hr')) return <Hr />;
  if (can('dashboard:payroll')) return <PayrollDash />;
  if (can('dashboard:manager')) return <Manager />;
  return <Me name={principal?.displayName ?? ''} />;
}

function Executive() {
  const { t } = useUi();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['dash', 'executive'], queryFn: () => api<any>('/api/v1/dashboards/executive') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between"><div><h1 className="text-2xl font-semibold tracking-tight">Executive overview</h1><p className="text-sm text-muted">{d?.date ?? ''} · live workforce position</p></div></div>
      {!d ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label={t('headcount')} value={fmtNum(d.headcount)} icon={<Users size={18} />} hint={`${d.projects} ${t('projects')} · ${d.sites} ${t('sites')}`} />
          <StatTile label={t('present')} value={fmtNum(d.presentToday)} tone="success" icon={<UserCheck size={18} />} hint={`${d.lateToday} ${t('late')}`} />
          <StatTile label={t('absent')} value={fmtNum(d.absentToday)} tone={d.absentToday > 0 ? 'danger' : 'default'} icon={<UserX size={18} />} hint={`${d.onLeaveToday} ${t('onLeave')}`} />
          <StatTile label={t('overtimeHours')} value={d.overtimeHoursMonth} icon={<Timer size={18} />} hint={t('thisMonth')} />
          <StatTile label="Last payroll" value={d.lastPayroll ? fmtMoney(d.lastPayroll.totalNet) : '—'} icon={<Wallet size={18} />} hint={d.lastPayroll ? <span className="inline-flex items-center gap-1">{d.lastPayroll.code} <Badge status={d.lastPayroll.status} /></span> : 'No run yet'} />
          <StatTile label={t('labourCost')} value={fmtMoney(d.labourCostByProject.reduce((s: number, p: any) => s + p.totalCost, 0))} icon={<FolderKanban size={18} />} hint="latest run, all projects" />
          <StatTile label="OT cost" value={fmtMoney(d.labourCostByProject.reduce((s: number, p: any) => s + p.otCost, 0))} tone="warning" icon={<Clock size={18} />} hint="latest run" />
          <StatTile label="Payroll employees" value={fmtNum(d.lastPayroll?.employeeCount ?? 0)} icon={<Users size={18} />} hint="in latest run" />
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Attendance trend · 14 days" className="xl:col-span-2">{d ? <TrendChart data={d.attendanceTrend} series={[{ key: 'present', label: t('present'), color: COLORS.success }, { key: 'absent', label: t('absent'), color: COLORS.danger }, { key: 'onLeave', label: t('onLeave'), color: COLORS.info }]} /> : <Skeleton className="h-52" />}</Card>
        <Card title="Headcount by status">{d ? <ul className="space-y-2">{d.headcountByStatus.sort((a: any, b: any) => b.count - a.count).map((s: any) => <li key={s.status} className="flex items-center justify-between text-sm"><Badge status={s.status} /><span className="tabular-nums font-medium">{s.count}</span></li>)}</ul> : <Skeleton className="h-52" />}</Card>
      </div>
      <Card title="Labour cost by project · latest payroll run" actions={can('reports:cost') && <Link className="btn-secondary btn-sm" href="/reports">Open cost report</Link>}>
        {d ? d.labourCostByProject.length ? <BarsChart data={d.labourCostByProject} xKey="projectCode" series={[{ key: 'normalCost', label: 'Normal', color: COLORS.brand }, { key: 'otCost', label: 'Overtime', color: COLORS.warning }]} stacked /> : <EmptyState title="No payroll run yet" hint="Labour cost appears once a payroll run is calculated." /> : <Skeleton className="h-52" />}
      </Card>
    </div>
  );
}

function Hr() {
  const q = useQuery({ queryKey: ['dash', 'hr'], queryFn: () => api<any>('/api/v1/dashboards/hr') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">HR overview</h1>
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="New joiners · 30d" value={d.newJoiners30d} icon={<Users size={18} />} /><StatTile label="On probation" value={d.onProbation} hint={`${d.probationEnding30d} ending within 30 days`} tone="warning" icon={<UserCheck size={18} />} />
        <StatTile label="Expiring documents · 60d" value={d.expiringDocuments60d} hint={`${d.expiredDocuments} already expired`} tone={d.expiredDocuments ? 'danger' : 'warning'} icon={<FileWarning size={18} />} /><StatTile label="Open attendance exceptions" value={d.openExceptions} tone="warning" icon={<AlertTriangle size={18} />} />
        <StatTile label="Pending leave" value={d.pendingLeave} icon={<Palmtree size={18} />} /><StatTile label="Contracts ending · 60d" value={d.contractsEnding60d} icon={<FileWarning size={18} />} /><StatTile label="Leavers · 30d" value={d.leavers30d} icon={<UserX size={18} />} /><StatTile label="Movements · 30d" value={d.movements30d.reduce((s: number, m: any) => s + m.count, 0)} icon={<FolderKanban size={18} />} />
      </div>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Exceptions by type" actions={<Link className="btn-secondary btn-sm" href="/attendance?tab=exceptions">Open queue</Link>}>{d ? d.exceptionsByType.length ? <BarsChart data={d.exceptionsByType.map((e: any) => ({ type: humanStatus(e.type), count: e.count }))} xKey="type" series={[{ key: 'count', label: 'Open', color: COLORS.warning }]} /> : <EmptyState /> : <Skeleton className="h-52" />}</Card>
        <Card title="Documents expiring soon" padded={false}><div className="max-h-72 overflow-auto"><table className="data"><thead><tr><th>Employee</th><th>Document</th><th>Expiry</th><th>Days</th></tr></thead><tbody>{d?.expiringList.map((x: any) => <tr key={`${x.employeeNo}-${x.documentType}`}><td className="font-medium">{x.employeeNo} · {x.name}</td><td>{humanStatus(x.documentType)}</td><td>{x.expiryDate}</td><td><Badge status={x.daysToExpiry < 0 ? 'EXPIRED' : 'EXPIRING'}>{x.daysToExpiry}d</Badge></td></tr>)}</tbody></table>{d?.expiringList.length === 0 && <EmptyState title="No expiring documents" />}</div></Card>
      </div>
    </div>
  );
}

function PayrollDash() {
  const q = useQuery({ queryKey: ['dash', 'payroll'], queryFn: () => api<any>('/api/v1/dashboards/payroll') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Payroll overview</h1>
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Current run" value={d.run?.code ?? '—'} hint={d.run && <Badge status={d.run.status} />} icon={<Wallet size={18} />} /><StatTile label="Gross" value={fmtMoney(d.run?.totalGross)} /><StatTile label="Deductions" value={fmtMoney(d.run?.totalDeductions)} tone="danger" /><StatTile label="Net" value={fmtMoney(d.run?.totalNet)} tone="success" />
        <StatTile label="OT cost" value={fmtMoney(d.otCost)} tone="warning" /><StatTile label="Employees with exceptions" value={d.exceptions} tone={d.exceptions ? 'warning' : 'default'} /><StatTile label="Pending adjustments" value={d.pendingAdjustments} /><StatTile label="Employees" value={d.run?.employeeCount ?? 0} />
      </div>}
      <div className="grid gap-4 xl:grid-cols-2"><Card title="Net by department">{d ? <BarsChart data={d.byDepartment} xKey="department" series={[{ key: 'net', label: 'Net', color: COLORS.brand }]} /> : <Skeleton className="h-52" />}</Card><Card title="Net payroll history">{d ? <BarsChart data={d.history} xKey="code" series={[{ key: 'totalNet', label: 'Net', color: COLORS.success }]} /> : <Skeleton className="h-52" />}</Card></div>
      <Link href="/payroll" className="btn-primary">Open payroll</Link>
    </div>
  );
}

function Manager() {
  const { t } = useUi();
  const q = useQuery({ queryKey: ['dash', 'manager'], queryFn: () => api<any>('/api/v1/dashboards/manager') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">My team · {d?.date}</h1>
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Team" value={d.teamSize} icon={<Users size={18} />} /><StatTile label={t('present')} value={d.present} tone="success" /><StatTile label={t('absent')} value={d.absent} tone={d.absent ? 'danger' : 'default'} hint={`${d.late} late · ${d.missingPunch} missing punch`} /><StatTile label={t('pendingApprovals')} value={d.pendingApprovals} tone="warning" hint={<Link href="/approvals" className="underline">Review</Link>} /></div>}
      <Card title="Team today" padded={false}><table className="data"><thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th>Late</th><th>OT</th></tr></thead><tbody>{d?.team.map((m: any) => <tr key={m.employeeId}><td><Link href={`/employees/${m.employeeId}`} className="font-medium hover:underline">{m.employeeNo} · {m.name}</Link></td><td><Badge status={m.status ?? 'UNKNOWN'} /></td><td>{fmtTime(m.firstInAt)}</td><td>{fmtTime(m.lastOutAt)}</td><td>{fmtMinutes(m.lateMinutes)}</td><td>{fmtMinutes(m.overtimeMinutes)}</td></tr>)}</tbody></table></Card>
    </div>
  );
}

function Me({ name }: { name: string }) {
  const q = useQuery({ queryKey: ['dash', 'me'], queryFn: () => api<any>('/api/v1/dashboards/me') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Hello, {name.split(' ')[0]}</h1>
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Today" value={<Badge status={d.today.status ?? 'UNKNOWN'} className="text-sm" />} hint={`In ${fmtTime(d.today.firstInAt)} · Out ${fmtTime(d.today.lastOutAt)}`} /><StatTile label="Present this month" value={d.monthSummary.present} tone="success" hint={`${d.monthSummary.absent} absent · ${d.monthSummary.late} late`} /><StatTile label="Overtime this month" value={fmtMinutes(d.monthSummary.overtimeMinutes)} /><StatTile label="Pending requests" value={d.pendingRequests} /></div>}
      <div className="grid gap-4 md:grid-cols-2"><Card title="Leave balances">{d?.leaveBalances.map((b: any) => <div key={b.code} className="flex items-center justify-between py-1.5 text-sm"><span>{humanStatus(b.code)}</span><span className="font-semibold tabular-nums">{b.available} days</span></div>)}<Link href="/leave" className="btn-primary btn-sm mt-3">Request leave</Link></Card><Card title="Quick links"><div className="grid grid-cols-2 gap-2">{[['/attendance', 'My attendance'], ['/timesheets', 'My timesheets'], ['/payroll', 'My payslips'], [`/employees/${d?.employee?.id ?? ''}`, 'My profile']].map(([h, l]) => <Link key={h} href={h} className="btn-secondary">{l}</Link>)}</div></Card></div>
    </div>
  );
}
