'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Users, Fingerprint, CalendarClock, Palmtree, Timer, FileSpreadsheet, Wallet, CheckSquare, Cpu, Building2, BarChart3, Settings, Search, Moon, Sun, Languages, LogOut, Bell, Menu, X } from 'lucide-react';
import { useAuth, useUi } from '@/lib/providers';
import { api } from '@/lib/api';
import { Avatar, cn } from '@/components/ui';
import type { TKey } from '@/i18n/dictionary';

const NAV: { href: string; key: TKey; icon: typeof Users; perms: string[] }[] = [
  { href: '/', key: 'dashboard', icon: LayoutDashboard, perms: [] },
  { href: '/employees', key: 'employees', icon: Users, perms: ['employees:read', 'employees:read:team', 'employees:read:own'] },
  { href: '/attendance', key: 'attendance', icon: Fingerprint, perms: ['attendance:read', 'attendance:read:team', 'attendance:read:own'] },
  { href: '/shifts', key: 'shifts', icon: CalendarClock, perms: ['shifts:read'] },
  { href: '/leave', key: 'leave', icon: Palmtree, perms: ['leave:read', 'leave:read:team', 'leave:read:own'] },
  { href: '/overtime', key: 'overtime', icon: Timer, perms: ['overtime:read', 'overtime:read:team', 'overtime:read:own'] },
  { href: '/timesheets', key: 'timesheets', icon: FileSpreadsheet, perms: ['timesheets:read', 'timesheets:read:team', 'timesheets:read:own'] },
  { href: '/payroll', key: 'payroll', icon: Wallet, perms: ['payroll:read', 'payslips:read:own'] },
  { href: '/approvals', key: 'approvals', icon: CheckSquare, perms: ['workflows:act'] },
  { href: '/devices', key: 'devices', icon: Cpu, perms: ['devices:read'] },
  { href: '/organization', key: 'organization', icon: Building2, perms: ['org:read'] },
  { href: '/reports', key: 'reports', icon: BarChart3, perms: ['reports:hr', 'reports:attendance', 'reports:payroll', 'reports:cost'] },
  { href: '/settings', key: 'settings', icon: Settings, perms: ['integrations:read', 'audit:read', 'users:read'] },
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
  const items = useMemo(() => NAV.filter((n) => n.perms.length === 0 || can(...n.perms)), [can]);
  if (loading || !principal) return <div className="flex h-screen items-center justify-center text-sm text-muted">{t('loading')}</div>;

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-3">
      {items.map((n) => { const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href); const Icon = n.icon; return (
        <Link key={n.href} href={n.href} onClick={() => setMobile(false)} className={cn('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition', active ? 'bg-brand text-brand-fg shadow-sm' : 'text-muted hover:bg-surface-2 hover:text-fg')}><Icon size={17} strokeWidth={active ? 2.2 : 1.8} />{t(n.key)}</Link>
      ); })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-e bg-surface lg:flex">
        <div className="flex items-center gap-3 px-5 py-5"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-sm font-bold text-brand-fg">BP</div><div><p className="text-sm font-semibold leading-tight">Burtplace</p><p className="text-[11px] text-muted">Workforce</p></div></div>
        {nav}
        <div className="border-t p-3"><div className="flex items-center gap-3 rounded-xl px-2 py-2"><Avatar name={principal.displayName} size="sm" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{principal.displayName}</p><p className="truncate text-[11px] text-muted">{principal.roles.join(', ').replace(/_/g, ' ')}</p></div><button className="btn-ghost btn-sm" title={t('signOut')} onClick={() => { logout(); router.replace('/login'); }}><LogOut size={15} /></button></div></div>
      </aside>
      {mobile && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setMobile(false)}><aside className="flex h-full w-72 flex-col bg-surface py-4" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between px-5 pb-4"><span className="font-semibold">Burtplace</span><button onClick={() => setMobile(false)}><X size={18} /></button></div>{nav}</aside></div>}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-surface/80 px-4 backdrop-blur lg:px-6">
          <button className="btn-ghost btn-sm lg:hidden" onClick={() => setMobile(true)}><Menu size={18} /></button>
          <button onClick={() => setPalette(true)} className="flex h-9 flex-1 items-center gap-2 rounded-xl border bg-surface-2/60 px-3 text-sm text-muted transition hover:bg-surface-2 sm:max-w-md"><Search size={15} /><span className="flex-1 text-start">{t('searchHint')}</span><span className="kbd hidden sm:inline">⌘K</span></button>
          <div className="ms-auto flex items-center gap-1">
            {can('workflows:act') && <Link href="/approvals" className="btn-ghost btn-sm relative"><Bell size={17} />{!!notifications.data?.length && <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">{notifications.data.length}</span>}</Link>}
            <button className="btn-ghost btn-sm" title={t('language')} onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}><Languages size={17} /><span className="text-xs">{locale === 'en' ? 'عربي' : 'EN'}</span></button>
            <button className="btn-ghost btn-sm" title={t('darkMode')} onClick={() => setDark(!dark)}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6">{children}</main>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div className="card w-full max-w-xl overflow-hidden shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4"><Search size={16} className="text-muted" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchHint')} className="h-12 flex-1 bg-transparent text-sm outline-none" onKeyDown={(e) => { if (e.key === 'Enter' && results.data?.[0]) { router.push(results.data[0].link); onClose(); } }} /><span className="kbd">esc</span></div>
        <div className="max-h-80 overflow-y-auto p-2">
          {q.length < 2 && <p className="px-3 py-6 text-center text-xs text-muted">Type an employee number (e.g. BP-26-777), a name, a site or a document number.</p>}
          {results.data?.map((r) => <button key={`${r.type}-${r.id}`} onClick={() => { router.push(r.link); onClose(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-surface-2"><span className="w-20 shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase text-muted">{r.type}</span><span className="flex-1 truncate text-sm">{r.title}</span>{r.subtitle && <span className="text-xs text-muted">{r.subtitle}</span>}</button>)}
          {q.length >= 2 && results.data?.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted">{t('noData')}</p>}
        </div>
      </div>
    </div>
  );
}
