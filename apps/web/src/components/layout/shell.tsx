'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Users, Fingerprint, CalendarClock, Palmtree, Timer, FileSpreadsheet, Wallet, CheckSquare, Cpu, Building2, BarChart3, Settings, Search, Moon, Sun, Languages, LogOut, Bell, Menu, X, HelpCircle, Network, CalendarDays, Briefcase, Target, GraduationCap, Gavel, Coins, FolderOpen, FileSignature, Laptop, Inbox, UserCog, LineChart, SlidersHorizontal, Zap } from 'lucide-react';
import { useAuth, useUi } from '@/lib/providers';
import { api } from '@/lib/api';
import { Avatar, cn } from '@/components/ui';

type NavItem = { href: string; en: string; ar: string; icon: typeof Users; perms: string[]; exact?: boolean };
/** Information architecture: one group per HR domain, each with its features. Filtered by permissions. */
export const GROUPS: { title: { en: string; ar: string }; items: NavItem[] }[] = [
  { title: { en: 'Dashboard', ar: 'لوحة التحكم' }, items: [
    { href: '/', en: 'Home', ar: 'الرئيسية', icon: LayoutDashboard, perms: [], exact: true },
    { href: '/approvals', en: 'Approvals inbox', ar: 'صندوق الموافقات', icon: CheckSquare, perms: ['workflows:act'] },
  ] },
  { title: { en: 'People', ar: 'الموظفون' }, items: [
    { href: '/employees', en: 'Directory', ar: 'دليل الموظفين', icon: Users, perms: ['employees:read', 'employees:read:team', 'employees:read:own'] },
    { href: '/people/org-chart', en: 'Org chart', ar: 'الهيكل التنظيمي', icon: Network, perms: ['employees:read', 'employees:read:team'] },
    { href: '/people/calendar', en: 'HR calendar', ar: 'تقويم الموارد البشرية', icon: CalendarDays, perms: ['employees:read', 'employees:read:team'] },
  ] },
  { title: { en: 'Talent', ar: 'المواهب' }, items: [
    { href: '/talent/jobs', en: 'Jobs, grades & JDs', ar: 'الوظائف والدرجات', icon: Briefcase, perms: ['jobs:read'] },
    { href: '/talent/performance', en: 'Performance', ar: 'الأداء', icon: Target, perms: ['performance:read', 'performance:read:team', 'performance:read:own'] },
    { href: '/talent/training', en: 'Training & certificates', ar: 'التدريب والشهادات', icon: GraduationCap, perms: ['training:read', 'training:read:own'] },
    { href: '/talent/disciplinary', en: 'Disciplinary', ar: 'الإجراءات التأديبية', icon: Gavel, perms: ['disciplinary:read'] },
  ] },
  { title: { en: 'Time', ar: 'الوقت' }, items: [
    { href: '/attendance', en: 'Attendance', ar: 'الحضور', icon: Fingerprint, perms: ['attendance:read', 'attendance:read:team', 'attendance:read:own'] },
    { href: '/shifts', en: 'Shifts', ar: 'الورديات', icon: CalendarClock, perms: ['shifts:read'] },
    { href: '/timesheets', en: 'Timesheets', ar: 'كشوف الدوام', icon: FileSpreadsheet, perms: ['timesheets:read', 'timesheets:read:team', 'timesheets:read:own'] },
    { href: '/overtime', en: 'Overtime', ar: 'العمل الإضافي', icon: Timer, perms: ['overtime:read', 'overtime:read:team', 'overtime:read:own'] },
  ] },
  { title: { en: 'Leave', ar: 'الإجازات' }, items: [
    { href: '/leave', en: 'Leave & balances', ar: 'الإجازات والأرصدة', icon: Palmtree, perms: ['leave:read', 'leave:read:team', 'leave:read:own'] },
  ] },
  { title: { en: 'Compensation', ar: 'التعويضات' }, items: [
    { href: '/compensation', en: 'Salary, loans & bonuses', ar: 'الرواتب والقروض والمكافآت', icon: Coins, perms: ['compensation:read', 'salary:read:own'] },
  ] },
  { title: { en: 'Payroll', ar: 'الرواتب' }, items: [
    { href: '/payroll', en: 'Payroll runs & payslips', ar: 'دورات الرواتب والقسائم', icon: Wallet, perms: ['payroll:read', 'payslips:read:own'] },
  ] },
  { title: { en: 'Documents', ar: 'المستندات' }, items: [
    { href: '/documents', en: 'Document center', ar: 'مركز المستندات', icon: FolderOpen, perms: ['employees:documents:read', 'employees:read:own'] },
    { href: '/documents/letters', en: 'Letters', ar: 'الخطابات', icon: FileSignature, perms: ['letters:generate', 'letters:read:own'] },
  ] },
  { title: { en: 'Assets', ar: 'الأصول' }, items: [
    { href: '/assets', en: 'Asset register', ar: 'سجل الأصول', icon: Laptop, perms: ['assets:read', 'employees:read:own'] },
  ] },
  { title: { en: 'Workflows', ar: 'سير العمل' }, items: [
    { href: '/requests', en: 'HR requests', ar: 'طلبات الموارد البشرية', icon: Inbox, perms: ['requests:read', 'requests:read:team', 'requests:read:own'] },
    { href: '/workflows/delegations', en: 'Delegation', ar: 'التفويض', icon: UserCog, perms: ['workflows:act'] },
  ] },
  { title: { en: 'Reports', ar: 'التقارير' }, items: [
    { href: '/reports', en: 'Reports', ar: 'التقارير', icon: BarChart3, perms: ['reports:hr', 'reports:attendance', 'reports:payroll', 'reports:cost'] },
    { href: '/analytics', en: 'HR analytics & cost', ar: 'تحليلات الموارد البشرية', icon: LineChart, perms: ['analytics:read'] },
  ] },
  { title: { en: 'Administration', ar: 'الإدارة' }, items: [
    { href: '/organization', en: 'Organization', ar: 'الهيكل', icon: Building2, perms: ['org:read'] },
    { href: '/devices', en: 'Devices', ar: 'الأجهزة', icon: Cpu, perms: ['devices:read'] },
    { href: '/admin/config', en: 'Configuration center', ar: 'مركز الإعدادات', icon: SlidersHorizontal, perms: ['config:write', 'workflows:write', 'payroll:policy:write'] },
    { href: '/settings', en: 'Settings & audit', ar: 'الإعدادات والتدقيق', icon: Settings, perms: ['integrations:read', 'audit:read', 'users:read'] },
  ] },
];

