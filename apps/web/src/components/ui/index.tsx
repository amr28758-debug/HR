'use client';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X, ChevronLeft, ChevronRight, Inbox, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { humanStatus, initials } from '@/lib/format';

export const cn = (...i: ClassValue[]) => twMerge(clsx(i));

export function Card({ className, children, title, subtitle, actions, padded = true, hover }: { className?: string; children: ReactNode; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; padded?: boolean; hover?: boolean }) {
  return (
    <section className={cn('card rise', hover && 'card-hover', className)}>
      {(title || actions) && <header className="flex items-center justify-between gap-3 border-b px-5 py-4"><div><h3 className="text-[15px] font-semibold">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}</div><div className="flex items-center gap-2">{actions}</div></header>}
      <div className={cn(padded && 'p-5')}>{children}</div>
    </section>
  );
}

export function StatTile({ label, value, hint, tone = 'default', icon, delta }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent'; icon?: ReactNode; delta?: { value: number; label?: string } }) {
  const tones = { default: 'text-fg', success: 'text-success', warning: 'text-warning', danger: 'text-danger', info: 'text-info', accent: 'text-accent' };
  const chips = { default: 'from-brand to-brand-deep text-white', success: 'from-success to-success/70 text-white', warning: 'from-warning to-warning/70 text-white', danger: 'from-danger to-danger/70 text-white', info: 'from-info to-info/70 text-white', accent: 'from-accent to-accent/70 text-white' };
  return (
    <div className="card card-hover rise relative overflow-hidden p-5">
      <div className="pointer-events-none absolute -end-6 -top-6 h-24 w-24 rounded-full bg-brand-soft/60 blur-2xl" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</p><p className={cn('mt-2 font-bold leading-none tabular-nums tracking-tight', typeof value === 'string' && value.length > 12 ? 'text-[22px]' : typeof value === 'string' && value.length > 8 ? 'text-[26px]' : 'text-[30px]', tones[tone])}>{value}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">{delta && <span className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold', delta.value >= 0 ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}>{delta.value >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(delta.value)}{delta.label ?? '%'}</span>}{hint && <span>{hint}</span>}</div></div>
        {icon && <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br shadow-md', chips[tone])}>{icon}</div>}
      </div>
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  PRESENT: 'success', ACTIVE: 'success', CONFIRMED: 'success', APPROVED: 'success', PAID: 'success', ONLINE: 'success', VALID: 'success', DONE: 'success', RESOLVED: 'success', COMPLETED: 'success',
  LOCKED: 'info', CLOSED: 'muted', CANCELLED: 'muted', WEEK_OFF: 'muted', DRAFT: 'muted', LOW: 'muted', UNKNOWN: 'muted', ARCHIVED: 'muted', NOT_APPLICABLE: 'muted',
  ABSENT: 'danger', REJECTED: 'danger', TERMINATED: 'danger', OFFLINE: 'danger', EXPIRED: 'danger', ERROR: 'danger', HIGH: 'danger',
  LATE: 'warning', PENDING: 'warning', PROBATION: 'warning', MISSING_PUNCH: 'warning', HALF_DAY: 'warning', EXPIRING: 'warning', STALE: 'warning', MEDIUM: 'warning', OPEN: 'warning', HR_REVIEW: 'warning', FINANCE_REVIEW: 'warning', MANAGEMENT_APPROVAL: 'warning', CALCULATING: 'warning', RESIGNED: 'warning', CLEARANCE: 'warning',
  ON_LEAVE: 'info', PUBLIC_HOLIDAY: 'accent', IN_PROGRESS: 'info', GENERATED: 'info', SUBMITTED: 'info', ONBOARDING: 'info', OFFER: 'info', CANDIDATE: 'info',
};
const TONE_CLS: Record<string, string> = { success: 'bg-success/10 text-success', danger: 'bg-danger/10 text-danger', warning: 'bg-warning/10 text-warning', info: 'bg-info/10 text-info', accent: 'bg-accent-soft text-accent', muted: 'bg-surface-2 text-muted' };
const DOT_CLS: Record<string, string> = { success: 'bg-success', danger: 'bg-danger', warning: 'bg-warning', info: 'bg-info', accent: 'bg-accent', muted: 'bg-muted' };
export function Badge({ status, children, className, dot = true }: { status?: string | null; children?: ReactNode; className?: string; dot?: boolean }) {
  const tone = (status && STATUS_TONES[status]) || 'muted';
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none', TONE_CLS[tone], className)}>{dot && status && <span className={cn('h-1.5 w-1.5 rounded-full', DOT_CLS[tone])} />}{children ?? humanStatus(status)}</span>;
}

export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const s = { sm: 'h-8 w-8 text-[11px]', md: 'h-10 w-10 text-xs', lg: 'h-14 w-14 text-base', xl: 'h-24 w-24 text-2xl' }[size];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const hue = 200 + (Math.abs(h) % 40) - 20;
  return <div className={cn('flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-white/70 dark:ring-white/10', s, className)} style={{ background: `linear-gradient(135deg, hsl(${hue} 45% 38%), hsl(${hue + 20} 50% 24%))` }}>{initials(name)}</div>;
}

export function PageHeader({ title, subtitle, actions, breadcrumb, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 rise">
      <div>{breadcrumb && <div className="mb-1.5 text-xs text-muted">{breadcrumb}</div>}{eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}<h1 className="text-[28px] font-bold leading-tight tracking-tight">{title}</h1>{subtitle && <p className="mt-1.5 max-w-2xl text-sm text-muted">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title = 'Nothing here yet', hint, action, icon }: { title?: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">{icon ?? <Inbox size={22} />}</div><p className="text-[15px] font-semibold">{title}</p>{hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}{action && <div className="mt-1">{action}</div>}</div>;
}

export function Skeleton({ className }: { className?: string }) { return <div className={cn('skeleton h-4 w-full', className)} />; }
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return <div className="space-y-3 p-5">{Array.from({ length: rows }).map((_, i) => <div key={i} className="flex gap-3">{Array.from({ length: cols }).map((_, j) => <Skeleton key={j} className="h-5 flex-1" />)}</div>)}</div>;
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-muted">
      <span><b className="text-fg">{total.toLocaleString()}</b> records · page {page} of {totalPages}</span>
      <div className="flex gap-1"><button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={14} className="rtl-flip" /></button><button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}><ChevronRight size={14} className="rtl-flip" /></button></div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="mb-5 inline-flex max-w-full gap-1 overflow-x-auto rounded-2xl border bg-surface p-1 shadow-card">
      {tabs.map((t) => <button key={t.key} onClick={() => onChange(t.key)} className={cn('whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-medium transition', value === t.key ? 'bg-brand text-brand-fg shadow-sm' : 'text-muted hover:bg-surface-2 hover:text-fg')}>{t.label}{t.count !== undefined && <span className={cn('ms-1.5 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', value === t.key ? 'bg-white/20' : 'bg-surface-2')}>{t.count}</span>}</button>)}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-brand-deep/40 p-4 pt-[8vh] backdrop-blur-sm" onClick={onClose}>
      <div className={cn('card rise w-full shadow-pop', wide ? 'max-w-3xl' : 'max-w-lg')} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b px-5 py-4"><h3 className="text-[15px] font-semibold">{title}</h3><button className="btn-ghost btn-sm" onClick={onClose}><X size={16} /></button></header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return <label className={cn('block', className)}><span className="mb-1.5 block text-xs font-semibold text-muted">{label}</span>{children}{hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}</label>;
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  const t = { info: 'bg-info/10 text-info border-info/20', warning: 'bg-warning/10 text-warning border-warning/20', danger: 'bg-danger/10 text-danger border-danger/20', success: 'bg-success/10 text-success border-success/20' }[tone];
  return <div className={cn('rounded-xl border px-4 py-3 text-sm', t)}>{children}</div>;
}

export function KeyValue({ items, cols = 2 }: { items: { k: string; v: ReactNode }[]; cols?: 1 | 2 | 3 }) {
  return <dl className={cn('grid gap-x-6 gap-y-4', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3')}>{items.map((i) => <div key={i.k}><dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">{i.k}</dt><dd className="mt-1 text-sm font-medium">{i.v ?? <span className="text-muted">—</span>}</dd></div>)}</dl>;
}

/** Action row item for "needs your attention" lists. */
export function ActionItem({ icon, title, hint, count, href, tone = 'default' }: { icon: ReactNode; title: string; hint?: string; count?: number; href: string; tone?: 'default' | 'warning' | 'danger' | 'success' }) {
  const t = { default: 'bg-brand-soft text-brand', warning: 'bg-warning/10 text-warning', danger: 'bg-danger/10 text-danger', success: 'bg-success/10 text-success' }[tone];
  return <a href={href} className="group flex items-center gap-4 rounded-xl px-3 py-3 transition hover:bg-surface-2"><span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', t)}>{icon}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold leading-snug">{title}</span>{hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}</span>{count !== undefined && <span className={cn('rounded-full px-2.5 py-1 text-xs font-bold tabular-nums', count > 0 ? t : 'bg-surface-2 text-muted')}>{count}</span>}<ChevronRight size={16} className="rtl-flip text-muted transition group-hover:translate-x-0.5" /></a>;
}
