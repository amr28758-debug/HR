'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Card, EmptyState, Pagination, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtMoney } from '@/lib/format';
import { BandBar, CompPage, Restricted, StatusPill, downloadCsv, pct } from '@/components/compensation/common';

export default function Page() { return <CompPage title="Employee compensation" subtitle="Every employee's salary against the band of their grade — compa-ratio, range penetration and headroom to the maximum."><List /></CompPage>; }

function List() {
  const { can } = useAuth();
  const sp = useSearchParams();
  const [f, setF] = useState<Record<string, any>>({ search: '', departmentId: '', siteId: '', gradeId: '', employmentType: '', gender: '', bandStatus: sp.get('bandStatus') ?? '', dueForReview: sp.get('dueForReview') ?? '', sort: 'employeeNo', order: 'asc', page: 1 });
  const q = useQuery({ queryKey: ['comp', 'employees', f], queryFn: () => api<Paginated<any>>(`/api/v1/compensation/employees${qs({ ...f, pageSize: 50 })}`), enabled: can('salary:read') });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments') });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites') });
  const grades = useQuery({ queryKey: ['comp', 'grades'], queryFn: () => api<any[]>('/api/v1/compensation/grades') });
  const policy = useQuery({ queryKey: ['comp', 'policy'], queryFn: () => api<any>('/api/v1/compensation/settings/policy') });
  if (!can('salary:read')) return <Restricted perm="salary:read" />;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: 1 });
  const sort = (k: string) => setF({ ...f, sort: k, order: f.sort === k && f.order === 'asc' ? 'desc' : 'asc' });
  const th = (k: string, l: string) => <th><button className="font-semibold hover:text-brand" onClick={() => sort(k)}>{l}{f.sort === k ? (f.order === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>;
  const st = policy.data?.value?.statusThresholds;
  const statuses = st ? [st.belowMin, ...st.ranges, st.atMax, st.aboveMax, st.noBand] : [];
  return (
    <Card padded={false} title="Employees" subtitle={q.data ? `${q.data.meta.total} employees` : undefined} actions={can('reports:compensation') && <button className="btn-secondary btn-sm" onClick={() => downloadCsv('/api/v1/compensation/reports/salary-register?format=csv', 'salary-register.csv')}>Export register</button>}>
      <div className="grid gap-2 border-b p-4 sm:grid-cols-3 xl:grid-cols-7">
        <input className="input xl:col-span-2" placeholder="Search name or number…" value={f.search} onChange={set('search')} />
        <select className="input" value={f.departmentId} onChange={set('departmentId')}><option value="">All departments</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="input" value={f.siteId} onChange={set('siteId')}><option value="">All sites</option>{sites.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="input" value={f.gradeId} onChange={set('gradeId')}><option value="">All grades</option>{grades.data?.map((g) => <option key={g.id} value={g.id}>{g.code}</option>)}</select>
        <select className="input" value={f.bandStatus} onChange={set('bandStatus')}><option value="">Any band status</option>{statuses.map((s: any) => <option key={s.code} value={s.code}>{s.label}</option>)}</select>
        <select className="input" value={f.employmentType} onChange={set('employmentType')}><option value="">Any employment type</option>{['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN', 'DAILY_WAGE'].map((t) => <option key={t} value={t}>{t.replace('_', ' ').toLowerCase()}</option>)}</select>
      </div>
      {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data">
        <thead><tr>{th('employeeNo', 'Employee')}{th('department', 'Department')}{th('gradeCode', 'Grade')}{th('currentSalary', 'Salary')}<th className="min-w-44">Band position</th>{th('compaRatio', 'Compa')}{th('rangePenetration', 'Range')}<th>Status</th><th>Last increase</th></tr></thead>
        <tbody>{q.data.data.map((x) => <tr key={x.employeeId}>
          <td><Link href={`/compensation/employees/${x.employeeId}`} className="font-medium hover:text-brand">{x.name}</Link><div className="text-xs text-muted">{x.employeeNo} · {x.designation ?? '—'}</div></td>
          <td className="text-sm">{x.department ?? '—'}<div className="text-xs text-muted">{x.site ?? ''}</div></td>
          <td>{x.gradeCode ?? <span className="text-danger">missing</span>}</td>
          <td className="tabular-nums">{fmtMoney(x.currentSalary, x.currency)}</td>
          <td>{x.band ? <BandBar min={x.band.min} mid={x.band.mid} max={x.band.max} current={x.currentSalary} compact currency={x.currency} /> : <span className="text-xs text-muted">no band</span>}</td>
          <td className="tabular-nums">{pct(x.compaRatio)}</td><td className="tabular-nums">{pct(x.rangePenetration)}</td>
          <td><StatusPill status={x.bandStatus} />{x.dueForReview && <div className="mt-1 text-[11px] text-success">🟢 due for review</div>}</td>
          <td className="text-xs">{fmtDate(x.lastIncreaseDate)}</td>
        </tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No employees match" /></div>}
      {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
    </Card>
  );
}