/** ⌘K quick actions (navigation + create flows). */
const ACTIONS: { en: string; ar: string; href: string; perms: string[]; keywords: string }[] = [
  { en: 'New employee', ar: 'موظف جديد', href: '/employees?new=1', perms: ['employees:create'], keywords: 'create add hire onboarding' },
  { en: 'Promote / transfer / salary change (open an employee, then Actions)', ar: 'ترقية / نقل / تغيير راتب', href: '/employees', perms: ['requests:create:any'], keywords: 'promotion transfer salary' },
  { en: 'New HR request', ar: 'طلب جديد', href: '/requests?new=1', perms: ['requests:create:own', 'requests:create:any'], keywords: 'loan advance letter training resignation' },
  { en: 'Generate letter', ar: 'إصدار خطاب', href: '/documents/letters?new=1', perms: ['letters:generate', 'letters:read:own'], keywords: 'certificate noc salary employment' },
  { en: 'Bulk operation', ar: 'عملية جماعية', href: '/employees?bulk=1', perms: ['bulk:run'], keywords: 'mass transfer bonus training' },
  { en: 'Increment cycle', ar: 'دورة الزيادات', href: '/compensation?tab=increments', perms: ['compensation:write'], keywords: 'annual raise' },
  { en: 'Run payroll', ar: 'تشغيل الرواتب', href: '/payroll', perms: ['payroll:run'], keywords: 'calculate lock wps' },
  { en: 'Process attendance', ar: 'معالجة الحضور', href: '/attendance', perms: ['attendance:process'], keywords: 'punch recalculate' },
  { en: 'Delegate my approvals', ar: 'تفويض الموافقات', href: '/workflows/delegations', perms: ['workflows:act'], keywords: 'out of office vacation' },
  { en: 'HR control center', ar: 'مركز تحكم الموارد البشرية', href: '/', perms: ['analytics:read'], keywords: 'attention expiring probation' },
  { en: 'Org chart', ar: 'الهيكل التنظيمي', href: '/people/org-chart', perms: ['employees:read'], keywords: 'reporting lines' },
  { en: 'HR calendar', ar: 'التقويم', href: '/people/calendar', perms: ['employees:read'], keywords: 'holidays expiries' },
  { en: 'Configuration center', ar: 'الإعدادات', href: '/admin/config', perms: ['config:write'], keywords: 'grades lookups templates workflows policies' },
  { en: 'My profile', ar: 'ملفي', href: '/me', perms: [], keywords: 'self ess payslip leave' },
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
        {g.items.map((n) => { const active = n.exact ? pathname === n.href : pathname.startsWith(n.href) && !(n.href === '/documents' && pathname.startsWith('/documents/letters')); const Icon = n.icon; return (
          <Link key={n.href} href={n.href} onClick={() => setMobile(false)} className={cn('relative mb-0.5 flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition', active ? 'bg-white/10 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]' : 'text-side-muted hover:bg-white/5 hover:text-side-fg')}>
            {active && <span className="absolute inset-y-2 start-0 w-1 rounded-full bg-accent" />}<Icon size={17} strokeWidth={active ? 2.2 : 1.8} className={active ? 'text-accent' : ''} />{locale === 'ar' ? n.ar : n.en}
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
      {palette && <CommandPalette onClose={() => setPalette(false)} can={can} locale={locale} />}
    </div>
  );
}

function CommandPalette({ onClose, can, locale }: { onClose: () => void; can: (...p: string[]) => boolean; locale: string }) {
  const [q, setQ] = useState('');
  const router = useRouter();
  const { t } = useUi();
  const term = q.trim().toLowerCase();
  const pages = GROUPS.flatMap((g) => g.items).filter((n) => (n.perms.length === 0 || can(...n.perms)) && (term.length < 2 || `${n.en} ${n.ar}`.toLowerCase().includes(term)));
  const actions = ACTIONS.filter((a) => (a.perms.length === 0 || can(...a.perms)) && (term.length < 2 || `${a.en} ${a.ar} ${a.keywords}`.toLowerCase().includes(term)));
  const results = useQuery({ queryKey: ['search', q], queryFn: () => api<{ type: string; id: string; title: string; subtitle: string | null; link: string }[]>(`/api/v1/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-brand-deep/40 p-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div className="card rise w-full max-w-xl overflow-hidden shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4"><Search size={16} className="text-accent" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchHint')} className="h-14 flex-1 bg-transparent text-[15px] outline-none" onKeyDown={(e) => { if (e.key === 'Enter' && results.data?.[0]) { router.push(results.data[0].link); onClose(); } }} /><span className="kbd">esc</span></div>
        <div className="max-h-80 overflow-y-auto p-2">
          {q.length < 2 && <p className="px-3 pb-2 pt-3 text-center text-xs text-muted">Type an employee number (e.g. BP-26-777), a name, a site — or pick a quick action.</p>}
          {actions.length > 0 && <p className="px-3 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">Quick actions</p>}
          {actions.slice(0, term.length < 2 ? 6 : 8).map((a) => <button key={a.href + a.en} onClick={() => { router.push(a.href); onClose(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-brand-soft/60"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent"><Zap size={13} /></span><span className="flex-1 truncate text-sm font-medium">{locale === 'ar' ? a.ar : a.en}</span></button>)}
          {term.length >= 2 && pages.length > 0 && <p className="px-3 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">Pages</p>}
          {term.length >= 2 && pages.slice(0, 6).map((n) => { const Icon = n.icon; return <button key={n.href} onClick={() => { router.push(n.href); onClose(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-brand-soft/60"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-brand"><Icon size={13} /></span><span className="flex-1 truncate text-sm font-medium">{locale === 'ar' ? n.ar : n.en}</span></button>; })}
          {term.length >= 2 && !!results.data?.length && <p className="px-3 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">Records</p>}
          {results.data?.map((r) => <button key={`${r.type}-${r.id}`} onClick={() => { router.push(r.link); onClose(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-brand-soft/60"><span className="w-20 shrink-0 rounded-md bg-surface-2 px-1.5 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-muted">{r.type}</span><span className="flex-1 truncate text-sm font-medium">{r.title}</span>{r.subtitle && <span className="text-xs text-muted">{r.subtitle}</span>}</button>)}
          {q.length >= 2 && results.data?.length === 0 && actions.length === 0 && pages.length === 0 && <p className="px-3 py-8 text-center text-xs text-muted">{t('noData')}</p>}
        </div>
      </div>
    </div>
  );
}
