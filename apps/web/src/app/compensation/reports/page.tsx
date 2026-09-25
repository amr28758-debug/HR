'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, TableSkeleton, cn } from '@/components/ui';
import { humanStatus } from '@/lib/format';
import { CompPage, Restricted, downloadCsv } from '@/components/compensation/common';

const HINTS: Record<string, string> = {
  'salary-register': 'Every employee with salary, band, compa-ratio, range penetration and status', 'annual-increments': 'Annual & merit increases of the year', promotions: 'Promotion requests of the year',
  'salary-bands': 'Grades and every band version with employee counts', 'above-maximum': 'Employees paid above their band maximum', 'below-minimum': 'Employees paid below their band minimum',
  'salary-ceiling': 'Employees in the upper part of their band', budgets: 'Allocated / proposed / approved / remaining per budget', 'department-analysis': 'Payroll, averages, compa and cost per department',
  'salary-history': 'Every salary change of the year (or one employee)', 'pending-approvals': 'Changes and reviews waiting, with the step and days waiting', 'change-audit': 'Compensation audit trail (user, time, old → new, IP)',
};
export default function Page() { return <CompPage title="Compensation reports" subtitle="Preview in the browser or export to CSV (opens in Excel). Salary-level reports require salary permission; every export is audited."><Reports /></CompPage>; }

function Reports() {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['comp', 'reports'], queryFn: () => api<any[]>('/api/v1/compensation/reports'), enabled: can('reports:compensation') });
  const [key, setKey] = useState<string | null>(null);
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const params = { year };
  const data = useQuery({ queryKey: ['comp', 'report', key, year], queryFn: () => api<any>(`/api/v1/compensation/reports/${key}${qs(params)}`), enabled: !!key, retry: false });
  if (!can('reports:compensation')) return <Restricted perm="reports:compensation" />;
  const rows: any[] = data.data?.data ?? [];
  const cols = rows.length ? Object.keys(rows[0]).filter((c) => rows.some((r) => r[c] !== undefined)) : [];
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <Card title="Reports" padded={false} className="lg:col-span-1" actions={<select className="input w-24" value={year} onChange={(e) => setYear(Number(e.target.value))}>{[-1, 0, 1, 2].map((i) => new Date().getFullYear() + i).map((y) => <option key={y} value={y}>{y}</option>)}</select>}>
        <ul>{list.data?.map((r) => <li key={r.key}><button onClick={() => setKey(r.key)} className={cn('flex w-full items-start gap-2 border-b px-4 py-3 text-start transition hover:bg-brand-soft/40', key === r.key && 'bg-brand-soft/60')}><FileSpreadsheet size={16} className="mt-0.5 shrink-0 text-brand" /><span><span className="block text-sm font-semibold">{r.name}</span><span className="text-xs text-muted">{HINTS[r.key]}</span></span></button></li>)}</ul>
      </Card>
      <Card className="lg:col-span-3" padded={false} title={key ? list.data?.find((r) => r.key === key)?.name : 'Select a report'} subtitle={data.data ? `${data.data.count} rows` : undefined} actions={key && <button className="btn-primary btn-sm" onClick={() => downloadCsv(`/api/v1/compensation/reports/${key}${qs({ ...params, format: 'csv' })}`, `compensation-${key}-${year}.csv`)}><Download size={14} /> Export CSV</button>}>
        {!key ? <div className="p-5"><EmptyState title="Pick a report on the left" /></div> : data.isLoading ? <TableSkeleton /> : data.isError ? <div className="p-5"><Alert tone="danger">{(data.error as Error).message}</Alert></div> : rows.length ? <div className="max-h-[70vh] overflow-auto"><table className="data"><thead><tr>{cols.map((c) => <th key={c} className="whitespace-nowrap">{humanStatus(c)}</th>)}</tr></thead><tbody>{rows.slice(0, 500).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="whitespace-nowrap text-xs">{r[c] === null || r[c] === undefined ? '—' : typeof r[c] === 'boolean' ? (r[c] ? 'yes' : 'no') : String(r[c]).slice(0, 120)}</td>)}</tr>)}</tbody></table>{rows.length > 500 && <p className="p-3 text-xs text-muted">Showing the first 500 rows — export for the full report.</p>}</div> : <div className="p-5"><EmptyState title="No rows" /></div>}
      </Card>
    </div>
  );
}
