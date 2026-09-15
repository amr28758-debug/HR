'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ArrowUpRight, Shuffle, Coins, Gift, MinusCircle, HandCoins, Banknote, FileSignature, GraduationCap, Gavel, LogOut, Ban, ClipboardCheck, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, Field, Modal, cn } from '@/components/ui';
import { fmtMoney } from '@/lib/format';

/** Smart Actions menu: every entry maps to a business-action endpoint; the API decides what is allowed. */
export type ActionDef = { key: string; label: string; requestType: string | null; enabled: boolean; reason: string | null };
const ICONS: Record<string, ReactNode> = { edit: <Pencil size={15} />, promote: <ArrowUpRight size={15} />, transfer: <Shuffle size={15} />, 'salary-change': <Coins size={15} />, bonus: <Gift size={15} />, deduction: <MinusCircle size={15} />, loan: <HandCoins size={15} />, advance: <Banknote size={15} />, 'generate-letter': <FileSignature size={15} />, 'assign-training': <GraduationCap size={15} />, disciplinary: <Gavel size={15} />, resign: <LogOut size={15} />, terminate: <Ban size={15} />, 'start-clearance': <ClipboardCheck size={15} /> };
const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Career', keys: ['promote', 'transfer'] },
  { title: 'Compensation', keys: ['salary-change', 'bonus', 'deduction', 'loan', 'advance'] },
  { title: 'Documents & development', keys: ['generate-letter', 'assign-training'] },
  { title: 'Exit & discipline', keys: ['disciplinary', 'resign', 'terminate', 'start-clearance'] },
];

