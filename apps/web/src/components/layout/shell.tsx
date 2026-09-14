'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Users, Fingerprint, CalendarClock, Palmtree, Timer, FileSpreadsheet, Wallet, CheckSquare, Cpu, Building2, BarChart3, Settings, Search, Moon, Sun, Languages, LogOut, Bell, Menu, X, HelpCircle } from 'lucide-react';
import { useAuth, useUi } from '@/lib/providers';
import { api } from '@/lib/api';
import { Avatar, cn } from '@/components/ui';
import type { TKey } from '@/i18n/dictionary';

type NavItem = { href: string; key: TKey; icon: typeof Users; perms: string[] };
const GROUPS: { title: { en: string; ar: string }; items: NavItem[] }[] = [
  { title: { en: 'Overview', ar: 'نظرة عامة' }, items: [
    { href: '/', key: 'dashboard', icon: LayoutDashboard, perms: [] },
    { href: '/approvals', key: 'approvals', icon: CheckSquare, perms: ['workflows:act'] },
  ] },
  { title: { en: 'Workforce', ar: 'القوى العاملة' }, items: [
    { href: '/employees', key: 'employees', icon: Users, perms: ['employees:read', 'employees:read:team', 'employees:read:own'] },
    { href: '/organization', key: 'organization', icon: Building2, perms: ['org:read'] },
  ] },
  { title: { en: 'Time', ar: 'الوقت' }, items: [
    { href: '/attendance', key: 'attendance', icon: Fingerprint, perms: ['attendance:read', 'attendance:read:team', 'attendance:read:own'] },
    { href: '/shifts', key: 'shifts', icon: CalendarClock, perms: ['shifts:read'] },
    { href: '/leave', key: 'leave', icon: Palmtree, perms: ['leave:read', 'leave:read:team', 'leave:read:own'] },
    { href: '/overtime', key: 'overtime', icon: Timer, perms: ['overtime:read', 'overtime:read:team', 'overtime:read:own'] },
    { href: '/timesheets', key: 'timesheets', icon: FileSpreadsheet, perms: ['timesheets:read', 'timesheets:read:team', 'timesheets:read:own'] },
  ] },
  { title: { en: 'Pay', ar: 'الرواتب' }, items: [
    { href: '/payroll', key: 'payroll', icon: Wallet, perms: ['payroll:read', 'payslips:read:own'] },
    { href: '/reports', key: 'reports', icon: BarChart3, perms: ['reports:hr', 'reports:attendance', 'reports:payroll', 'reports:cost'] },
  ] },
  { title: { en: 'System', ar: 'النظام' }, items: [
    { href: '/devices', key: 'devices', icon: Cpu, perms: ['devices:read'] },
    { href: '/settings', key: 'settings', icon: Settings, perms: ['integrations:read', 'audit:read', 'users:read'] },
  ] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { principal, loading, can, logout } = useAuth();
  const { t, dark, setDark, locale, setLocale } = useUi();
  const router = useRouter();
  const pathname = usePathname();
  const [palette, setPalette] = useState(false);
  const [mobile, setMobile] = useState(false);
  useEffect(() => { if (!loading && !principal) router.replace(`/login?next=${encodeURIComponent(pathname)}`); }, [loading, principal, router, pathname]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const notifications = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api<any[]>('/api/v1/workflows/notifications?unreadOnly=true'), enabled: !!principal && can('workflows:act'), refetchInterval: 60_000 });
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => n.perms.length === 0 || can(...n.perms)) })).filter((g) => g.items.length), [can]);
  if (loading || !principal) return <div className="flex h-screen items-center justify-center"><div className="flex items-center gap-3 text-sm text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />{t('loading')}</div></div>;

  const nav = (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
      {groups.map((g) => <div key={g.title.en}><p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-side-muted/80">{locale === 'ar' ? g.title.ar : g.title.en}</p>
        {g.items.map((n) => { const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href); const Icon = n.icon; return (
          <Link key={n.href} href={n.href} onClick={() => setMobile(false)} className={cn('relative mb-0.5 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition', active ? 'bg-white/10 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]' : 'text-side-muted hover:bg-white/5 hover:text-side-fg')}>
            {active && <span className="absolute inset-y-2 start-0 w-1 rounded-full bg-accent" />}<Icon size={17} strokeWidth={active ? 2.2 : 1.8} className={active ? 'text-accent' : ''} />{t(n.key)}
          </Link>); })}
      </div>)}
    </nav>
  );
  const brand = <div className="flex items-center gap-3 px-5 pb-5 pt-6"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent/70 text-sm font-extrabold text-white shadow-lg shadow-accent/30">BP</div><div><p className="text-[15px] font-bold leading-tight text-side-fg">Burtplace</p><p className="text-[11px] font-medium uppercase tracking-[0.18em] text-side-muted">Workforce</p></div></div>;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col bg-side text-side-fg lg:flex">
        {brand}{nav}
        <div className="border-t border-white/10 p-3"><div className="flex items-center gap-3 rounded-xl px-2 py-2"><Avatar name={principal.displayName} size="sm" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-side-fg">{principal.displayName}</p><p className="truncate text-[11px] text-side-muted">{principal.roles.join(', ').replace(/_/g, ' ')}</p></div><button className="rounded-lg p-1.5 text-side-muted transition hover:bg-white/10 hover:text-white" title={t('signOut')} onClick={() => { logout(); router.replace('/login'); }}><LogOut size={15} /></button></div></div>
      </aside>
      {mobile && <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobile(false)}><aside className="flex h-full w-72 flex-col bg-side text-side-fg" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between pe-4">{brand}<button onClick={() => setMobile(false)} className="text-side-muted"><X size={18} /></button></div>{nav}</aside></div>}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-bg/80 px-4 backdrop-blur-md lg:px-8">
          <button className="btn-ghost btn-sm lg:hidden" onClick={() => setMobile(true)}><Menu size={18} /></button>
          <button onClick={() => setPalette(true)} className="flex h-10 flex-1 items-center gap-2.5 rounded-xl border bg-surface px-3.5 text-sm text-muted shadow-card transition hover:border-brand/40 sm:max-w-lg"><Search size={15} /><span className="flex-1 text-start">{t('searchHint')}</span><span className="kbd hidden sm:inline">⌘K</span></button>
          <div className="ms-auto flex items-center gap-1">
            <span className="me-2 hidden rounded-full border bg-surface px-3 py-1.5 text-xs font-medium text-muted md:inline">{new Date().toLocaleDateString(locale === 'ar' ? 'ar-AE' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
            {can('workflows:act') && <Link href="/approvals" className="btn-ghost btn-sm relative" title={t('pendingApprovals')}><Bell size={17} />{!!notifications.data?.length && <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">{notifications.data.length}</span>}</Link>}
            <button className="btn-ghost btn-sm" title={t('language')} onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}><Languages size={17} /><span className="text-xs font-semibold">{locale === 'en' ? 'عربي' : 'EN'}</span></button>
            <button className="btn-ghost btn-sm" title={t('darkMode')} onClick={() => setDark(!dark)}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
            <a className="btn-ghost btn-sm hidden sm:inline-flex" href="/docs" target="_blank" rel="noreferrer" title="Help"><HelpCircle size={17} /></a>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 lg:p-8">{children}</main>
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const router = useRouter();
  const { t } = useUi();
  const results = useQuery({ queryKey: ['search', q], queryFn: () => api<{ type: string; id: string; title: string; subtitle: string | null; link: string }[]>(`/api/v1/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-brand-deep/40 p-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div className="card rise w-full max-w-xl overflow-hidden shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4"><Search size={16} className="text-accent" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchHint')} className="h-14 flex-1 bg-transparent text-[15px] outline-none" onKeyDown={(e) => { if (e.key === 'Enter' && results.data?.[0]) { router.push(results.data[0].link); onClose(); } }} /><span className="kbd">esc</span></div>
        <div className="max-h-80 overflow-y-auto p-2">
          {q.length < 2 && <p className="px-3 py-8 text-center text-xs text-muted">Type an employee number (e.g. BP-26-777), a name, a site or a document number.</p>}
          {results.data?.map((r) => <button key={`${r.type}-${r.id}`} onClick={() => { router.push(r.link); onClose(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-brand-soft/60"><span className="w-20 shrink-0 rounded-md bg-surface-2 px-1.5 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-muted">{r.type}</span><span className="flex-1 truncate text-sm font-medium">{r.title}</span>{r.subtitle && <span className="text-xs text-muted">{r.subtitle}</span>}</button>)}
          {q.length >= 2 && results.data?.length === 0 && <p className="px-3 py-8 text-center text-xs text-muted">{t('noData')}</p>}
        </div>
      </div>
    </div>
  );
}
