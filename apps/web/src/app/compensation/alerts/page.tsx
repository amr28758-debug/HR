'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Card, EmptyState, Pagination, TableSkeleton, cn } from '@/components/ui';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { CompPage, SeverityIcon, WfBadge } from '@/components/compensation/common';

const TYPES: Record<string, string> = {
  ABOVE_MAX: '🔴 Above maximum', AT_MAX: 'At maximum', NEAR_MAX: '🟠 Near maximum', BELOW_MIN: '🔵 Below minimum', SALARY_BAND_MISSING: 'Salary band missing', GRADE_MISSING: 'Grade missing', JOB_TITLE_WITHOUT_GRADE: 'Job title without grade',
  NO_SALARY_STRUCTURE: 'No salary structure', DUE_FOR_REVIEW: '🟢 Due for salary review', ANNUAL_INCREASE_RECEIVED: 'Already received annual increase', PROMOTION_BELOW_MIN: 'Promotion below minimum', PROMOTION_ABOVE_MAX: 'Promotion above maximum', SALARY_COMPRESSION: 'Potential salary compression', OUTSIDE_WORKFLOW_CHANGE: 'Changed outside workflow',
};
export default function Page() { return <CompPage title="Compensation alerts" subtitle="Ceiling, band, structure, review and compression alerts. Recomputed daily and on demand; alerts resolve themselves when the condition disappears."><Alerts /></CompPage>; }

function Alerts() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const sp = useSearchParams();
  const [f, setF] = useState({ type: sp.get('type') ?? '', severity: '', status: 'LIVE', page: 1 });
  const q = useQuery({ queryKey: ['comp', 'alerts', f], queryFn: () => api<any>(`/api/v1/compensation/alerts${qs({ ...f, pageSize: 50 })}`) });
  const comp = useQuery({ queryKey: ['comp', 'compression'], queryFn: () => api<any[]>('/api/v1/compensation/compression'), enabled: can('salary:read') && f.type === 'SALARY_COMPRESSION' });
  const scan = useMutation({ mutationFn: () => api<any>('/api/v1/compensation/alerts/scan', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp'] }) });
  const ack = useMutation({ mutationFn: (id: string) => api(`/api/v1/compensation/alerts/${id}/acknowledge`, { method: 'POST', json: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp', 'alerts'] }) });
  const counts = q.data?.counts ?? {};
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">{Object.entries(TYPES).filter(([k]) => counts[k]).map(([k, l]) => <button key={k} onClick={() => setF({ ...f, type: f.type === k ? '' : k, page: 1 })} className={cn('rounded-full border px-3 py-1.5 text-xs font-semibold transition', f.type === k ? 'border-brand bg-brand text-brand-fg' : 'bg-surface hover:border-brand/50')}>{l} <b className="ms-1 tabular-nums">{counts[k]}</b></button>)}
        <span className="ms-auto" />{(can('compensation:propose') || can('compensation:config')) && <button className="btn-secondary btn-sm" disabled={scan.isPending} onClick={() => scan.mutate()}><RefreshCw size={14} className={cn(scan.isPending && 'animate-spin')} /> Scan now</button>}</div>
      {scan.data && <Alert tone="success">Scan complete: {scan.data.open} open · {scan.data.created} new · {scan.data.resolved} resolved.</Alert>}
      {f.type === 'SALARY_COMPRESSION' && comp.data && comp.data.length > 0 && <Card title="Potential salary compression" subtitle="Unusually small (or inverted) differences between hierarchical levels. Salaries are never changed automatically." padded={false}><table className="data"><thead><tr><th>Rule</th><th>Lower level</th><th>Upper level</th><th>Difference</th><th>Why</th></tr></thead><tbody>{comp.data.map((c, i) => <tr key={i}><td>{c.ruleName}</td><td>{c.lower.label}<div className="text-xs text-muted">{fmtMoney(c.lower.value)} · {c.lower.count} emp.</div></td><td>{c.upper.label}<div className="text-xs text-muted">{fmtMoney(c.upper.value)} · {c.upper.count} emp.</div></td><td className={cn('tabular-nums', c.difference < 0 && 'text-danger')}>{fmtMoney(c.difference)}{c.differencePct !== null && ` (${c.differencePct}%)`}</td><td className="text-xs">{c.reasons.join(', ').toLowerCase()}</td></tr>)}</tbody></table></Card>}
      <Card padded={false} title="Alerts" actions={<><select className="input w-36" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value, page: 1 })}><option value="">Any severity</option><option>CRITICAL</option><option>WARNING</option><option>INFO</option></select><select className="input w-36" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="LIVE">Open & acknowledged</option><option value="OPEN">Open</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="RESOLVED">Resolved</option></select></>}>
        {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th /><th>Alert</th><th>Employee</th><th>Detected</th><th>Status</th><th /></tr></thead><tbody>{q.data.data.map((a: any) => <tr key={a.id}>
          <td><SeverityIcon severity={a.severity} /></td><td><p className="font-medium">{a.message}</p><p className="text-xs text-muted">{TYPES[a.type] ?? a.type}</p></td>
          <td>{a.employee ? <Link className="link" href={`/compensation/employees/${a.employee.id}`}>{a.employee.name}</Link> : '—'}</td>
          <td className="text-xs">{fmtDateTime(a.firstDetectedAt)}<div className="text-muted">last {fmtDateTime(a.lastDetectedAt)}</div></td>
          <td><WfBadge status={a.status} />{a.acknowledgedBy && <div className="text-[11px] text-muted">by {a.acknowledgedBy}</div>}</td>
          <td>{a.status === 'OPEN' && (can('compensation:propose') || can('compensation:config')) && <button className="btn-ghost btn-sm" onClick={() => ack.mutate(a.id)}>Acknowledge</button>}</td>
        </tr>)}</tbody></table></div> : <div className="p-5"><EmptyState title="No alerts" hint="Run a scan to evaluate the current workforce." /></div>}
        {q.data && <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>
    </div>
  );
}
