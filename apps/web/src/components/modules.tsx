'use client';
import Link from 'next/link';
import { Users, Building2, FileText, Fingerprint, CalendarClock, Palmtree, Timer, FileSpreadsheet, Wallet, Receipt, BarChart3, Cpu, ShieldCheck, Plug, GitBranch, ChevronRight, CheckSquare, ScrollText } from 'lucide-react';
import { useAuth, useUi } from '@/lib/providers';
import { cn } from '@/components/ui';

type Feature = { href: string; en: string; ar: string; icon: typeof Users; perms: string[] };
type Section = { key: string; en: string; ar: string; blurbEn: string; blurbAr: string; tone: string; features: Feature[] };

export const SECTIONS: Section[] = [
  { key: 'workforce', en: 'Workforce', ar: 'القوى العاملة', blurbEn: 'People, structure and documents', blurbAr: 'الموظفون والهيكل والمستندات', tone: 'from-brand to-brand-deep', features: [
    { href: '/employees', en: 'Employees', ar: 'الموظفون', icon: Users, perms: ['employees:read', 'employees:read:team', 'employees:read:own'] },
    { href: '/organization', en: 'Departments, sites & projects', ar: 'الأقسام والمواقع والمشاريع', icon: Building2, perms: ['org:read'] },
    { href: '/reports', en: 'Expiring documents', ar: 'المستندات المنتهية', icon: FileText, perms: ['reports:hr'] },
    { href: '/approvals', en: 'Approvals inbox', ar: 'صندوق الموافقات', icon: CheckSquare, perms: ['workflows:act'] },
  ] },
  { key: 'time', en: 'Time', ar: 'الوقت والحضور', blurbEn: 'From the punch to the timesheet', blurbAr: 'من البصمة إلى كشف الدوام', tone: 'from-info to-brand', features: [
    { href: '/attendance', en: 'Daily attendance & exceptions', ar: 'الحضور اليومي والاستثناءات', icon: Fingerprint, perms: ['attendance:read', 'attendance:read:team', 'attendance:read:own'] },
    { href: '/shifts', en: 'Shifts & schedules', ar: 'الورديات والجداول', icon: CalendarClock, perms: ['shifts:read'] },
    { href: '/leave', en: 'Leave & balances', ar: 'الإجازات والأرصدة', icon: Palmtree, perms: ['leave:read', 'leave:read:team', 'leave:read:own'] },
    { href: '/overtime', en: 'Overtime', ar: 'العمل الإضافي', icon: Timer, perms: ['overtime:read', 'overtime:read:team', 'overtime:read:own'] },
    { href: '/timesheets', en: 'Monthly timesheets', ar: 'كشوف الدوام الشهرية', icon: FileSpreadsheet, perms: ['timesheets:read', 'timesheets:read:team', 'timesheets:read:own'] },
  ] },
  { key: 'pay', en: 'Pay', ar: 'الرواتب', blurbEn: 'Runs, payslips and labour cost', blurbAr: 'دورات الرواتب والقسائم والتكلفة', tone: 'from-accent to-warning', features: [
    { href: '/payroll', en: 'Payroll runs', ar: 'دورات الرواتب', icon: Wallet, perms: ['payroll:read'] },
    { href: '/payroll', en: 'My payslips', ar: 'قسائم راتبي', icon: Receipt, perms: ['payslips:read:own'] },
    { href: '/reports', en: 'Reports & labour cost', ar: 'التقارير وتكلفة العمالة', icon: BarChart3, perms: ['reports:hr', 'reports:attendance', 'reports:payroll', 'reports:cost'] },
  ] },
  { key: 'system', en: 'System', ar: 'النظام', blurbEn: 'Devices, integrations and audit', blurbAr: 'الأجهزة والتكاملات والتدقيق', tone: 'from-success to-info', features: [
    { href: '/devices', en: 'Biometric devices', ar: 'أجهزة البصمة', icon: Cpu, perms: ['devices:read'] },
    { href: '/settings', en: 'Integrations', ar: 'التكاملات', icon: Plug, perms: ['integrations:read'] },
    { href: '/settings', en: 'Workflow definitions', ar: 'تعريفات سير العمل', icon: GitBranch, perms: ['workflows:read'] },
    { href: '/settings', en: 'Audit trail', ar: 'سجل التدقيق', icon: ScrollText, perms: ['audit:read'] },
  ] },
];

/** Section map: every module with its features as direct links. Filtered by permissions. */
export function ModuleMap() {
  const { can } = useAuth();
  const { locale } = useUi();
  const ar = locale === 'ar';
  const sections = SECTIONS.map((s) => ({ ...s, features: s.features.filter((f) => f.perms.length === 0 || can(...f.perms)) })).filter((s) => s.features.length);
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {sections.map((s) => (
        <div key={s.key} className="card card-hover rise overflow-hidden">
          <div className={cn('bg-gradient-to-br px-5 py-4 text-white', s.tone)}><p className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/70">{ar ? 'قسم' : 'Section'}</p><h3 className="text-lg font-bold">{ar ? s.ar : s.en}</h3><p className="text-xs text-white/80">{ar ? s.blurbAr : s.blurbEn}</p></div>
          <ul className="p-2">{s.features.map((f) => { const Icon = f.icon; return <li key={f.href + f.en}><Link href={f.href} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition hover:bg-brand-soft/60"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2 text-brand"><Icon size={15} /></span><span className="flex-1">{ar ? f.ar : f.en}</span><ChevronRight size={14} className="rtl-flip text-muted opacity-0 transition group-hover:opacity-100" /></Link></li>; })}</ul>
        </div>
      ))}
    </div>
  );
}
export { ShieldCheck };
