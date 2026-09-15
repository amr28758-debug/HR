'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, PageHeader, StatTile, Tabs, TableSkeleton, cn } from '@/components/ui';
import { BarsChart, COLORS, TrendChart } from '@/components/charts';
import { fmtMoney, fmtNum, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Analytics /></AppShell>; }
type Tab = 'people' | 'cost';

function Analytics() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('people');
  const [months, setMonths] = useState(12);
  const [groupBy, setGroupBy] = useState('project');
  const hr = useQuery({ queryKey: ['analytics', 'hr', months], queryFn: () => api<any>(`/api/v1/analytics/hr?months=${months}`), enabled: can('analytics:read') });
  const cost = useQuery({ queryKey: ['analytics', 'cost', groupBy], queryFn: () => api<any>(`/api/v1/analytics/workforce-cost?groupBy=${groupBy}`), enabled: tab === 'cost' && can('salary:read') });
  if (!can('analytics:read')) return <Alert tone="danger">Your role does not include HR analytics.</Alert>;
  const d = hr.data;
  return (
    <>
      <PageHeader eyebrow="Reports" title="HR analytics" subtitle="Headcount, attrition, tenure, grade distribution, request throughput and workforce cost — computed live from the operational tables." actions={tab === 'people' ? <select className="input sm:w-36" value={months} onChange={(e) => setMonths(Number(e.target.value))}>{[6, 12, 24, 36].map((m) => <option key={m} value={m}>{m} months</option>)}</select> : <select className="input sm:w-44" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{['project', 'site', 'department', 'cost_center', 'grade', 'employee'].map((g) => <option key={g} value={g}>By {humanStatus(g).toLowerCase()}</option>)}</select>} />
      <Tabs tabs={[{ key: 'people', label: 'People' }, ...(can('salary:read') ? [{ key: 'cost' as Tab, label: 'Workforce cost' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'people' && (hr.isLoading || !d ? <TableSkeleton /> : <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Headcount (latest)" value={fmtNum(d.headcountTrend.at(-1)?.headcount)} hint={`${d.headcountTrend.at(-1)?.joined ?? 0} joined · ${d.headcountTrend.at(-1)?.left ?? 0} left this month`} /><StatTile label="Attrition · 12m" value={`${d.attrition.ratePct}%`} hint={`${d.attrition.last12mLeavers} leavers / avg ${fmtNum(Math.round(d.attrition.avgHeadcount))}`} tone={d.attrition.ratePct > 15 ? 'danger' : d.attrition.ratePct > 8 ? 'warning' : 'success'} /><StatTile label="Training completed · YTD" value={d.training.completedThisYear} hint={`${d.training.planned} planned · ${d.training.certificatesExpiring} certificates expiring`} tone="info" /><StatTile label={`Performance · ${d.performance.cycle ?? 'no cycle'}`} value={d.performance.avgRating ?? '—'} hint={`${d.performance.finalized}/${d.performance.reviews} finalised`} tone="accent" /></div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Headcount trend" subtitle="Working employees at month end, with joiners and leavers"><TrendChart data={d.headcountTrend} series={[{ key: 'headcount', label: 'Headcount', color: COLORS.brand }]} /><BarsChart data={d.headcountTrend} xKey="month" height={140} series={[{ key: 'joined', label: 'Joined', color: COLORS.success }, { key: 'left', label: 'Left', color: COLORS.danger }]} /></Card>
          <Card title="Tenure distribution"><BarsChart data={d.tenure} xKey="band" series={[{ key: 'count', label: 'Employees', color: COLORS.info }]} /></Card>
          <Card title="Grade distribution" subtitle={can('salary:read') ? 'Employees per grade and average basic' : 'Employees per grade'} padded={false}>{d.grades.length ? <table className="data"><thead><tr><th>Grade</th><th>Employees</th><th className="w-1/2">Share</th>{can('salary:read') && <th>Avg basic</th>}</tr></thead><tbody>{d.grades.map((g: any) => { const total = d.grades.reduce((s: number, x: any) => s + x.count, 0) || 1; return <tr key={g.grade}><td className="font-semibold">{g.grade}</td><td>{g.count}</td><td><div className="h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-brand" style={{ width: `${(g.count / total) * 100}%` }} /></div></td>{can('salary:read') && <td className="tabular-nums">{g.avgBasic !== null ? fmtMoney(g.avgBasic) : '—'}</td>}</tr>; })}</tbody></table> : <EmptyState hint="Link employees to grades under Talent → Jobs." />}</Card>
          <Card title="HR request throughput" subtitle="By type, with average time to decision" padded={false}>{d.requests.length ? <table className="data"><thead><tr><th>Type</th><th>Pending</th><th>Applied</th><th>Rejected</th><th>Avg decision</th></tr></thead><tbody>{d.requests.map((r: any) => <tr key={r.type}><td className="font-medium"><Link className="hover:underline" href={`/requests?type=${r.type}`}>{humanStatus(r.type)}</Link></td><td className={cn(r.pending && 'font-semibold text-warning')}>{r.pending}</td><td>{r.applied + r.approved}</td><td>{r.rejected}</td><td>{r.avgDecisionDays !== null ? `${r.avgDecisionDays} d` : '—'}</td></tr>)}</tbody></table> : <EmptyState hint="No HR requests yet." />}</Card>
        </div>
      </div>)}
      {tab === 'cost' && (cost.isLoading ? <TableSkeleton /> : cost.data && <div className="space-y-6">
        <Alert tone="info">Cost = latest gross salary per working employee (fixed monthly components). Overtime, bonuses and end-of-service accruals are not included; use payroll cost reports for actuals. Restricted to salary:read.</Alert>
        <div className="grid gap-4 sm:grid-cols-3"><StatTile label="Monthly fixed cost" value={fmtMoney(cost.data.total)} tone="accent" /><StatTile label="Working headcount" value={fmtNum(cost.data.headcount)} /><StatTile label="Average gross" value={fmtMoney(cost.data.headcount ? cost.data.total / cost.data.headcount : 0)} /></div>
        <Card title={`Workforce cost by ${humanStatus(groupBy).toLowerCase()}`} padded={false}><div className="overflow-x-auto"><table className="data"><thead><tr><th>{humanStatus(groupBy)}</th><th>Headcount</th><th>Basic</th><th>Gross / month</th><th>Avg gross</th><th className="w-1/3">Share</th></tr></thead><tbody>{cost.data.rows.map((r: any) => <tr key={r.key ?? r.label}><td className="font-medium">{r.label}</td><td>{r.headcount}</td><td className="tabular-nums">{fmtMoney(r.basic)}</td><td className="tabular-nums font-semibold">{fmtMoney(r.gross)}</td><td className="tabular-nums">{fmtMoney(r.avgGross)}</td><td><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-gradient-to-r from-brand to-accent" style={{ width: `${r.sharePct}%` }} /></div><span className="w-12 text-end text-xs tabular-nums text-muted">{r.sharePct}%</span></div></td></tr>)}</tbody></table></div></Card>
      </div>)}
    </>
  );
}
