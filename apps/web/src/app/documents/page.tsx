'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { FileWarning, FileText } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, PageHeader, StatTile, TableSkeleton, cn } from '@/components/ui';
import { fmtDate, humanStatus } from '@/lib/format';

export default function Page() { return <AppShell><Documents /></AppShell>; }

const CATEGORIES: Record<string, string[]> = { Identity: ['PASSPORT', 'EMIRATES_ID', 'VISA', 'LABOUR_CARD'], Contract: ['CONTRACT'], Insurance: ['INSURANCE'], Licences: ['DRIVING_LICENSE', 'CERTIFICATE'], Other: ['OTHER'] };

function Documents() {
  const { can, principal } = useAuth();
  const sp = useSearchParams();
  const [days, setDays] = useState(sp.get('status') === 'EXPIRED' ? 0 : 90);
  const [type, setType] = useState('');
  const q = useQuery({ queryKey: ['docs', 'expiring', days], queryFn: () => api<any[]>(`/api/v1/employees/documents/expiring?days=${Math.max(days, 0)}`), enabled: can('employees:documents:read') });
  const mine = useQuery({ queryKey: ['documents', principal?.employeeId], queryFn: () => api<any[]>(`/api/v1/employees/${principal!.employeeId}/documents`), enabled: !can('employees:documents:read') && !!principal?.employeeId });
  if (!can('employees:documents:read')) {
    return <><PageHeader eyebrow="Documents" title="My documents" subtitle="Your identity, visa and contract documents with expiry status." />{mine.isLoading ? <TableSkeleton /> : mine.data?.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{mine.data.map((d) => <div key={d.id} className="card p-4"><div className="flex items-center justify-between"><span className="font-semibold">{humanStatus(d.documentType)}</span><Badge status={d.status} /></div><p className="mt-1 text-xs text-muted">{d.documentNumber ? `···${String(d.documentNumber).slice(-4)}` : '—'} · expires {fmtDate(d.expiryDate)}</p></div>)}</div> : <EmptyState hint="HR has not recorded any documents yet." />}</>;
  }
  const rows: any[] = (q.data ?? []).filter((d) => (!type || d.documentType === type) && (days > 0 || (d.daysToExpiry ?? 0) < 0));
  const expired = (q.data ?? []).filter((d) => (d.daysToExpiry ?? 0) < 0).length;
  const groups = Object.entries(CATEGORIES).map(([g, types]) => ({ g, n: rows.filter((d) => types.includes(d.documentType)).length }));
  return (
    <>
      <PageHeader eyebrow="Documents" title="Document center" subtitle="Expiry watch-list across the workforce, grouped by category. Add or renew documents from the employee profile." actions={<Link href="/documents/letters" className="btn-secondary"><FileText size={15} />Letters</Link>} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Expired" value={expired} tone={expired ? 'danger' : 'default'} icon={<FileWarning size={18} />} /><StatTile label={`Expiring within ${days || 90} days`} value={(q.data ?? []).filter((d) => (d.daysToExpiry ?? 0) >= 0).length} tone="warning" /><StatTile label="Identity documents flagged" value={groups.find((x) => x.g === 'Identity')?.n ?? 0} /><StatTile label="Contracts / insurance flagged" value={(groups.find((x) => x.g === 'Contract')?.n ?? 0) + (groups.find((x) => x.g === 'Insurance')?.n ?? 0)} /></div>
      <Alert tone="info">Document validity rules (grace periods, renewal lead times) are configurable in the Configuration center — reminder thresholds default to 30/60/90 days. Legal deadlines REQUIRE HR/LEGAL SIGN-OFF.</Alert>
      <div className="mt-4 mb-3 flex flex-wrap gap-2">{[[30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '180 days'], [0, 'Expired only']].map(([d, l]: any) => <button key={d} onClick={() => setDays(d)} className={cn('rounded-full px-3 py-1 text-xs font-semibold transition', days === d ? 'bg-brand text-brand-fg' : 'bg-surface-2 text-muted hover:text-fg')}>{l}</button>)}<span className="mx-2 border-s" />{Object.entries(CATEGORIES).flatMap(([, t]) => t).map((t) => <button key={t} onClick={() => setType(type === t ? '' : t)} className={cn('rounded-full px-3 py-1 text-xs font-semibold transition', type === t ? 'bg-accent text-white' : 'bg-surface-2 text-muted hover:text-fg')}>{humanStatus(t)}</button>)}</div>
      <Card padded={false}>
        {q.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Employee</th><th>Document</th><th>Number</th><th>Expiry</th><th>Days</th><th>Status</th><th>Site / project</th></tr></thead><tbody>{rows.sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0)).map((d) => <tr key={d.id ?? `${d.employeeNo}-${d.documentType}`}><td><Link href={`/employees/${d.employeeId}?tab=documents`} className="font-medium hover:underline">{d.employeeName}</Link><span className="block text-[11px] text-muted">{d.employeeNo}</span></td><td>{humanStatus(d.documentType)}</td><td className="font-mono text-xs">{d.documentNumber ?? '—'}</td><td>{fmtDate(d.expiryDate)}</td><td className={cn('tabular-nums font-semibold', (d.daysToExpiry ?? 0) < 0 ? 'text-danger' : (d.daysToExpiry ?? 0) <= 30 ? 'text-warning' : '')}>{d.daysToExpiry}</td><td><Badge status={(d.daysToExpiry ?? 0) < 0 ? 'EXPIRED' : 'EXPIRING'} /></td><td className="text-xs text-muted">{[d.site, d.project].filter(Boolean).join(' · ') || '—'}</td></tr>)}</tbody></table></div> : <EmptyState title="Nothing expiring" hint="No documents match this window." />}
      </Card>
    </>
  );
}
