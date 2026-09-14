'use client';
import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api } from '@/lib/api';
import { useUi } from '@/lib/providers';
import { Badge, Card, TableSkeleton } from '@/components/ui';
import { fmtMinutes, fmtMoney, monthName } from '@/lib/format';

export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <AppShell><Payslip id={id} /></AppShell>; }

const L = { en: { payslip: 'Payslip', employee: 'Employee', period: 'Period', earnings: 'Earnings', deductions: 'Deductions', net: 'Net salary', attendance: 'Attendance summary', paidDays: 'Paid days', absent: 'Absent days', unpaid: 'Unpaid leave', ot: 'Overtime', total: 'Total', rate: 'Rate', qty: 'Qty', amount: 'Amount', dailyRate: 'Daily rate', hourlyRate: 'Hourly rate', print: 'Print', company: 'Burtplace General Contracting' },
  ar: { payslip: 'قسيمة الراتب', employee: 'الموظف', period: 'الفترة', earnings: 'الاستحقاقات', deductions: 'الاستقطاعات', net: 'صافي الراتب', attendance: 'ملخص الحضور', paidDays: 'الأيام المدفوعة', absent: 'أيام الغياب', unpaid: 'إجازة بدون راتب', ot: 'العمل الإضافي', total: 'الإجمالي', rate: 'المعدل', qty: 'الكمية', amount: 'المبلغ', dailyRate: 'الأجر اليومي', hourlyRate: 'أجر الساعة', print: 'طباعة', company: 'بيرتبليس للمقاولات العامة' } };

function Payslip({ id }: { id: string }) {
  const { locale } = useUi();
  const t = L[locale];
  const q = useQuery({ queryKey: ['payroll', 'employee', id], queryFn: () => api<any>(`/api/v1/payroll/employees/${id}`) });
  const d = q.data;
  if (!d) return <TableSkeleton />;
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between print:hidden"><Link href={`/payroll/runs/${d.run.id}`} className="text-sm text-muted hover:underline">← {d.run.code}</Link><button className="btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} />{t.print}</button></div>
      <Card padded={false} className="print:border-0 print:shadow-none">
        <div className="flex items-start justify-between border-b p-6"><div><p className="text-lg font-bold">{t.company}</p><p className="text-xs text-muted">{t.payslip} · {d.payslipNo ?? d.run.code}</p></div><div className="text-end"><p className="text-sm font-semibold">{d.employeeName}</p><p className="text-xs text-muted">{d.employeeNo} · {d.departmentName ?? '—'} · {d.projectCode ?? '—'}</p><p className="text-xs text-muted">{t.period}: {monthName(d.run.month, locale)} {d.run.year}</p><Badge status={d.run.status} className="mt-1" /></div></div>
        <div className="grid gap-6 p-6 md:grid-cols-2">
          <div><h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{t.earnings}</h4><table className="w-full text-sm"><thead><tr className="text-[11px] text-muted"><th className="text-start font-medium">{t.earnings}</th><th className="text-end font-medium">{t.qty}</th><th className="text-end font-medium">{t.rate}</th><th className="text-end font-medium">{t.amount}</th></tr></thead><tbody>{d.earnings.map((l: any, i: number) => <tr key={i} className="border-t"><td className="py-1.5">{l.description ?? l.componentCode}{l.isAdjustment && <span className="ms-1 text-[10px] text-muted">(adj)</span>}</td><td className="text-end text-muted">{l.quantity ?? ''}</td><td className="text-end text-muted">{l.rate ?? ''}</td><td className="text-end tabular-nums">{fmtMoney(l.amount)}</td></tr>)}<tr className="border-t font-semibold"><td className="py-2" colSpan={3}>{t.total}</td><td className="text-end tabular-nums">{fmtMoney(d.totalEarnings)}</td></tr></tbody></table></div>
          <div><h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{t.deductions}</h4><table className="w-full text-sm"><thead><tr className="text-[11px] text-muted"><th className="text-start font-medium">{t.deductions}</th><th className="text-end font-medium">{t.qty}</th><th className="text-end font-medium">{t.rate}</th><th className="text-end font-medium">{t.amount}</th></tr></thead><tbody>{d.deductions.length === 0 && <tr><td className="py-1.5 text-muted" colSpan={4}>—</td></tr>}{d.deductions.map((l: any, i: number) => <tr key={i} className="border-t"><td className="py-1.5">{l.description ?? l.componentCode}</td><td className="text-end text-muted">{l.quantity ?? ''}</td><td className="text-end text-muted">{l.rate ?? ''}</td><td className="text-end tabular-nums">{fmtMoney(l.amount)}</td></tr>)}<tr className="border-t font-semibold"><td className="py-2" colSpan={3}>{t.total}</td><td className="text-end tabular-nums">{fmtMoney(d.totalDeductions)}</td></tr></tbody></table></div>
        </div>
        <div className="flex items-center justify-between border-t bg-surface-2/50 px-6 py-4"><span className="text-sm font-semibold">{t.net}</span><span className="text-2xl font-bold tabular-nums">{fmtMoney(d.netSalary, d.run.currency)}</span></div>
        <div className="border-t p-6"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{t.attendance}</h4><dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6"><div><dt className="text-xs text-muted">{t.paidDays}</dt><dd className="font-semibold">{d.paidDays}</dd></div><div><dt className="text-xs text-muted">{t.absent}</dt><dd className="font-semibold">{d.absentDays}</dd></div><div><dt className="text-xs text-muted">{t.unpaid}</dt><dd className="font-semibold">{d.unpaidLeaveDays}</dd></div><div><dt className="text-xs text-muted">{t.ot}</dt><dd className="font-semibold">{fmtMinutes(d.overtimeMinutes)}</dd></div><div><dt className="text-xs text-muted">{t.dailyRate}</dt><dd className="font-semibold">{d.dailyRate}</dd></div><div><dt className="text-xs text-muted">{t.hourlyRate}</dt><dd className="font-semibold">{d.hourlyRate}</dd></div></dl></div>
        {d.exceptions?.length > 0 && <div className="border-t px-6 py-3 text-xs text-warning print:hidden">{d.exceptions.join(' · ')}</div>}
      </Card>
    </div>
  );
}
