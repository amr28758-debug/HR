'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api, qs, type Paginated } from '@/lib/api';
import { Avatar, cn } from '@/components/ui';

/** Type-ahead employee picker: searches name / number / mobile against the scoped directory, returns the employee id. */
export function EmployeePicker({ value, onChange, placeholder = 'Search by name or employee number…', exclude, workingOnly = true, className }: { value: string | null | undefined; onChange: (id: string | null, employee: any | null) => void; placeholder?: string; exclude?: string[]; workingOnly?: boolean; className?: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const selected = useQuery({ queryKey: ['employee', value], queryFn: () => api<any>(`/api/v1/employees/${value}`), enabled: !!value });
  const results = useQuery({ queryKey: ['employees', 'pick', q, workingOnly], queryFn: () => api<Paginated<any>>(`/api/v1/employees${qs({ q, pageSize: 8, working: workingOnly || undefined })}`), enabled: open && q.trim().length >= 2 });
  useEffect(() => { const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  if (value && selected.data) {
    const e = selected.data;
    return <div className={cn('flex items-center gap-3 rounded-xl border bg-surface px-3 py-2', className)}><Avatar name={e.fullNameEn} size="sm" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{e.fullNameEn}</span><span className="block truncate text-[11px] text-muted">{e.employeeNo} · {e.designation?.title ?? '—'}{e.project ? ` · ${e.project.code}` : ''}</span></span><button type="button" className="btn-ghost btn-sm" onClick={() => { onChange(null, null); setQ(''); }} title="Clear"><X size={14} /></button></div>;
  }
  const rows = (results.data?.data ?? []).filter((e) => !exclude?.includes(e.id));
  return (
    <div ref={box} className={cn('relative', className)}>
      <div className="flex items-center gap-2 rounded-xl border bg-surface px-3"><Search size={14} className="text-muted" /><input className="h-10 flex-1 bg-transparent text-sm outline-none" placeholder={placeholder} value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} /></div>
      {open && q.trim().length >= 2 && <div className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border bg-surface p-1 shadow-pop">
        {results.isLoading ? <p className="px-3 py-2 text-xs text-muted">Searching…</p> : rows.length ? rows.map((e) => <button type="button" key={e.id} onClick={() => { onChange(e.id, e); setOpen(false); }} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-brand-soft/60"><Avatar name={e.fullNameEn} size="sm" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{e.fullNameEn}</span><span className="block truncate text-[11px] text-muted">{e.employeeNo} · {e.designation?.title ?? '—'} · {e.department?.name ?? '—'}{e.project ? ` · ${e.project.code}` : ''}</span></span></button>) : <p className="px-3 py-2 text-xs text-muted">No matches.</p>}
      </div>}
    </div>
  );
}
