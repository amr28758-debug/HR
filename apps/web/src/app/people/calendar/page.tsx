'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { Card, EmptyState, PageHeader, TableSkeleton, cn } from '@/components/ui';
import { monthName } from '@/lib/format';

export default function Page() { return <AppShell><HrCalendar /></AppShell>; }

const KIND: Record<string, { label: string; cls: string }> = {
  HOLIDAY: { label: 'Public holiday', cls: 'bg-accent/15 text-accent' }, LEAVE: { label: 'Leave', cls: 'bg-info/15 text-info' }, PROBATION_END: { label: 'Probation ends', cls: 'bg-warning/15 text-warning' }, CONTRACT_END: { label: 'Contract ends', cls: 'bg-danger/15 text-danger' },
  DOCUMENT_EXPIRY: { label: 'Document expiry', cls: 'bg-danger/10 text-danger' }, TRAINING: { label: 'Training', cls: 'bg-success/15 text-success' }, PAYROLL: { label: 'Payroll', cls: 'bg-brand/15 text-brand' }, ANNIVERSARY: { label: 'Work anniversary', cls: 'bg-surface-2 text-muted' },
};
function HrCalendar() {
  const [ym, setYm] = useState(() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() + 1 }; });
  const [kinds, setKinds] = useState<Set<string>>(new Set(Object.keys(KIND)));
  const from = `${ym.y}-${String(ym.m).padStart(2, '0')}-01`;
  const last = new Date(ym.y, ym.m, 0).getDate();
  const to = `${ym.y}-${String(ym.m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  const q = useQuery({ queryKey: ['hr-calendar', from, to], queryFn: () => api<any[]>(`/api/v1/analytics/calendar?from=${from}&to=${to}`) });
  const byDay = useMemo(() => { const m = new Map<string, any[]>(); for (const e of q.data ?? []) { if (!kinds.has(e.kind)) continue; const start = e.date < from ? from : e.date, end = e.endDate && e.endDate > e.date ? (e.endDate > to ? to : e.endDate) : start; for (let d = new Date(`${start}T00:00:00`); d <= new Date(`${end}T00:00:00`); d.setDate(d.getDate() + 1)) { const k = d.toISOString().slice(0, 10); if (!m.has(k)) m.set(k, []); m.get(k)!.push(e); } } return m; }, [q.data, kinds, from, to]);
  const firstDow = (new Date(ym.y, ym.m - 1, 1).getDay() + 1) % 7; // week starts Saturday (UAE)
  const cells = [...Array(firstDow).fill(null), ...Array.from({ length: last }, (_, i) => i + 1)];
  const toggle = (k: string) => setKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <>
      <PageHeader eyebrow="People" title="HR calendar" subtitle="Holidays, approved leave, probation and contract end dates, document expiries, training and payroll cut-offs in one view." actions={<div className="flex items-center gap-2"><button className="btn-secondary btn-sm" onClick={() => setYm(ym.m === 1 ? { y: ym.y - 1, m: 12 } : { y: ym.y, m: ym.m - 1 })}>‹</button><span className="min-w-36 text-center text-sm font-semibold">{monthName(ym.m)} {ym.y}</span><button className="btn-secondary btn-sm" onClick={() => setYm(ym.m === 12 ? { y: ym.y + 1, m: 1 } : { y: ym.y, m: ym.m + 1 })}>›</button></div>} />
      <div className="mb-4 flex flex-wrap gap-2">{Object.entries(KIND).map(([k, v]) => <button key={k} onClick={() => toggle(k)} className={cn('rounded-full px-3 py-1 text-xs font-semibold transition', kinds.has(k) ? v.cls : 'bg-surface-2 text-muted line-through opacity-60')}>{v.label} · {(q.data ?? []).filter((e) => e.kind === k).length}</button>)}</div>
      <Card padded={false}>
        {q.isLoading ? <TableSkeleton /> : <div className="grid grid-cols-7 border-b text-center text-[10px] font-bold uppercase tracking-wider text-muted">{['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => <div key={d} className="py-2">{d}</div>)}</div>}
        <div className="grid grid-cols-7">{cells.map((d, i) => { const key = d ? `${ym.y}-${String(ym.m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : ''; const ev = d ? byDay.get(key) ?? [] : []; const isToday = key === new Date().toISOString().slice(0, 10); return <div key={i} className={cn('min-h-24 border-b border-e p-1.5 text-xs', !d && 'bg-surface-2/40', (i % 7 === 6) && 'bg-surface-2/30')}>{d && <><p className={cn('mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full font-semibold', isToday && 'bg-accent text-white')}>{d}</p><div className="space-y-0.5">{ev.slice(0, 4).map((e, j) => <Link key={j} href={e.link ?? '#'} title={e.title} className={cn('block truncate rounded px-1.5 py-0.5 text-[10px] font-medium', KIND[e.kind]?.cls)}>{e.title}</Link>)}{ev.length > 4 && <p className="px-1 text-[10px] text-muted">+{ev.length - 4} more</p>}</div></>}</div>; })}</div>
      </Card>
      {q.data && q.data.length === 0 && <div className="mt-4"><EmptyState title="Quiet month" hint="No events found for this period." /></div>}
    </>
  );
}
