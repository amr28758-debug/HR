'use client';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { humanStatus, initials } from '@/lib/format';

export const cn = (...i: ClassValue[]) => twMerge(clsx(i));

export function Card({ className, children, title, actions, padded = true }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cn('card', className)}>
      {(title || actions) && <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5"><h3 className="text-sm font-semibold">{title}</h3><div className="flex items-center gap-2">{actions}</div></header>}
      <div className={cn(padded && 'p-5')}>{children}</div>
    </section>
  );
}

export function StatTile({ label, value, hint, tone = 'default', icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' | 'info'; icon?: ReactNode }) {
  const tones = { default: 'text-fg', success: 'text-success', warning: 'text-warning', danger: 'text-danger', info: 'text-info' };
  return (
    <div className="card flex items-start justify-between p-5">
      <div><p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p><p className={cn('mt-2 text-3xl font-semibold tabular-nums tracking-tight', tones[tone])}>{value}</p>{hint && <p className="mt-1 text-xs text-muted">{hint}</p>}</div>
      {icon && <div className="rounded-xl bg-surface-2 p-2.5 text-muted">{icon}</div>}
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  PRESENT: 'bg-success/10 text-success', ACTIVE: 'bg-success/10 text-success', CONFIRMED: 'bg-success/10 text-success', APPROVED: 'bg-success/10 text-success', PAID: 'bg-success/10 text-success', ONLINE: 'bg-success/10 text-success', LOCKED: 'bg-info/10 text-info', CLOSED: 'bg-surface-2 text-muted', VALID: 'bg-success/10 text-success', DONE: 'bg-success/10 text-success', RESOLVED: 'bg-success/10 text-success',
  ABSENT: 'bg-danger/10 text-danger', REJECTED: 'bg-danger/10 text-danger', TERMINATED: 'bg-danger/10 text-danger', OFFLINE: 'bg-danger/10 text-danger', EXPIRED: 'bg-danger/10 text-danger', ERROR: 'bg-danger/10 text-danger', HIGH: 'bg-danger/10 text-danger', CANCELLED: 'bg-surface-2 text-muted',
  LATE: 'bg-warning/10 text-warning', PENDING: 'bg-warning/10 text-warning', PROBATION: 'bg-warning/10 text-warning', MISSING_PUNCH: 'bg-warning/10 text-warning', HALF_DAY: 'bg-warning/10 text-warning', EXPIRING: 'bg-warning/10 text-warning', STALE: 'bg-warning/10 text-warning', MEDIUM: 'bg-warning/10 text-warning', OPEN: 'bg-warning/10 text-warning', HR_REVIEW: 'bg-warning/10 text-warning', FINANCE_REVIEW: 'bg-warning/10 text-warning', MANAGEMENT_APPROVAL: 'bg-warning/10 text-warning',
  ON_LEAVE: 'bg-info/10 text-info', WEEK_OFF: 'bg-surface-2 text-muted', PUBLIC_HOLIDAY: 'bg-brand-soft text-brand', IN_PROGRESS: 'bg-info/10 text-info', GENERATED: 'bg-info/10 text-info', DRAFT: 'bg-surface-2 text-muted', CALCULATING: 'bg-info/10 text-info', LOW: 'bg-surface-2 text-muted', UNKNOWN: 'bg-surface-2 text-muted',
};
export function Badge({ status, children, className }: { status?: string | null; children?: ReactNode; className?: string }) {
  const tone = (status && STATUS_TONES[status]) || 'bg-surface-2 text-muted';
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', tone, className)}>{children ?? humanStatus(status)}</span>;
}

export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const s = { sm: 'h-7 w-7 text-[10px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-sm', xl: 'h-20 w-20 text-xl' }[size];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(h) % 360;
  return <div className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', s, className)} style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 40) % 360} 60% 35%))` }}>{initials(name)}</div>;
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>{breadcrumb && <div className="mb-1 text-xs text-muted">{breadcrumb}</div>}<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title = 'Nothing here yet', hint, action }: { title?: string; hint?: string; action?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 py-14 text-center"><div className="rounded-2xl bg-surface-2 p-4 text-muted"><Inbox size={22} /></div><p className="text-sm font-medium">{title}</p>{hint && <p className="max-w-sm text-xs text-muted">{hint}</p>}{action}</div>;
}

export function Skeleton({ className }: { className?: string }) { return <div className={cn('skeleton h-4 w-full', className)} />; }
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return <div className="space-y-2 p-4">{Array.from({ length: rows }).map((_, i) => <div key={i} className="flex gap-3">{Array.from({ length: cols }).map((_, j) => <Skeleton key={j} className="h-5 flex-1" />)}</div>)}</div>;
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted">
      <span>{total.toLocaleString()} records · page {page} / {totalPages}</span>
      <div className="flex gap-1"><button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={14} className="rtl-flip" /></button><button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}><ChevronRight size={14} className="rtl-flip" /></button></div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => <button key={t.key} onClick={() => onChange(t.key)} className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition', value === t.key ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg')}>{t.label}{t.count !== undefined && <span className="ms-1.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums">{t.count}</span>}</button>)}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8vh] backdrop-blur-sm" onClick={onClose}>
      <div className={cn('card w-full shadow-pop', wide ? 'max-w-3xl' : 'max-w-lg')} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b px-5 py-3.5"><h3 className="text-sm font-semibold">{title}</h3><button className="btn-ghost btn-sm" onClick={onClose}><X size={16} /></button></header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return <label className={cn('block', className)}><span className="mb-1 block text-xs font-medium text-muted">{label}</span>{children}{hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}</label>;
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  const t = { info: 'bg-info/10 text-info', warning: 'bg-warning/10 text-warning', danger: 'bg-danger/10 text-danger', success: 'bg-success/10 text-success' }[tone];
  return <div className={cn('rounded-xl px-4 py-3 text-sm', t)}>{children}</div>;
}

export function KeyValue({ items, cols = 2 }: { items: { k: string; v: ReactNode }[]; cols?: 1 | 2 | 3 }) {
  return <dl className={cn('grid gap-x-6 gap-y-3', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3')}>{items.map((i) => <div key={i.k}><dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{i.k}</dt><dd className="mt-0.5 text-sm">{i.v ?? '—'}</dd></div>)}</dl>;
}
