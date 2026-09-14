'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs } from '@/lib/api';
import { Card, EmptyState, Field, PageHeader, TableSkeleton } from '@/components/ui';
import { today } from '@/lib/format';

export default function Page() { return <AppShell><Reports /></AppShell>; }
function Reports() {
  const list = useQuery({ queryKey: ['reports'], queryFn: () => api<{ key: string; name: string; permission: string }[]>('/api/v1/reports') });
  const runs = useQuery({ queryKey: ['payroll', 'runs'], queryFn: () => api<any[]>('/api/v1/payroll/runs').catch(() => []) });
  const [key, setKey] = useState<string>('hr/headcount');
  const [p, setP] = useState<Record<string, string>>({ from: `${today().slice(0, 7)}-01`, to: today(), groupBy: 'department', days: '90', runId: '' });
  const needsRange = key.startsWith('attendance/') || key === 'hr/joiners-leavers';
  const needsRun = key.startsWith('payroll/');
  const params = { ...(needsRange && { from: p.from, to: p.to }), ...(needsRun && { runId: p.runId || runs.data?.[0]?.id }), ...(key === 'hr/headcount' && { groupBy: p.groupBy }), ...(key === 'payroll/cost' && { groupBy: ['project', 'department', 'cost_center', 'site', 'employee'].includes(p.groupBy) ? p.groupBy : 'project' }), ...(key === 'hr/expiring-documents' && { days: p.days }) };
  const q = useQuery({ queryKey: ['report', key, params], queryFn: () => api<{ data: Record<string, unknown>[]; count: number }>(`/api/v1/reports/${key}${qs(params)}`), enabled: !needsRun || !!params.runId });
  const cols = q.data?.data[0] ? Object.keys(q.data.data[0]) : [];
  const download = async () => { const csv = await api<string>(`/api/v1/reports/${key}${qs({ ...params, format: 'csv' })}`, { raw: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${key.replace('/', '-')}.csv`; a.click(); };
  const groups = ['hr', 'attendance', 'payroll'];
  return (
    <>
      <PageHeader title="Reports" subtitle="Every report is filterable and exports to CSV (opens in Excel)." actions={<button className="btn-primary" onClick={download} disabled={!q.data?.data.length}><Download size={15} />Export CSV</button>} />
      <div className="grid gap-4 lg:grid-cols-4">
        <Card padded={false} className="lg:col-span-1"><nav className="p-2">{groups.map((g) => <div key={g}><p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted">{g}</p>{list.data?.filter((r) => r.key.startsWith(g + '/')).map((r) => <button key={r.key} onClick={() => setKey(r.key)} className={`block w-full rounded-lg px-3 py-1.5 text-start text-sm ${key === r.key ? 'bg-brand text-brand-fg' : 'hover:bg-surface-2'}`}>{r.name}</button>)}</div>)}</nav></Card>
        <Card padded={false} className="lg:col-span-3" title={list.data?.find((r) => r.key === key)?.name}>
          <div className="flex flex-wrap gap-2 border-b p-3">{needsRange && <><Field label="From"><input type="date" className="input" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></Field><Field label="To"><input type="date" className="input" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></Field></>}{needsRun && <Field label="Payroll run"><select className="input" value={p.runId || runs.data?.[0]?.id || ''} onChange={(e) => setP({ ...p, runId: e.target.value })}>{runs.data?.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.status}</option>)}</select></Field>}{(key === 'hr/headcount' || key === 'payroll/cost') && <Field label="Group by"><select className="input" value={p.groupBy} onChange={(e) => setP({ ...p, groupBy: e.target.value })}>{(key === 'hr/headcount' ? ['department', 'site', 'project', 'designation', 'nationality'] : ['project', 'department', 'cost_center', 'site', 'employee']).map((g) => <option key={g} value={g}>{g.replace('_', ' ')}</option>)}</select></Field>}{key === 'hr/expiring-documents' && <Field label="Within days"><input type="number" className="input w-28" value={p.days} onChange={(e) => setP({ ...p, days: e.target.value })} /></Field>}<span className="ms-auto self-end pb-2 text-xs text-muted">{q.data ? `${q.data.count} rows` : ''}</span></div>
          {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="max-h-[65vh] overflow-auto"><table className="data"><thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead><tbody>{q.data.data.map((row, i) => <tr key={i}>{cols.map((c) => { const v = row[c]; return <td key={c} className={typeof v === 'number' ? 'tabular-nums' : ''}>{v === null || v === undefined ? '—' : typeof v === 'number' ? v.toLocaleString() : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' }) : String(v)}</td>; })}</tr>)}</tbody></table></div> : <EmptyState title="No rows" hint="Adjust the filters or generate data for this period." />}
        </Card>
      </div>
    </>
  );
}
