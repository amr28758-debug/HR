'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, KeyValue, Modal, Pagination, TableSkeleton } from '@/components/ui';
import { EmployeePicker } from '@/components/employee-picker';
import { fmtDate, fmtMoney, humanStatus } from '@/lib/format';
import { AlertList, ApprovalTrail, CompPage, PromotionModal, Restricted, WfBadge, pct } from '@/components/compensation/common';

export default function Page() {
  const { can } = useAuth();
  const [pick, setPick] = useState(false);
  return <CompPage title="Promotions" subtitle="Promotion requests with the salary recommended by the configured rule for the target grade band. Approved promotions update grade, title and salary together." actions={can('compensation:propose') && <button className="btn-primary" onClick={() => setPick(true)}><Plus size={15} /> New promotion</button>}><Promotions pick={pick} setPick={setPick} /></CompPage>;
}

function Promotions({ pick, setPick }: { pick: boolean; setPick: (v: boolean) => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const sp = useSearchParams();
  const [f, setF] = useState({ status: '', year: '', page: 1 });
  const [emp, setEmp] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(sp.get('id'));
  const [toast, setToast] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['comp', 'promotions', f], queryFn: () => api<Paginated<any>>(`/api/v1/compensation/promotions${qs({ ...f, pageSize: 25 })}`), enabled: can('salary:read') });
  if (!can('salary:read')) return <Restricted perm="salary:read" />;
  return (
    <>
      {toast && <div className="mb-4"><Alert tone="success">{toast}</Alert></div>}
      <Card padded={false} actions={<><select className="input w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select><input className="input w-24" placeholder="Year" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value, page: 1 })} /></>} title="Promotion requests">
        {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Reference</th><th>Employee</th><th>From</th><th>To</th><th>Salary</th><th>Effective</th><th>Status</th></tr></thead><tbody>{q.data.data.map((p) => <tr key={p.id} className="cursor-pointer hover:bg-brand-soft/30" onClick={() => setSel(p.id)}>
          <td className="font-medium">{p.promotionNo}</td><td>{p.employee.name}<div className="text-xs text-muted">{p.employee.employeeNo}</div></td>
          <td className="text-sm">{p.currentTitle ?? '—'}<div className="text-xs text-muted">{p.currentGrade ?? '—'}</div></td><td className="text-sm">{p.newTitle ?? '—'}<div className="text-xs text-muted">{p.newGrade}</div></td>
          <td className="tabular-nums">{fmtMoney(p.currentSalary, p.currency)} → <b>{fmtMoney(p.newSalary, p.currency)}</b><div className="text-xs text-muted">{p.increasePct >= 0 ? '+' : ''}{pct(p.increasePct, 2)}</div></td>
          <td>{fmtDate(p.effectiveDate)}</td><td><WfBadge status={p.status} /></td>
        </tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No promotions" /></div>}
        {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
      <Modal open={pick && !emp} onClose={() => setPick(false)} title="Promote which employee?"><EmployeePicker value={null} onChange={(id) => { if (id) setEmp(id); }} /></Modal>
      {emp && <PromotionModal employeeId={emp} open onClose={() => { setEmp(null); setPick(false); }} onDone={(r) => { setEmp(null); setPick(false); setToast(`${r.promotionNo} — ${humanStatus(r.status)}`); qc.invalidateQueries({ queryKey: ['comp'] }); }} />}
      {sel && <Detail id={sel} onClose={() => setSel(null)} />}
    </>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['comp', 'promotion', id], queryFn: () => api<any>(`/api/v1/compensation/promotions/${id}`) });
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body: any }) => api(`/api/v1/compensation/promotions/${id}/${path}`, { method: 'POST', json: body }), onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['comp'] }); }, onError: (e: any) => setErr(e.message) });
  const p = q.data;
  const pending = p && ['SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED'].includes(p.status);
  return (
    <Modal open onClose={onClose} title={p ? `${p.promotionNo} — ${p.employee.name}` : 'Promotion'} wide>
      {!p ? <TableSkeleton rows={4} /> : <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-3 lg:col-span-3">
          <div className="flex items-center gap-2"><WfBadge status={p.status} />{p.salaryChangeId && <Link className="link text-sm" href={`/compensation/changes/${p.salaryChangeId}`}>Salary change</Link>}<Link className="link text-sm" href={`/compensation/employees/${p.employee.id}`}>Employee</Link></div>
          <KeyValue items={[
            { k: 'Current title / grade', v: `${p.currentTitle ?? '—'} · ${p.currentGrade ?? '—'}` }, { k: 'New title / grade', v: `${p.newTitle ?? '—'} · ${p.newGrade}` },
            { k: 'Current salary', v: fmtMoney(p.currentSalary, p.currency) }, { k: 'New salary', v: `${fmtMoney(p.newSalary, p.currency)} (${p.increasePct >= 0 ? '+' : ''}${pct(p.increasePct, 2)})` },
            { k: 'Recommended by rule', v: `${fmtMoney(p.recommendedSalary, p.currency)} — ${p.ruleExplanation ?? ''}` }, { k: 'Effective date', v: fmtDate(p.effectiveDate) },
            { k: 'Promotion reason', v: p.promotionReason }, { k: 'Performance rating', v: p.performanceRating ? humanStatus(p.performanceRating) : '—' },
            { k: 'Manager recommendation', v: p.managerRecommendation ?? '—' }, { k: 'HR comments', v: p.hrComments ?? '—' }, { k: 'Justification', v: p.justification ?? '—' },
            { k: 'Requested by', v: p.requestedBy ?? '—' }, { k: 'Approved by', v: p.approvedBy ?? '—' },
          ]} />
          <AlertList alerts={p.alerts} />
          {err && <Alert tone="danger">{err}</Alert>}
          <div className="flex flex-wrap gap-2">
            {p.status === 'DRAFT' && can('compensation:propose') && <button className="btn-primary" onClick={() => act.mutate({ path: 'submit', body: {} })}>Submit for approval</button>}
            {pending && can('workflows:act') && <><input className="input min-w-48 flex-1" placeholder="Comment" value={comment} onChange={(e) => setComment(e.target.value)} /><button className="btn-primary" onClick={() => act.mutate({ path: 'approve', body: { decision: 'APPROVED', comment: comment || undefined } })}>Approve</button><button className="btn-danger" disabled={!comment} onClick={() => act.mutate({ path: 'approve', body: { decision: 'REJECTED', comment } })}>Reject</button></>}
            {(p.status === 'DRAFT' || pending) && can('compensation:propose') && <button className="btn-ghost" onClick={() => { const r = window.prompt('Reason for cancelling'); if (r) act.mutate({ path: 'cancel', body: { reason: r } }); }}>Cancel</button>}
          </div>
        </div>
        <div className="lg:col-span-2"><p className="mb-2 text-sm font-semibold">Approval history</p><ApprovalTrail items={p.approvals} /></div>
      </div>}
    </Modal>
  );
}
