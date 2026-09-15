'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Inbox } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, StatTile, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, humanStatus } from '@/lib/format';
import { ActionModal } from '@/components/employee/actions';

export default function Page() { return <AppShell><Requests /></AppShell>; }

const TYPES = ['PROMOTION', 'TRANSFER', 'SALARY_CHANGE', 'INCREMENT', 'LOAN', 'ADVANCE', 'BONUS', 'DEDUCTION', 'LETTER', 'TRAINING', 'DISCIPLINARY', 'DOCUMENT', 'RESIGNATION', 'TERMINATION', 'OTHER'];
const ACTION_FOR: Record<string, string> = { LOAN: 'loan', ADVANCE: 'advance', LETTER: 'generate-letter', TRAINING: 'assign-training', RESIGNATION: 'resign', PROMOTION: 'promote', TRANSFER: 'transfer', SALARY_CHANGE: 'salary-change', BONUS: 'bonus', DEDUCTION: 'deduction', DISCIPLINARY: 'disciplinary', TERMINATION: 'terminate' };

function Requests() {
  const { can, principal } = useAuth();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const [f, setF] = useState({ q: '', type: '', status: sp.get('status') ?? '', page: 1 });
  const [create, setCreate] = useState(sp.get('new') === '1');
  const [pick, setPick] = useState<{ employeeId: string; action: string } | null>(null);
  const [newType, setNewType] = useState('LETTER');
  const [empQ, setEmpQ] = useState('');
  const list = useQuery({ queryKey: ['hr-requests', 'list', f], queryFn: () => api<Paginated<any>>(`/api/v1/hr-requests${qs({ ...f, pageSize: 25 })}`), placeholderData: (p) => p });
  const types = useQuery({ queryKey: ['hr-request-types'], queryFn: () => api<any[]>('/api/v1/hr-requests/types') });
  const emps = useQuery({ queryKey: ['employees', 'pick', empQ], queryFn: () => api<Paginated<any>>(`/api/v1/employees${qs({ q: empQ, pageSize: 8, working: true })}`), enabled: create && empQ.length >= 2 && can('requests:create:any') });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/api/v1/hr-requests/${id}/cancel`, { method: 'POST', json: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['hr-requests'] }) });
  const stats = useQuery({ queryKey: ['hr-requests', 'stats'], queryFn: async () => { const out: Record<string, number> = {}; for (const s of ['PENDING', 'APPLIED', 'REJECTED', 'FAILED']) out[s] = (await api<Paginated<any>>(`/api/v1/hr-requests?status=${s}&pageSize=1`)).meta.total; return out; } });
  const selfOnly = !can('requests:create:any');
  return (
    <>
      <PageHeader eyebrow="Workflows" title="HR requests" subtitle="Every promotion, transfer, salary change, loan, letter or exit goes through here — with its approval chain and what-changed trail." actions={(can('requests:create:any') || can('requests:create:own')) && <button className="btn-primary" onClick={() => setCreate(true)}><Plus size={16} />New request</button>} />
      {stats.data && <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatTile label="Awaiting approval" value={stats.data.PENDING} tone="warning" icon={<Inbox size={18} />} /><StatTile label="Applied" value={stats.data.APPLIED} tone="success" /><StatTile label="Rejected" value={stats.data.REJECTED} /><StatTile label="Failed to apply" value={stats.data.FAILED} tone={stats.data.FAILED ? 'danger' : 'default'} hint={stats.data.FAILED ? 'Fix the cause, then re-apply from the request page' : undefined} /></div>}
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b p-3">
          <input className="input sm:max-w-xs" placeholder="Search request no., title, employee…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
          <select className="input sm:w-48" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, page: 1 })}><option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{humanStatus(t)}</option>)}</select>
          <select className="input sm:w-44" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED', 'FAILED'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select>
        </div>
        {list.isLoading ? <TableSkeleton /> : list.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Request</th><th>Employee</th><th>Type</th><th>What changes</th><th>Effective</th><th>Current step</th><th>Status</th><th>Raised</th><th></th></tr></thead><tbody>
          {list.data.data.map((r) => <tr key={r.id}><td><Link href={`/requests/${r.id}`} className="link font-semibold">{r.requestNo}</Link><span className="block max-w-[220px] truncate text-[11px] text-muted">{r.title}</span></td><td><Link href={`/employees/${r.employee.id}`} className="font-medium hover:underline">{r.employee.name}</Link><span className="block text-[11px] text-muted">{r.employee.employeeNo} · {r.employee.designation ?? '—'}</span></td><td>{humanStatus(r.type)}</td><td className="max-w-xs text-xs">{r.changes.slice(0, 2).map((c: any) => <span key={c.field} className="me-1.5 inline-block rounded-md bg-surface-2 px-1.5 py-0.5">{humanStatus(c.field)} → <b>{String(c.to ?? '—')}</b></span>)}{r.changes.length > 2 && <span className="text-muted">+{r.changes.length - 2}</span>}</td><td>{fmtDate(r.effectiveDate)}</td><td>{r.currentStep ? <Badge status="PENDING">{humanStatus(r.currentStep)}</Badge> : '—'}</td><td><Badge status={r.status} /></td><td className="whitespace-nowrap text-xs text-muted">{fmtDateTime(r.requestedAt)}<span className="block">{r.requestedBy}</span></td><td>{r.status === 'PENDING' && (can('requests:create:any') || r.employee.id === principal?.employeeId) && <button className="btn-ghost btn-sm" onClick={() => { if (confirm(`Cancel ${r.requestNo}?`)) cancel.mutate(r.id); }}>Cancel</button>}</td></tr>)}
        </tbody></table></div> : <EmptyState hint="No requests match these filters." />}
        {list.data && <Pagination page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>

      <Modal open={create} onClose={() => setCreate(false)} title="New HR request">
        <div className="space-y-3">
          <Field label="Request type"><select className="input" value={newType} onChange={(e) => setNewType(e.target.value)}>{(types.data ?? []).filter((t) => (selfOnly ? ['LETTER', 'DOCUMENT', 'LOAN', 'ADVANCE', 'TRAINING', 'RESIGNATION', 'OTHER'].includes(t.type) : true) && ACTION_FOR[t.type]).map((t) => <option key={t.type} value={t.type}>{humanStatus(t.type)} — {t.steps.length ? `approvals: ${t.steps.join(' → ')}` : 'applied immediately'}</option>)}</select></Field>
          {selfOnly ? <Alert tone="info">The request will be raised for your own profile.</Alert> : <Field label="Employee"><input className="input" placeholder="Type a name or employee number…" value={empQ} onChange={(e) => setEmpQ(e.target.value)} />{emps.data?.data.length ? <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border">{emps.data.data.map((e) => <button key={e.id} className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-brand-soft/60" onClick={() => { setCreate(false); setPick({ employeeId: e.id, action: ACTION_FOR[newType]! }); }}><span>{e.fullNameEn}</span><span className="text-xs text-muted">{e.employeeNo} · {e.designation?.title ?? '—'}</span></button>)}</div> : null}</Field>}
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setCreate(false)}>Cancel</button>{selfOnly && principal?.employeeId && <button className="btn-primary" onClick={() => { setCreate(false); setPick({ employeeId: principal.employeeId!, action: ACTION_FOR[newType]! }); }}>Continue</button>}</div>
        </div>
      </Modal>
      <ActionModal employeeId={pick?.employeeId ?? ''} action={pick?.action ?? null} onClose={() => setPick(null)} onDone={() => { setPick(null); qc.invalidateQueries({ queryKey: ['hr-requests'] }); }} />
    </>
  );
}