export function ActionsMenu({ actions, onPick }: { actions: ActionDef[]; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const byKey = new Map(actions.map((a) => [a.key, a]));
  return (
    <div className="relative">
      <button className="btn-primary" onClick={() => setOpen((o) => !o)}>Actions <ChevronDown size={15} className={cn('transition', open && 'rotate-180')} /></button>
      {open && <><div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
        <div className="absolute end-0 z-40 mt-2 w-72 overflow-hidden rounded-2xl border bg-surface p-2 shadow-pop rise">
          {GROUPS.map((g) => { const items = g.keys.map((k) => byKey.get(k)).filter(Boolean) as ActionDef[]; if (!items.length) return null; return (
            <div key={g.title} className="mb-1"><p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">{g.title}</p>
              {items.map((a) => <button key={a.key} disabled={!a.enabled} title={a.reason ?? undefined} onClick={() => { setOpen(false); onPick(a.key); }} className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm transition', a.enabled ? 'hover:bg-brand-soft/60' : 'cursor-not-allowed opacity-40')}><span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', ['terminate', 'disciplinary'].includes(a.key) ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-brand')}>{ICONS[a.key]}</span><span className="flex-1 font-medium">{a.label}</span>{a.requestType && <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">approval</span>}</button>)}
            </div>); })}
        </div></>}
    </div>
  );
}

/** One modal per business action. Submits to POST /employees/:id/<action> and reports the created request. */
export function ActionModal({ employeeId, action, onClose, onDone, gross }: { employeeId: string; action: string | null; onClose: () => void; onDone: (r: any) => void; gross?: number | null }) {
  const [f, setF] = useState<Record<string, any>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setF({}); setErr(null); }, [action]);
  const enabled = !!action;
  const desigs = useQuery({ queryKey: ['org', 'designations'], queryFn: () => api<any[]>('/api/v1/org/designations'), enabled: enabled && ['promote'].includes(action!) });
  const grades = useQuery({ queryKey: ['jobs', 'grades'], queryFn: () => api<any[]>('/api/v1/jobs/grades'), enabled: enabled && ['promote'].includes(action!) });
  const levels = useQuery({ queryKey: ['jobs', 'career-levels'], queryFn: () => api<any[]>('/api/v1/jobs/career-levels'), enabled: enabled && ['promote'].includes(action!) });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => api<any[]>('/api/v1/org/departments'), enabled: enabled && ['promote', 'transfer'].includes(action!) });
  const projects = useQuery({ queryKey: ['org', 'projects'], queryFn: () => api<any[]>('/api/v1/org/projects'), enabled: enabled && action === 'transfer' });
  const sites = useQuery({ queryKey: ['org', 'sites'], queryFn: () => api<any[]>('/api/v1/org/sites'), enabled: enabled && action === 'transfer' });
  const templates = useQuery({ queryKey: ['letters', 'templates'], queryFn: () => api<any[]>('/api/v1/letters/templates'), enabled: enabled && action === 'generate-letter' });
  const courses = useQuery({ queryKey: ['training', 'catalog'], queryFn: () => api<any[]>('/api/v1/people/training/catalog'), enabled: enabled && action === 'assign-training' });
  const lookups = useQuery({ queryKey: ['lookups'], queryFn: () => api<any[]>('/api/v1/jobs/lookups'), enabled: enabled && ['bonus', 'disciplinary', 'terminate', 'resign'].includes(action!) });
  const lk = (cat: string) => lookups.data?.filter((l) => l.category === cat) ?? [];
  const gradeCheck = useQuery({ queryKey: ['grade-check', f.gradeId, f.newBasic], queryFn: () => api<any>(`/api/v1/compensation/grade-check?gradeId=${f.gradeId}&basic=${f.newBasic}`), enabled: action === 'promote' && !!f.gradeId && Number(f.newBasic) > 0 });
  const n = new Date();
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, any> = {};
      for (const [k, v] of Object.entries(f)) if (v !== '' && v !== undefined && v !== null) body[k] = ['newBasic', 'percentage', 'amount', 'principal', 'installments', 'periodYear', 'periodMonth', 'penaltyAmount', 'cost', 'noticePeriodDays', 'recurringMonths'].includes(k) ? Number(v) : v;
      if (action === 'bonus' || action === 'deduction') { body.periodYear ??= n.getFullYear(); body.periodMonth ??= n.getMonth() + 1; }
      return api<any>(`/api/v1/employees/${employeeId}/${action}`, { method: 'POST', json: body });
    },
    onSuccess: (r) => onDone(r), onError: (e: any) => setErr(e.message),
  });
  const set = (k: string) => (e: any) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const inp = (k: string, type = 'text', props: any = {}) => <input type={type} className="input" value={f[k] ?? ''} onChange={set(k)} {...props} />;
  const sel = (k: string, opts: { v: string; l: string }[], placeholder = '— none —') => <select className="input" value={f[k] ?? ''} onChange={set(k)}><option value="">{placeholder}</option>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>;
  const titles: Record<string, string> = { promote: 'Promote employee', transfer: 'Transfer employee', 'salary-change': 'Change salary', bonus: 'Give bonus', deduction: 'Add deduction', loan: 'Loan request', advance: 'Salary advance', 'generate-letter': 'Generate letter', 'assign-training': 'Assign training', disciplinary: 'Disciplinary action', resign: 'Record resignation', terminate: 'Terminate employment', 'start-clearance': 'Start clearance' };
  const period = <div className="grid grid-cols-2 gap-3"><Field label="Payroll year">{inp('periodYear', 'number', { placeholder: String(n.getFullYear()) })}</Field><Field label="Payroll month">{inp('periodMonth', 'number', { min: 1, max: 12, placeholder: String(n.getMonth() + 1) })}</Field></div>;
  const effective = <Field label="Effective date">{inp('effectiveDate', 'date')}</Field>;
  const reason = <Field label="Reason / justification"><textarea className="input min-h-20" value={f.reason ?? ''} onChange={set('reason')} /></Field>;
  return (
    <Modal open={!!action} onClose={onClose} title={action ? titles[action] ?? action : ''} wide={action === 'promote'}>
      {action && <div className="space-y-3">
        {action === 'promote' && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New designation">{sel('designationId', (desigs.data ?? []).map((d) => ({ v: d.id, l: d.title })), 'Keep current')}</Field>
            <Field label="New grade">{sel('gradeId', (grades.data ?? []).map((g) => ({ v: g.id, l: `${g.code} · ${g.name}${g.minSalary ? ` (${fmtMoney(g.minSalary)}–${fmtMoney(g.maxSalary)})` : ''}` })), 'Keep current')}</Field>
            <Field label="Career level">{sel('careerLevelId', (levels.data ?? []).map((l) => ({ v: l.id, l: `${l.code} · ${l.name}` })), 'Keep current')}</Field>
            <Field label="Department">{sel('departmentId', (depts.data ?? []).map((d) => ({ v: d.id, l: d.name })), 'Keep current')}</Field>
            <Field label="New basic salary" hint={gross ? `Current gross ${fmtMoney(gross)}` : undefined}>{inp('newBasic', 'number', { min: 0, step: 50 })}</Field>
            <Field label="or increase all fixed earnings by %">{inp('percentage', 'number', { min: 0, max: 100, step: 0.5 })}</Field>
          </div>
          {gradeCheck.data && <Alert tone={gradeCheck.data.position === 'IN_BAND' ? 'success' : gradeCheck.data.position === 'NO_BAND' ? 'info' : 'warning'}>Grade {gradeCheck.data.grade}: proposed basic is {gradeCheck.data.position.replace('_', ' ').toLowerCase()} (band {fmtMoney(gradeCheck.data.min)} – {fmtMoney(gradeCheck.data.max)}, compa-ratio {gradeCheck.data.compaRatio ?? '—'})</Alert>}
          {effective}{reason}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.issueLetter !== false} onChange={(e) => setF({ ...f, issueLetter: e.target.checked })} />Issue promotion letter automatically on approval</label>
        </>}
        {action === 'transfer' && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project">{sel('projectId', (projects.data ?? []).map((d) => ({ v: d.id, l: `${d.code} · ${d.name}` })), 'Keep current')}</Field>
            <Field label="Site">{sel('siteId', (sites.data ?? []).map((d) => ({ v: d.id, l: d.name })), 'Keep current')}</Field>
            <Field label="Department">{sel('departmentId', (depts.data ?? []).map((d) => ({ v: d.id, l: d.name })), 'Keep current')}</Field>
            <Field label="New manager (employee id)">{inp('managerEmployeeId', 'text', { placeholder: 'uuid — pick from directory' })}</Field>
          </div>
          <Alert tone="info">Shift assignment is re-evaluated from the effective date so the destination site's rules apply.</Alert>
          {effective}{reason}
        </>}
        {action === 'salary-change' && <>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="New basic salary" hint={gross ? `Current gross ${fmtMoney(gross)}` : undefined}>{inp('newBasic', 'number', { min: 0 })}</Field><Field label="or change all fixed earnings by %">{inp('percentage', 'number', { step: 0.5 })}</Field></div>
          {effective}{reason}
        </>}
        {action === 'bonus' && <>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Bonus type">{sel('bonusType', lk('BONUS_TYPE').map((l) => ({ v: l.code, l: l.name })), 'PERFORMANCE')}</Field><Field label="Amount (AED)">{inp('amount', 'number', { min: 0 })}</Field><Field label="or % of basic">{inp('percentage', 'number', { min: 0 })}</Field></div>
          {period}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.isRecurring} onChange={set('isRecurring')} />Recurring</label>
          {f.isRecurring && <Field label="Number of months">{inp('recurringMonths', 'number', { min: 1, max: 36 })}</Field>}
          {reason}
        </>}
        {action === 'deduction' && <>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Component">{sel('componentCode', [{ v: 'PENALTY', l: 'Penalty' }, { v: 'ASSET_DAMAGE', l: 'Asset damage' }, { v: 'ADJ_DED', l: 'Other deduction' }], 'PENALTY')}</Field><Field label="Amount (AED)">{inp('amount', 'number', { min: 0 })}</Field><Field label="Source">{sel('source', [{ v: 'MANUAL', l: 'Manual' }, { v: 'ASSET_DAMAGE', l: 'Asset damage' }, { v: 'DISCIPLINARY', l: 'Disciplinary' }, { v: 'OTHER', l: 'Other' }], 'MANUAL')}</Field></div>
          {period}{reason}
        </>}
        {(action === 'loan' || action === 'advance') && <>
          <div className="grid gap-3 sm:grid-cols-3"><Field label="Amount (AED)">{inp('principal', 'number', { min: 0 })}</Field><Field label="Instalments">{inp('installments', 'number', { min: 1, max: action === 'loan' ? 60 : 12, placeholder: '1' })}</Field><Field label="First deduction period">{inp('startPeriod', 'month')}</Field></div>
          {Number(f.principal) > 0 && Number(f.installments) > 0 && <p className="text-xs text-muted">≈ {fmtMoney(Number(f.principal) / Number(f.installments))} per month</p>}
          {reason}
        </>}
        {action === 'generate-letter' && <>
          <Field label="Template">{sel('templateCode', (templates.data ?? []).map((t) => ({ v: t.code, l: `${t.name}${t.requiresApproval ? ' (needs approval)' : ''}` })), 'Choose…')}</Field>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Language">{sel('language', [{ v: 'en', l: 'English' }, { v: 'ar', l: 'Arabic' }, { v: 'bilingual', l: 'Bilingual' }], 'Template default')}</Field><Field label="Addressee (To whom it may concern…)">{inp('addressee')}</Field></div>
          <Field label="Purpose">{inp('purpose', 'text', { placeholder: 'e.g. Bank loan, visa application' })}</Field>
        </>}
        {action === 'assign-training' && <>
          <Field label="Course">{sel('courseId', (courses.data ?? []).map((c) => ({ v: c.id, l: `${c.code} · ${c.title}${c.isMandatory ? ' (mandatory)' : ''}` })), 'Choose…')}</Field>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Scheduled date">{inp('scheduledDate', 'date')}</Field><Field label="Cost (AED)">{inp('cost', 'number', { min: 0 })}</Field></div>
          {reason}
        </>}
        {action === 'disciplinary' && <>
          <Alert tone="warning">Confidential. Visible only to roles with disciplinary access. Penalties and terminations must follow the company disciplinary policy — REQUIRES HR/LEGAL SIGN-OFF.</Alert>
          <div className="grid gap-3 sm:grid-cols-3"><Field label="Category">{sel('category', lk('DISCIPLINARY_CATEGORY').map((l) => ({ v: l.code, l: l.name })), 'Choose…')}</Field><Field label="Severity">{sel('severity', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((v) => ({ v, l: v })), 'MEDIUM')}</Field><Field label="Incident date">{inp('incidentDate', 'date')}</Field></div>
          <Field label="Summary">{inp('summary')}</Field>
          <Field label="Details"><textarea className="input min-h-20" value={f.details ?? ''} onChange={set('details')} /></Field>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Action">{sel('action', ['VERBAL_WARNING', 'WARNING', 'FINAL_WARNING', 'SUSPENSION', 'PENALTY', 'TERMINATION_RECOMMENDED'].map((v) => ({ v, l: v.replace(/_/g, ' ') })), 'Choose…')}</Field><Field label="Penalty amount (AED, optional)">{inp('penaltyAmount', 'number', { min: 0 })}</Field></div>
        </>}
        {action === 'resign' && <>
          <div className="grid gap-3 sm:grid-cols-3"><Field label="Resignation date">{inp('resignationDate', 'date')}</Field><Field label="Last working date">{inp('lastWorkingDate', 'date')}</Field><Field label="Notice period (days)">{inp('noticePeriodDays', 'number', { min: 0 })}</Field></div>
          <Field label="Exit reason">{sel('exitReason', lk('EXIT_REASON').map((l) => ({ v: l.code, l: l.name })), 'Choose…')}</Field>
          {reason}
          <Alert tone="info">Manager and HR acceptance are required. The clearance checklist starts automatically once accepted.</Alert>
        </>}
        {action === 'terminate' && <>
          <Alert tone="danger">Termination grounds, notice and end-of-service entitlements are governed by UAE Labour Law and company policy — REQUIRES HR/LEGAL SIGN-OFF before approval.</Alert>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Last working date">{inp('lastWorkingDate', 'date')}</Field><Field label="Notice period (days)">{inp('noticePeriodDays', 'number', { min: 0 })}</Field></div>
          <Field label="Exit reason">{sel('exitReason', lk('EXIT_REASON').map((l) => ({ v: l.code, l: l.name })), 'Choose…')}</Field>
          {reason}
        </>}
        {action === 'start-clearance' && <>{reason}<Alert tone="info">Creates the clearance checklist (assets, access, final settlement) and moves the employee to CLEARANCE.</Alert></>}
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="flex justify-end gap-2 pt-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Submitting…' : action === 'generate-letter' || action === 'start-clearance' ? 'Submit' : 'Submit for approval'}</button></div>
      </div>}
    </Modal>
  );
}
