'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Users, Wallet, Scale, BarChart3, PiggyBank, TrendingUp, CheckCircle2, Hourglass, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Card, EmptyState, StatTile, TableSkeleton, cn } from '@/components/ui';
import { BarsChart, COLORS, TrendChart } from '@/components/charts';
import { fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { COLOR_HEX, CompPage, StatusPill, pct } from '@/components/compensation/common';

export default function Page() {
  const { can, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && !can('compensation:read') && can('salary:read:own')) router.replace('/compensation/pay-items'); }, [loading, can, router]);
  return <CompPage title="Compensation dashboard" subtitle="Payroll, salary positioning against the bands, budgets and approvals — live. Amounts are visible only with salary permission." actions={can('compensation:propose') && <Link href="/compensation/reviews?new=1" className="btn-primary">New salary review</Link>}><Dashboard /></CompPage>;
}

function Dashboard() {
  const { can } = useAuth();
  const [year, setYear] = useState<number | ''>('');
  const q = useQuery({ queryKey: ['comp', 'dashboard', year], queryFn: () => api<any>(`/api/v1/compensation/dashboard${year ? `?year=${year}` : ''}`), enabled: can('compensation:read') });
  const pending = useQuery({ queryKey: ['comp', 'my-approvals'], queryFn: () => api<any[]>('/api/v1/compensation/approvals/pending'), enabled: can('workflows:act') });
  if (!can('compensation:read')) return null;
  if (q.isLoading || !q.data) return <TableSkeleton rows={8} />;
  const d = q.data; const c = d.cards; const cur = d.currency;
  const money = (v: number | null) => (v === null ? '•••' : fmtMoney(v, cur));
  const bud = (b: any) => (b ? `${pct(b.utilizationPct)} used · ${fmtMoney(b.remaining, cur)} left` : 'No budget defined');
  const chips = [
    { k: 'aboveMax', label: 'Above maximum', dot: '🔴', href: '/compensation/employees?bandStatus=ABOVE_MAX' },
    { k: 'nearMax', label: 'Near maximum', dot: '🟠', href: '/compensation/alerts?type=NEAR_MAX' },
    { k: 'belowMin', label: 'Below minimum', dot: '🔵', href: '/compensation/employees?bandStatus=BELOW_MIN' },
    { k: 'pendingApproval', label: 'Pending approval', dot: '🟡', href: '/approvals' },
    { k: 'eligibleForReview', label: 'Eligible for review', dot: '🟢', href: '/compensation/employees?dueForReview=true' },
  ];
  const total = d.statusCounts.reduce((s: number, x: any) => s + x.count, 0) || 1;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((x) => <Link key={x.k} href={x.href} className="card card-hover flex items-center gap-2 px-3.5 py-2 text-sm"><span aria-hidden>{x.dot}</span><b className="tabular-nums">{fmtNum(d.alerts[x.k])}</b><span className="text-muted">{x.label}</span></Link>)}
        <span className="ms-auto" /><select className="input !w-32 shrink-0" value={year} onChange={(e) => setYear(e.target.value ? Number(e.target.value) : '')} aria-label="Budget year"><option value="">FY {d.year}</option>{[0, 1, 2].map((i) => new Date().getFullYear() - 1 + i).map((y) => <option key={y} value={y}>FY {y}</option>)}</select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Total employees" value={fmtNum(c.totalEmployees)} icon={<Users size={20} />} />
        <StatTile label="Monthly payroll" value={money(c.totalPayroll)} hint={c.annualPayroll !== null ? `${fmtMoney(c.annualPayroll, cur)} / year` : undefined} tone="accent" icon={<Wallet size={20} />} />
        <StatTile label={`Average salary (${d.salaryBasis.toLowerCase()})`} value={money(c.averageSalary)} icon={<Scale size={20} />} tone="info" />
        <StatTile label="Median salary" value={money(c.medianSalary)} icon={<BarChart3 size={20} />} tone="info" />
        <StatTile label={`Increment budget FY${d.year}`} value={money(c.incrementBudget?.amount ?? null)} hint={c.incrementBudget !== null ? bud(c.incrementBudget) : undefined} icon={<PiggyBank size={20} />} tone="success" />
        <StatTile label={`Promotion budget FY${d.year}`} value={money(c.promotionBudget?.amount ?? null)} hint={c.promotionBudget !== null ? bud(c.promotionBudget) : undefined} icon={<TrendingUp size={20} />} tone="success" />
        <StatTile label="Approved increase cost" value={money(c.approvedIncreaseCost)} hint={c.proposedIncreaseCost !== null ? `${fmtMoney(c.proposedIncreaseCost, cur)} incl. pending` : undefined} icon={<CheckCircle2 size={20} />} />
        <StatTile label="Pending approvals" value={fmtNum(c.pendingApprovals)} icon={<Hourglass size={20} />} tone={c.pendingApprovals ? 'warning' : 'default'} />
      </div>
      <Card title="Employees by salary band position" subtitle="Classification uses the configured thresholds (Settings → Policy)">
        <div className="flex h-4 overflow-hidden rounded-full">{d.statusCounts.map((s: any) => <div key={s.code} style={{ width: `${(s.count / total) * 100}%`, background: COLOR_HEX[s.color] }} title={`${s.label}: ${s.count}`} />)}</div>
        <div className="mt-3 flex flex-wrap gap-2">{d.statusCounts.map((s: any) => <Link key={s.code} href={`/compensation/employees?bandStatus=${s.code}`} className="inline-flex items-center gap-2"><StatusPill status={s} /><b className="text-sm tabular-nums">{s.count}</b></Link>)}</div>
      </Card>
      {d.amountsVisible ? <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Salary distribution" subtitle={`Employees per ${d.salaryBasis.toLowerCase()} salary range`}><BarsChart data={d.distribution} xKey="range" series={[{ key: 'employees', label: 'Employees', color: COLORS.brand }]} /></Card>
        <Card title="Payroll growth" subtitle="Monthly fixed payroll in force at month end (12 months)"><TrendChart data={d.payrollGrowth.map((x: any) => ({ date: x.month, total: x.total }))} series={[{ key: 'total', label: 'Monthly payroll', color: COLORS.brand }]} /></Card>
        <Card title="Average salary by grade vs band"><BarsChart data={d.byGrade} xKey="name" series={[{ key: 'bandMin', label: 'Band min', color: COLORS.muted }, { key: 'average', label: 'Average', color: COLORS.brand }, { key: 'bandMax', label: 'Band max', color: COLORS.warning }]} /></Card>
        <Card title="Salary by department" subtitle="Average and headcount"><BarsChart data={d.byDepartment.slice(0, 10)} xKey="name" series={[{ key: 'average', label: 'Average', color: COLORS.info }]} /></Card>
        <Card title="Salary by site"><BarsChart data={d.bySite.slice(0, 10)} xKey="name" series={[{ key: 'average', label: 'Average', color: COLORS.success }]} /></Card>
        <Card title="Payroll by department" padded={false}><table className="data"><thead><tr><th>Department</th><th>Employees</th><th>Monthly payroll</th><th>Average</th><th>Avg compa</th></tr></thead><tbody>{d.byDepartment.map((g: any) => <tr key={g.name}><td className="font-medium">{g.name}</td><td>{g.employees}</td><td className="tabular-nums">{fmtMoney(g.total, cur)}</td><td className="tabular-nums">{fmtMoney(g.average, cur)}</td><td>{pct(g.avgCompaRatio)}</td></tr>)}</tbody></table></Card>
      </div> : <Card><p className="text-sm text-muted">Charts with salary amounts require the <b>salary:read</b> permission. Counts above are shown without amounts.</p></Card>}
      <div className="grid gap-4 xl:grid-cols-2">
        <EmployeeList title="🔴 Above maximum" rows={d.aboveMaximum} currency={cur} extra={(x) => <span className="font-semibold text-danger">+{fmtMoney(x.aboveMaxBy, cur)}</span>} />
        <EmployeeList title="🟠 Near ceiling" rows={d.nearCeiling} currency={cur} extra={(x) => pct(x.rangePenetration)} />
      </div>
      {can('workflows:act') && <Card title="Waiting for my decision" padded={false} actions={<Link href="/approvals" className="btn-ghost btn-sm">Approvals inbox <ChevronRight size={14} /></Link>}>
        {pending.data?.length ? <table className="data"><thead><tr><th>Item</th><th>Step</th><th>Status</th><th>Amount</th><th>Since</th><th /></tr></thead><tbody>{pending.data.map((p) => <tr key={p.taskId}><td className="font-medium">{p.title}<div className="text-xs text-muted">{p.reference}</div></td><td>{p.step}</td><td>{p.status}</td><td className="tabular-nums">{p.amount === null ? '—' : fmtMoney(p.amount, cur)}</td><td className="text-xs">{fmtDateTime(p.createdAt)}</td><td><Link className="link" href={p.kind === 'REVIEW' ? `/compensation/reviews/${p.id}` : p.kind === 'PROMOTION' ? `/compensation/promotions?id=${p.id}` : `/compensation/changes/${p.id}`}>Open</Link></td></tr>)}</tbody></table> : <div className="p-5"><EmptyState title="Nothing waiting" hint="Compensation approvals assigned to you or your role appear here." /></div>}
      </Card>}
    </div>
  );
}

function EmployeeList({ title, rows, currency, extra }: { title: string; rows: any[]; currency: string; extra: (x: any) => React.ReactNode }) {
  return (
    <Card title={title} padded={false}>
      {rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Grade</th><th>Salary</th><th>Max</th><th>Compa</th><th /></tr></thead><tbody>{rows.map((x) => <tr key={x.employeeId}><td><Link className="font-medium hover:text-brand" href={`/compensation/employees/${x.employeeId}`}>{x.name}</Link><div className="text-xs text-muted">{x.employeeNo} · {x.department ?? '—'}</div></td><td>{x.grade ?? '—'}</td><td className="tabular-nums">{fmtMoney(x.salary, currency)}</td><td className="tabular-nums">{fmtMoney(x.max, currency)}</td><td>{pct(x.compaRatio)}</td><td className={cn('text-end tabular-nums')}>{extra(x)}</td></tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="None" hint="No employees in this position." /></div>}
    </Card>
  );
}
