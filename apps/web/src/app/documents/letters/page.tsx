'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, FileSignature, ShieldCheck } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, Tabs, TableSkeleton, cn } from '@/components/ui';
import { fmtDateTime, humanStatus } from '@/lib/format';
import { ActionModal } from '@/components/employee/actions';

export default function Page() { return <AppShell><Letters /></AppShell>; }
type Tab = 'issued' | 'templates' | 'verify';

function Letters() {
  const { can, principal } = useAuth();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('issued');
  const [f, setF] = useState({ status: '', page: 1 });
  const list = useQuery({ queryKey: ['letters', 'list', f], queryFn: () => api<Paginated<any>>(`/api/v1/letters${qs({ ...f, pageSize: 25 })}`) });
  const templates = useQuery({ queryKey: ['letters', 'templates'], queryFn: () => api<any[]>('/api/v1/letters/templates') });
  const [pickEmp, setPickEmp] = useState(sp.get('new') === '1');
  const [empQ, setEmpQ] = useState('');
  const emps = useQuery({ queryKey: ['employees', 'pick', empQ], queryFn: () => api<Paginated<any>>(`/api/v1/employees${qs({ q: empQ, pageSize: 8, working: true })}`), enabled: pickEmp && empQ.length >= 2 && can('letters:generate') });
  const [gen, setGen] = useState<string | null>(null);
  const [tpl, setTpl] = useState<any | null>(null);
  const [code, setCode] = useState('');
  const verify = useQuery({ queryKey: ['verify', code], queryFn: () => api<any>(`/api/v1/letters/verify/${code}`), enabled: code.trim().length >= 6 });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/v1/letters/${id}/revoke`, { method: 'POST', json: { reason: 'Revoked from letters center' } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['letters'] }) });
  const saveTpl = useMutation({ mutationFn: () => api('/api/v1/letters/templates', { method: 'POST', json: { code: tpl.code, name: tpl.name, category: tpl.category, language: tpl.language, subject: tpl.subject || null, bodyEn: tpl.bodyEn || null, bodyAr: tpl.bodyAr || null, requiresApproval: !!tpl.requiresApproval, signatoryName: tpl.signatoryName || null, signatoryTitle: tpl.signatoryTitle || null } }), onSuccess: () => { setTpl(null); qc.invalidateQueries({ queryKey: ['letters', 'templates'] }); } });
  const openHtml = async (id: string) => { const html = await api<string>(`/api/v1/letters/${id}/html`, { raw: true }); const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } };
  const rows = list.data?.data ?? [];
  return (
    <>
      <PageHeader eyebrow="Documents" title="Letters" subtitle="Salary certificates, NOCs, experience letters, promotion & warning letters — generated from versioned templates with a document number and QR verification." actions={<>{(can('letters:generate') || can('letters:read:own')) && <button className="btn-primary" onClick={() => can('letters:generate') ? setPickEmp(true) : setGen(principal?.employeeId ?? null)}><FileSignature size={16} />Generate letter</button>}{can('letters:templates:write') && <button className="btn-secondary" onClick={() => setTpl({ code: '', name: '', category: 'CERTIFICATE', language: 'en', subject: '', bodyEn: '', bodyAr: '', requiresApproval: false, signatoryName: '', signatoryTitle: 'HR Manager' })}><Plus size={15} />Template</button>}</>} />
      <Tabs tabs={[{ key: 'issued', label: 'Issued', count: list.data?.meta.total }, { key: 'templates', label: 'Templates', count: templates.data?.length }, { key: 'verify', label: 'Verify' }]} value={tab} onChange={setTab} />
      {tab === 'issued' && <Card padded={false} actions={<select className="input sm:w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All</option>{['ISSUED', 'REVOKED'].map((s) => <option key={s} value={s}>{humanStatus(s)}</option>)}</select>} title="Issued letters">
        {list.isLoading ? <TableSkeleton /> : rows.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Letter no.</th><th>Employee</th><th>Template</th><th>Language</th><th>Addressee / purpose</th><th>Issued</th><th>Status</th><th></th></tr></thead><tbody>{rows.map((l) => <tr key={l.id}><td className="font-mono text-xs">{l.letterNo}</td><td><Link href={`/employees/${l.employeeId}?tab=letters`} className="font-medium hover:underline">{l.employeeName}</Link><span className="block text-[11px] text-muted">{l.employeeNo}</span></td><td>{l.templateName}</td><td>{l.language}</td><td className="max-w-xs truncate text-xs text-muted">{[l.addressee, l.purpose].filter(Boolean).join(' · ') || '—'}</td><td className="text-xs text-muted">{fmtDateTime(l.issuedAt)}<span className="block">{l.issuedBy}</span></td><td><Badge status={l.status === 'ISSUED' ? 'APPROVED' : 'REJECTED'}>{l.status}</Badge></td><td className="whitespace-nowrap"><button className="btn-ghost btn-sm" onClick={() => openHtml(l.id)}>Open / print</button>{can('letters:generate') && l.status === 'ISSUED' && <button className="btn-ghost btn-sm text-danger" onClick={() => { if (confirm(`Revoke ${l.letterNo}?`)) revoke.mutate(l.id); }}>Revoke</button>}</td></tr>)}</tbody></table></div> : <EmptyState hint="Generate the first letter from an employee profile." />}
        {list.data && <Pagination page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={(p) => setF({ ...f, page: p })} />}
      </Card>}
      {tab === 'templates' && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{templates.data?.map((t) => <div key={t.id} className="card card-hover p-5"><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{t.name}</p><p className="text-[11px] text-muted">{t.code} · v{t.version} · {t.category} · {t.language}</p></div>{t.requiresApproval ? <Badge status="PENDING" dot={false}>Needs approval</Badge> : <Badge status="APPROVED" dot={false}>Instant</Badge>}</div><p className="mt-3 line-clamp-3 text-xs text-muted">{(t.bodyEn ?? t.bodyAr ?? '').replace(/<[^>]+>/g, ' ')}</p><div className="mt-3 flex flex-wrap gap-1">{(t.variables ?? []).slice(0, 6).map((v: string) => <span key={v} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px]">{`{{${v}}}`}</span>)}{(t.variables?.length ?? 0) > 6 && <span className="text-[10px] text-muted">+{t.variables.length - 6}</span>}</div>{can('letters:templates:write') && <button className="btn-ghost btn-sm mt-3" onClick={() => setTpl({ ...t, subject: t.subject ?? '', bodyEn: t.bodyEn ?? '', bodyAr: t.bodyAr ?? '', signatoryName: t.signatoryName ?? '', signatoryTitle: t.signatoryTitle ?? '' })}>New version</button>}</div>)}</div>}
      {tab === 'verify' && <Card title="Verify a letter" subtitle="Enter the verification code printed under the QR code. This check is public — banks and authorities can use /verify/<code>."><div className="max-w-md space-y-3"><input className="input font-mono uppercase" placeholder="e.g. 7K3M-9QZ2" value={code} onChange={(e) => setCode(e.target.value.trim())} />{verify.data && <div className={cn('rounded-2xl border p-4', verify.data.valid ? 'border-success/40 bg-success/5' : 'border-danger/40 bg-danger/5')}><p className="flex items-center gap-2 font-semibold"><ShieldCheck size={16} className={verify.data.valid ? 'text-success' : 'text-danger'} />{verify.data.valid ? 'Valid letter' : 'Not valid'}</p>{verify.data.valid && <p className="mt-1 text-sm text-muted">{verify.data.letterNo} · {verify.data.letterType} · {verify.data.employeeName} ({verify.data.employeeNo}) · issued {fmtDateTime(verify.data.issuedAt)} · {verify.data.status}</p>}</div>}</div></Card>}

      <Modal open={pickEmp} onClose={() => setPickEmp(false)} title="Generate a letter — pick the employee"><div className="space-y-3"><input className="input" autoFocus placeholder="Type a name or employee number…" value={empQ} onChange={(e) => setEmpQ(e.target.value)} />{emps.data?.data.length ? <div className="max-h-64 overflow-y-auto rounded-xl border">{emps.data.data.map((e) => <button key={e.id} className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-brand-soft/60" onClick={() => { setPickEmp(false); setGen(e.id); }}><span>{e.fullNameEn}</span><span className="text-xs text-muted">{e.employeeNo} · {e.designation?.title ?? '—'}</span></button>)}</div> : empQ.length >= 2 ? <p className="text-xs text-muted">No matches.</p> : null}</div></Modal>
      <ActionModal employeeId={gen ?? ''} action={gen ? 'generate-letter' : null} onClose={() => setGen(null)} onDone={(r) => { setGen(null); qc.invalidateQueries({ queryKey: ['letters'] }); if (r.id && r.mode === 'ISSUED') openHtml(r.id); }} />
      <Modal open={!!tpl} onClose={() => setTpl(null)} title={tpl?.id ? `New version of ${tpl.code}` : 'New letter template'} wide>{tpl && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code"><input className="input" disabled={!!tpl.id} value={tpl.code} onChange={(e) => setTpl({ ...tpl, code: e.target.value.toUpperCase().replace(/\s+/g, '_') })} /></Field><Field label="Name"><input className="input" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} /></Field>
        <Field label="Category"><select className="input" value={tpl.category} onChange={(e) => setTpl({ ...tpl, category: e.target.value })}>{['CERTIFICATE', 'HR', 'BANK', 'VISA', 'OFFER', 'DISCIPLINARY', 'OTHER'].map((c) => <option key={c}>{c}</option>)}</select></Field><Field label="Language"><select className="input" value={tpl.language} onChange={(e) => setTpl({ ...tpl, language: e.target.value })}><option value="en">English</option><option value="ar">Arabic</option><option value="bilingual">Bilingual</option></select></Field>
        <Field label="Subject" className="sm:col-span-2"><input className="input" value={tpl.subject} onChange={(e) => setTpl({ ...tpl, subject: e.target.value })} /></Field>
        <Field label="Body (English)" hint="Variables: {{employee.name}}, {{employee.designation}}, {{salary.gross}}, {{letter.addressee}}, {{company.name}} …" className="sm:col-span-2"><textarea className="input min-h-40 font-mono text-xs" dir="ltr" value={tpl.bodyEn} onChange={(e) => setTpl({ ...tpl, bodyEn: e.target.value })} /></Field>
        <Field label="Body (Arabic)" className="sm:col-span-2"><textarea className="input min-h-32 font-mono text-xs" dir="rtl" value={tpl.bodyAr} onChange={(e) => setTpl({ ...tpl, bodyAr: e.target.value })} /></Field>
        <Field label="Signatory name"><input className="input" value={tpl.signatoryName} onChange={(e) => setTpl({ ...tpl, signatoryName: e.target.value })} /></Field><Field label="Signatory title"><input className="input" value={tpl.signatoryTitle} onChange={(e) => setTpl({ ...tpl, signatoryTitle: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!tpl.requiresApproval} onChange={(e) => setTpl({ ...tpl, requiresApproval: e.target.checked })} />Requires HR approval before issue</label>
        <div className="flex justify-end"><button className="btn-primary" disabled={!tpl.code || !tpl.name} onClick={() => saveTpl.mutate()}>Save version</button></div>
        <div className="sm:col-span-2"><Alert tone="info">Letter wording for legal purposes (NOC, experience, salary transfer) REQUIRES HR/LEGAL SIGN-OFF.</Alert></div>
      </div>}</Modal>
    </>
  );
}
