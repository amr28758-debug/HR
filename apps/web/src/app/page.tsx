'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Users, UserCheck, UserX, Palmtree, Timer, Wallet, FolderKanban, AlertTriangle, FileWarning, Clock, CheckSquare, UserPlus, RefreshCw, FileSpreadsheet, Fingerprint, CalendarClock } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { useAuth, useUi } from '@/lib/providers';
import { api } from '@/lib/api';
import { Card, StatTile, Badge, Skeleton, EmptyState, ActionItem, cn } from '@/components/ui';
import { ModuleMap } from '@/components/modules';
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


/** HR control center: NEEDS ATTENTION queue computed by /analytics/control-center. */
function ControlCenter() {
  const { can } = useAuth();
  const { locale } = useUi();
  const ar = locale === 'ar';
  const q = useQuery({ queryKey: ['control-center'], queryFn: () => api<any>('/api/v1/analytics/control-center'), enabled: can('analytics:read') || can('employees:read'), refetchInterval: 120_000 });
  if (!q.data) return null;
  const d = q.data;
  const LV: Record<string, string> = { critical: 'bg-danger/10 text-danger ring-danger/20', warning: 'bg-warning/10 text-warning ring-warning/20', info: 'bg-info/10 text-info ring-info/20' };
  const crit = d.attention.filter((a: any) => a.level === 'critical');
  return (
    <Card title={ar ? 'يحتاج إلى انتباه' : 'Needs attention'} subtitle={ar ? `${d.headcount.working} موظفاً عاملاً · ${d.headcount.probation} تحت التجربة · ${d.headcount.clearance} في إجراءات المغادرة` : `${d.headcount.working.toLocaleString()} working · ${d.headcount.probation} on probation · ${d.headcount.clearance} in clearance · +${d.headcount.joinedThisMonth} / −${d.headcount.leftThisMonth} this month`} actions={crit.length > 0 ? <Badge status="EXPIRED">{crit.length} critical</Badge> : <Badge status="ACTIVE">{ar ? 'لا حرج' : 'No critical items'}</Badge>}>
      {d.attention.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{d.attention.map((a: any) => <Link key={a.key} href={a.link} className={cn('flex items-center justify-between gap-3 rounded-xl px-3.5 py-3 ring-1 transition hover:brightness-95', LV[a.level])}><span className="text-sm font-medium leading-tight">{a.label}</span><span className="text-xl font-bold tabular-nums">{a.count}</span></Link>)}</div> : <EmptyState title={ar ? 'كل شيء على ما يرام' : 'All clear'} />}
    </Card>
  );
}

