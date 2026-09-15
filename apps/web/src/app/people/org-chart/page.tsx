'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Avatar, Badge, Card, EmptyState, PageHeader, TableSkeleton, cn } from '@/components/ui';

export default function Page() { return <AppShell><OrgChart /></AppShell>; }

function OrgChart() {
  const { can } = useAuth();
  const sp = useSearchParams();
  const [dept, setDept] = useState('');
  const [depth, setDepth] = useState(4);
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments'), enabled: can('org:read') });
  const q = useQuery({ queryKey: ['org-chart', sp.get('rootId'), dept, depth], queryFn: () => api<any[]>(`/api/v1/employees/org-chart${qs({ rootId: sp.get('rootId'), departmentId: dept, depth })}`) });
  return (
    <>
      <PageHeader eyebrow="People" title="Org chart" subtitle="Reporting lines from the employee master. Click a person to open their profile; expand to walk the tree." actions={<>{depts.data && <select className="input sm:w-56" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{depts.data.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}<select className="input sm:w-32" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>{[2, 3, 4, 6, 8].map((d) => <option key={d} value={d}>{d} levels</option>)}</select></>} />
      {q.isLoading ? <TableSkeleton /> : q.data?.length ? <div className="space-y-4">{q.data.map((n) => <Node key={n.id} n={n} level={0} />)}</div> : <EmptyState hint="No reporting lines found for this filter." />}
    </>
  );
}

function Node({ n, level }: { n: any; level: number }) {
  const [open, setOpen] = useState(level < 2);
  return (
    <div className={cn(level > 0 && 'ms-6 border-s ps-4')}>
      <div className={cn('card flex items-center gap-3 p-3', level === 0 && 'border-accent/40 shadow-lift')}>
        <button className={cn('btn-ghost btn-sm', !n.children.length && 'invisible')} onClick={() => setOpen((o) => !o)}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} className="rtl-flip" />}</button>
        <Avatar name={n.name} size={level === 0 ? 'lg' : 'md'} />
        <div className="min-w-0 flex-1"><Link href={`/employees/${n.id}`} className="block truncate font-semibold hover:underline">{n.name}</Link><p className="truncate text-xs text-muted">{n.employeeNo} · {n.designation ?? '—'}{n.department ? ` · ${n.department}` : ''}{n.project ? ` · ${n.project}` : ''}</p></div>
        <Badge status={n.status} />
        {n.totalReports > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted"><Users size={12} />{n.directReports} direct · {n.totalReports} total</span>}
      </div>
      {open && n.children.length > 0 && <div className="mt-2 space-y-2">{n.children.map((c: any) => <Node key={c.id} n={c} level={level + 1} />)}</div>}
    </div>
  );
}