function greeting(locale: string) {
  const h = new Date().getHours();
  if (locale === 'ar') return h < 12 ? 'صباح الخير' : h < 18 ? 'مساء الخير' : 'مساء الخير';
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function Hero({ subtitle, subtitleAr }: { subtitle: string; subtitleAr?: string }) {
  const { principal, can } = useAuth();
  const { locale } = useUi();
  const first = (principal?.displayName ?? '').split(' ')[0];
  const actions = [
    can('employees:create') && { href: '/employees', icon: UserPlus, en: 'New employee', ar: 'موظف جديد' },
    can('attendance:process') && { href: '/time/attendance', icon: RefreshCw, en: 'Recalculate attendance', ar: 'إعادة احتساب الحضور' },
    can('timesheets:generate') && { href: '/timesheets', icon: FileSpreadsheet, en: 'Generate timesheets', ar: 'إنشاء كشوف الدوام' },
    can('payroll:run') && { href: '/payroll', icon: Wallet, en: 'Payroll run', ar: 'دورة رواتب' },
    can('leave:request:own') && !can('employees:create') && { href: '/leave', icon: Palmtree, en: 'Request leave', ar: 'طلب إجازة' },
    can('workflows:act') && { href: '/approvals', icon: CheckSquare, en: 'Approvals', ar: 'الموافقات' },
  ].filter(Boolean) as { href: string; icon: any; en: string; ar: string }[];
  return (
    <div className="rise relative mb-6 overflow-hidden rounded-3xl bg-hero p-7 text-white shadow-lift">
      <div className="pointer-events-none absolute -end-24 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" /><div className="pointer-events-none absolute -bottom-32 start-1/3 h-64 w-64 rounded-full bg-white/10 blur-3xl" />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/60">{new Date().toLocaleDateString(locale === 'ar' ? 'ar-AE' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p><h1 className="mt-2 text-3xl font-bold tracking-tight">{greeting(locale)}, {first}</h1><p className="mt-1 text-sm text-white/75">{locale === 'ar' && subtitleAr ? subtitleAr : subtitle}</p></div>
        <div className="flex flex-wrap gap-2">{actions.slice(0, 5).map((a) => { const Icon = a.icon; return <Link key={a.en} href={a.href} className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3.5 text-sm font-semibold backdrop-blur transition hover:bg-white/20"><Icon size={15} className="text-accent" />{locale === 'ar' ? a.ar : a.en}</Link>; })}</div>
      </div>
    </div>
  );
}
function Attention() {
  const { can } = useAuth();
  const { locale } = useUi();
  const ar = locale === 'ar';
  const hr = useQuery({ queryKey: ['dash', 'hr'], queryFn: () => api<any>('/api/v1/dashboards/hr'), enabled: can('dashboard:hr') });
  const tasks = useQuery({ queryKey: ['tasks', 'count'], queryFn: () => api<any>('/api/v1/workflows/tasks/mine?pageSize=1'), enabled: can('workflows:act') });
  const devices = useQuery({ queryKey: ['devices', 'health'], queryFn: () => api<any>('/api/v1/devices/health'), enabled: can('devices:read') });
  const d = hr.data;
  const items = [
    can('workflows:act') && { icon: <CheckSquare size={18} />, title: ar ? 'موافقات بانتظارك' : 'Approvals waiting for you', hint: ar ? 'إجازات، عمل إضافي، تصحيحات حضور' : 'Leave, overtime, attendance corrections', count: tasks.data?.meta?.total ?? 0, href: '/approvals', tone: 'warning' },
    d && { icon: <Fingerprint size={18} />, title: ar ? 'استثناءات حضور مفتوحة' : 'Open attendance exceptions', hint: ar ? 'غياب، تأخير، بصمة ناقصة، إضافي غير معتمد' : 'Absence, late, missing punch, unapproved OT', count: d.openExceptions, href: '/time/attendance?tab=exceptions', tone: 'danger' },
    d && { icon: <FileWarning size={18} />, title: ar ? 'مستندات تنتهي خلال 60 يوماً' : 'Documents expiring within 60 days', hint: ar ? `${d.expiredDocuments} منتهية بالفعل` : `${d.expiredDocuments} already expired`, count: d.expiringDocuments60d, href: '/reports', tone: 'warning' },
    d && { icon: <Palmtree size={18} />, title: ar ? 'طلبات إجازة معلقة' : 'Pending leave requests', count: d.pendingLeave, href: '/leave', tone: 'default' },
    d && { icon: <UserCheck size={18} />, title: ar ? 'فترة تجربة تنتهي خلال 30 يوماً' : 'Probation ending within 30 days', hint: ar ? `${d.onProbation} تحت التجربة` : `${d.onProbation} on probation`, count: d.probationEnding30d, href: '/employees?status=PROBATION', tone: 'default' },
    devices.data && { icon: <CalendarClock size={18} />, title: ar ? 'مستخدمو أجهزة غير مربوطين بموظف' : 'Device users not mapped to an employee', count: devices.data.unmappedOpen, href: '/devices', tone: devices.data.unmappedOpen ? 'danger' : 'success' },
  ].filter(Boolean) as any[];
  if (!items.length) return null;
  return <Card title={ar ? 'يحتاج انتباهك' : 'Needs your attention'} subtitle={ar ? 'المهام المفتوحة مرتبة حسب الأهمية' : 'Open items, most important first'} padded={false}><div className="divide-y divide-border/60 p-2">{items.map((i, k) => <ActionItem key={k} {...i} />)}</div></Card>;
}

function Sections() {
  const { locale } = useUi();
  return <div><p className="eyebrow mb-2">{locale === 'ar' ? 'الأقسام' : 'Sections'}</p><h2 className="mb-4 text-xl font-bold">{locale === 'ar' ? 'كل شيء في مكان واحد' : 'Everything in one place'}</h2><ModuleMap /></div>;
}
function Executive() {
  const { t } = useUi();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['dash', 'executive'], queryFn: () => api<any>('/api/v1/dashboards/executive') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <Hero subtitle="Live workforce position across all projects and sites." subtitleAr="وضع القوى العاملة الحالي عبر كل المشاريع والمواقع." />
      <ControlCenter />
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
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-2"><Attention /></div>
        <Card title="Attendance trend · 14 days" className="xl:col-span-3">{d ? <TrendChart data={d.attendanceTrend} series={[{ key: 'present', label: t('present'), color: COLORS.success }, { key: 'absent', label: t('absent'), color: COLORS.danger }, { key: 'onLeave', label: t('onLeave'), color: COLORS.info }]} /> : <Skeleton className="h-52" />}</Card>
        <Card title="Headcount by status">{d ? <ul className="space-y-2">{d.headcountByStatus.sort((a: any, b: any) => b.count - a.count).map((s: any) => <li key={s.status} className="flex items-center justify-between text-sm"><Badge status={s.status} /><span className="tabular-nums font-medium">{s.count}</span></li>)}</ul> : <Skeleton className="h-52" />}</Card>
      </div>
      <Card title="Labour cost by project · latest payroll run" actions={can('reports:cost') && <Link className="btn-secondary btn-sm" href="/reports">Open cost report</Link>}>
        {d ? d.labourCostByProject.length ? <BarsChart data={d.labourCostByProject} xKey="projectCode" series={[{ key: 'normalCost', label: 'Normal', color: COLORS.brand }, { key: 'otCost', label: 'Overtime', color: COLORS.warning }]} stacked /> : <EmptyState title="No payroll run yet" hint="Labour cost appears once a payroll run is calculated." /> : <Skeleton className="h-52" />}
      </Card>
      <Sections />
    </div>
  );
}

function Hr() {
  const q = useQuery({ queryKey: ['dash', 'hr'], queryFn: () => api<any>('/api/v1/dashboards/hr') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <Hero subtitle="People, documents and attendance health at a glance." subtitleAr="الموظفون والمستندات وصحة الحضور في نظرة واحدة." />
      <ControlCenter />
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="New joiners · 30d" value={d.newJoiners30d} icon={<Users size={18} />} /><StatTile label="On probation" value={d.onProbation} hint={`${d.probationEnding30d} ending within 30 days`} tone="warning" icon={<UserCheck size={18} />} />
        <StatTile label="Expiring documents · 60d" value={d.expiringDocuments60d} hint={`${d.expiredDocuments} already expired`} tone={d.expiredDocuments ? 'danger' : 'warning'} icon={<FileWarning size={18} />} /><StatTile label="Open attendance exceptions" value={d.openExceptions} tone="warning" icon={<AlertTriangle size={18} />} />
        <StatTile label="Pending leave" value={d.pendingLeave} icon={<Palmtree size={18} />} /><StatTile label="Contracts ending · 60d" value={d.contractsEnding60d} icon={<FileWarning size={18} />} /><StatTile label="Leavers · 30d" value={d.leavers30d} icon={<UserX size={18} />} /><StatTile label="Movements · 30d" value={d.movements30d.reduce((s: number, m: any) => s + m.count, 0)} icon={<FolderKanban size={18} />} />
      </div>}
      <Attention />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Exceptions by type" actions={<Link className="btn-secondary btn-sm" href="/time/attendance?tab=exceptions">Open queue</Link>}>{d ? d.exceptionsByType.length ? <BarsChart data={d.exceptionsByType.map((e: any) => ({ type: humanStatus(e.type), count: e.count }))} xKey="type" series={[{ key: 'count', label: 'Open', color: COLORS.warning }]} /> : <EmptyState /> : <Skeleton className="h-52" />}</Card>
        <Card title="Documents expiring soon" padded={false}><div className="max-h-72 overflow-auto"><table className="data"><thead><tr><th>Employee</th><th>Document</th><th>Expiry</th><th>Days</th></tr></thead><tbody>{d?.expiringList.map((x: any) => <tr key={`${x.employeeNo}-${x.documentType}`}><td className="font-medium">{x.employeeNo} · {x.name}</td><td>{humanStatus(x.documentType)}</td><td>{x.expiryDate}</td><td><Badge status={x.daysToExpiry < 0 ? 'EXPIRED' : 'EXPIRING'}>{x.daysToExpiry}d</Badge></td></tr>)}</tbody></table>{d?.expiringList.length === 0 && <EmptyState title="No expiring documents" />}</div></Card>
      </div>
      <Sections />
    </div>
  );
}

function PayrollDash() {
  const q = useQuery({ queryKey: ['dash', 'payroll'], queryFn: () => api<any>('/api/v1/dashboards/payroll') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <Hero subtitle="Latest run, exceptions and cost." subtitleAr="آخر دورة رواتب والاستثناءات والتكلفة." />
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Current run" value={d.run?.code ?? '—'} hint={d.run && <Badge status={d.run.status} />} icon={<Wallet size={18} />} /><StatTile label="Gross" value={fmtMoney(d.run?.totalGross)} /><StatTile label="Deductions" value={fmtMoney(d.run?.totalDeductions)} tone="danger" /><StatTile label="Net" value={fmtMoney(d.run?.totalNet)} tone="success" />
        <StatTile label="OT cost" value={fmtMoney(d.otCost)} tone="warning" /><StatTile label="Employees with exceptions" value={d.exceptions} tone={d.exceptions ? 'warning' : 'default'} /><StatTile label="Pending adjustments" value={d.pendingAdjustments} /><StatTile label="Employees" value={d.run?.employeeCount ?? 0} />
      </div>}
      <div className="grid gap-4 xl:grid-cols-2"><Card title="Net by department">{d ? <BarsChart data={d.byDepartment} xKey="department" series={[{ key: 'net', label: 'Net', color: COLORS.brand }]} /> : <Skeleton className="h-52" />}</Card><Card title="Net payroll history">{d ? <BarsChart data={d.history} xKey="code" series={[{ key: 'totalNet', label: 'Net', color: COLORS.success }]} /> : <Skeleton className="h-52" />}</Card></div>
      <Sections />
    </div>
  );
}

function Manager() {
  const { t } = useUi();
  const q = useQuery({ queryKey: ['dash', 'manager'], queryFn: () => api<any>('/api/v1/dashboards/manager') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <Hero subtitle={`Your team today · ${d?.date ?? ''}`} />
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Team" value={d.teamSize} icon={<Users size={18} />} /><StatTile label={t('present')} value={d.present} tone="success" /><StatTile label={t('absent')} value={d.absent} tone={d.absent ? 'danger' : 'default'} hint={`${d.late} late · ${d.missingPunch} missing punch`} /><StatTile label={t('pendingApprovals')} value={d.pendingApprovals} tone="warning" hint={<Link href="/approvals" className="underline">Review</Link>} /></div>}
      <Card title="Team today" padded={false}><table className="data"><thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th>Late</th><th>OT</th></tr></thead><tbody>{d?.team.map((m: any) => <tr key={m.employeeId}><td><Link href={`/employees/${m.employeeId}`} className="font-medium hover:underline">{m.employeeNo} · {m.name}</Link></td><td><Badge status={m.status ?? 'UNKNOWN'} /></td><td>{fmtTime(m.firstInAt)}</td><td>{fmtTime(m.lastOutAt)}</td><td>{fmtMinutes(m.lateMinutes)}</td><td>{fmtMinutes(m.overtimeMinutes)}</td></tr>)}</tbody></table></Card>
      <Sections />
    </div>
  );
}

function Me({ name }: { name: string }) {
  void name;
  const { locale } = useUi();
  const q = useQuery({ queryKey: ['dash', 'me'], queryFn: () => api<any>('/api/v1/dashboards/me') });
  const d = q.data;
  return (
    <div className="space-y-6">
      <Hero subtitle="Your attendance, leave and payslips." subtitleAr="حضورك وإجازاتك وقسائم راتبك." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['/me', 'My profile & documents', 'ملفي ومستنداتي'], ['/requests?new=1', 'Raise a request (loan, letter, training)', 'تقديم طلب'], ['/documents/letters', 'My letters', 'خطاباتي'], ['/compensation', 'My loans & bonuses', 'قروضي ومكافآتي']].map(([h, en, arL]) => <Link key={h} href={h} className="card card-hover flex items-center justify-between px-4 py-3 text-sm font-medium"><span>{locale === 'ar' ? arL : en}</span><span className="text-muted">→</span></Link>)}</div>
      {d && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Today" value={<Badge status={d.today.status ?? 'UNKNOWN'} className="text-sm" />} hint={`In ${fmtTime(d.today.firstInAt)} · Out ${fmtTime(d.today.lastOutAt)}`} /><StatTile label="Present this month" value={d.monthSummary.present} tone="success" hint={`${d.monthSummary.absent} absent · ${d.monthSummary.late} late`} /><StatTile label="Overtime this month" value={fmtMinutes(d.monthSummary.overtimeMinutes)} /><StatTile label="Pending requests" value={d.pendingRequests} /></div>}
      <div className="grid gap-4 md:grid-cols-2"><Card title="Leave balances">{d?.leaveBalances.map((b: any) => <div key={b.code} className="flex items-center justify-between py-1.5 text-sm"><span>{humanStatus(b.code)}</span><span className="font-semibold tabular-nums">{b.available} days</span></div>)}<Link href="/leave" className="btn-primary btn-sm mt-3">Request leave</Link></Card><Card title="Quick links"><div className="grid grid-cols-2 gap-2">{[['/time/attendance', 'My attendance'], ['/attendance', 'Face check-in'], ['/timesheets', 'My timesheets'], ['/payroll', 'My payslips'], [`/employees/${d?.employee?.id ?? ''}`, 'My profile']].map(([h, l]) => <Link key={h} href={h} className="btn-secondary">{l}</Link>)}</div></Card></div>
    </div>
  );
}
