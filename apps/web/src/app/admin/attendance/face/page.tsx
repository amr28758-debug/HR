'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MapPin, Plus, RotateCcw, ScanFace, ShieldAlert, ShieldOff, Tablet } from 'lucide-react';
import { AppShell } from '@/components/layout/shell';
import { ApiError, api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageHeader, Pagination, TableSkeleton, Tabs, cn } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';

export default function Page() { return <AppShell><FaceAdmin /></AppShell>; }
type Tab = 'settings' | 'terminals' | 'geofences' | 'events';

/** Administration → Attendance → Face recognition: thresholds, liveness, GPS, retention (versioned), kiosks, geofences, audit. */
function FaceAdmin() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>(can('face:config:write') ? 'settings' : can('terminals:manage') ? 'terminals' : 'events');
  return (
    <>
      <PageHeader eyebrow="Administration · Attendance" title="Face recognition attendance" subtitle="Mobile & kiosk face attendance: recognition thresholds, liveness, GPS/geofence policy, terminals and the immutable recognition audit. Every change is versioned." />
      <Tabs tabs={[...(can('face:config:write', 'biometric:read') ? [{ key: 'settings' as Tab, label: 'Settings' }] : []), ...(can('terminals:manage', 'devices:read') ? [{ key: 'terminals' as Tab, label: 'Terminals / kiosks' }] : []), ...(can('org:read') ? [{ key: 'geofences' as Tab, label: 'Geofences' }] : []), ...(can('biometric:events:read') ? [{ key: 'events' as Tab, label: 'Recognition events' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'settings' && <Settings canWrite={can('face:config:write')} />}
      {tab === 'terminals' && <Terminals canWrite={can('terminals:manage')} />}
      {tab === 'geofences' && <Geofences canWrite={can('org:write')} />}
      {tab === 'events' && <Events />}
    </>
  );
}

type FieldDef = { path: string; label: string; kind: 'bool' | 'number' | 'select' | 'text'; hint?: string; options?: string[]; step?: number; legal?: boolean };
const GROUPS: { title: string; subtitle: string; fields: FieldDef[] }[] = [
  { title: 'Feature switches', subtitle: 'Turning a mode off blocks it on every device immediately.', fields: [
    { path: 'enabled', label: 'Mobile face attendance enabled', kind: 'bool' }, { path: 'modes.employeeMobile', label: 'Employee mobile (/attendance)', kind: 'bool' }, { path: 'modes.supervisorMobile', label: 'Supervisor mobile (sequential)', kind: 'bool' }, { path: 'modes.siteKiosk', label: 'Site kiosk (/kiosk/:site)', kind: 'bool' },
  ] },
  { title: 'Recognition thresholds', subtitle: 'Defaults follow the provider recommendation (see "Recommended"). Raising the match threshold reduces false accepts and increases "Face not recognized".', fields: [
    { path: 'thresholds.match', label: 'FACE_MATCH_THRESHOLD (similarity 0–1)', kind: 'number', step: 0.01, hint: 'Provider recommendation 0.50. Top match must reach this to be accepted.' },
    { path: 'thresholds.ambiguityMargin', label: 'Ambiguity margin', kind: 'number', step: 0.01, hint: 'If the 2nd best employee is within this margin → "Unable to confidently identify employee".' },
    { path: 'thresholds.faceQuality', label: 'FACE_QUALITY_THRESHOLD (detector confidence)', kind: 'number', step: 0.01 },
    { path: 'thresholds.minFaceSizePx', label: 'MIN_FACE_SIZE (px in uploaded frame)', kind: 'number', step: 1 },
    { path: 'thresholds.maxYawRad', label: 'Max head yaw for recognition (rad)', kind: 'number', step: 0.01 },
    { path: 'thresholds.enrollMaxYawRad', label: 'Max head yaw for enrollment (rad)', kind: 'number', step: 0.01 },
  ] },
  { title: 'Liveness & anti-spoof', subtitle: 'Passive checks run on the server for every frame; the active challenge (blink / turn / open mouth) runs on the device and is required by the server when enabled.', fields: [
    { path: 'liveness.required', label: 'Liveness required', kind: 'bool' }, { path: 'liveness.activeChallenge', label: 'Active challenge (blink / turn / mouth)', kind: 'bool' }, { path: 'liveness.challengeTimeoutSeconds', label: 'Challenge timeout (s)', kind: 'number', step: 1 },
    { path: 'thresholds.antispoof', label: 'ANTISPOOF_THRESHOLD', kind: 'number', step: 0.01, hint: 'Provider classifier decision point 0.50' }, { path: 'thresholds.liveness', label: 'LIVENESS_THRESHOLD', kind: 'number', step: 0.01, hint: 'Provider classifier decision point 0.50' },
  ] },
  { title: 'GPS & geofence', subtitle: 'Per-site fences are managed in the Geofences tab. Accuracy is added as slack to the fence radius so an honest employee with a poor fix is not rejected.', fields: [
    { path: 'gps.required', label: 'GPS required (mobile modes)', kind: 'bool' }, { path: 'gps.geofenceRequired', label: 'Geofence required', kind: 'bool' }, { path: 'gps.kioskGpsRequired', label: 'GPS required on kiosks', kind: 'bool', hint: 'Kiosks are physically on site; usually off.' },
    { path: 'gps.accuracyLimitM', label: 'GPS_ACCURACY_LIMIT (m)', kind: 'number', step: 5 }, { path: 'gps.maxFixAgeSeconds', label: 'Max fix age (s)', kind: 'number', step: 5 },
    { path: 'behaviour.outsideGeofence', label: 'Outside geofence →', kind: 'select', options: ['REJECT', 'EXCEPTION'] }, { path: 'behaviour.lowAccuracy', label: 'Low accuracy →', kind: 'select', options: ['REJECT', 'EXCEPTION'] }, { path: 'behaviour.suspiciousGps', label: 'Suspicious location (mock / stale / impossible travel) →', kind: 'select', options: ['REJECT', 'EXCEPTION'], hint: 'EXCEPTION records the punch and opens a LOCATION_SUSPICIOUS review item.' },
  ] },
  { title: 'Punch behaviour', subtitle: '', fields: [
    { path: 'duplicateWindowSeconds', label: 'DUPLICATE_WINDOW (s)', kind: 'number', step: 5, hint: 'A second punch inside this window is refused as duplicate.' }, { path: 'ticketTtlSeconds', label: 'Recognition ticket TTL (s)', kind: 'number', step: 5 },
    { path: 'behaviour.lowConfidence', label: 'Low confidence →', kind: 'select', options: ['REJECT', 'EXCEPTION'] }, { path: 'offline.queueEnabled', label: 'Offline queue', kind: 'bool', hint: 'Not available: recognition runs on the server. Kept for a future on-device provider.' },
  ] },
  { title: 'Privacy & retention — REQUIRES HR/LEGAL APPROVAL', subtitle: 'No legal requirement is assumed by the system. Confirm every value here with HR/Legal before go-live.', fields: [
    { path: 'retention.disableOnExit', label: 'Disable recognition when employee is TERMINATED / ARCHIVED', kind: 'bool', legal: true }, { path: 'retention.deleteAfterExitDays', label: 'Delete template N days after exit (blank = manual only)', kind: 'number', step: 1, legal: true },
    { path: 'retention.recognitionEventRetentionDays', label: 'Recognition event retention (days)', kind: 'number', step: 30, legal: true }, { path: 'retention.policyApprovedBy', label: 'Policy approved by (HR/Legal reference)', kind: 'text', legal: true },
    { path: 'privacy.consentNoticeVersion', label: 'Consent notice version', kind: 'text', legal: true }, { path: 'privacy.showPhotoOnKiosk', label: 'Show employee photo on kiosk', kind: 'bool' },
  ] },
];
const getP = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o);
const setP = (o: any, p: string, v: unknown) => { const ks = p.split('.'); const c = structuredClone(o); let cur = c; for (const k of ks.slice(0, -1)) cur = cur[k]; cur[ks[ks.length - 1]!] = v; return c; };

function Settings({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['face-settings'], queryFn: () => api<any>('/api/v1/biometric/settings') });
  const [draft, setDraft] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { if (q.data && !draft) setDraft(q.data.value); }, [q.data, draft]);
  const m = useMutation({ mutationFn: () => api('/api/v1/biometric/settings', { method: 'PUT', json: { value: draft, reason: reason || undefined } }), onSuccess: () => { setReason(''); setDraft(null); qc.invalidateQueries({ queryKey: ['face-settings'] }); } });
  if (q.isLoading || !draft) return <TableSkeleton />;
  const d = q.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(d.value);
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        {GROUPS.map((g) => (
          <Card key={g.title} title={<span className={cn(g.fields.some((f) => f.legal) && 'text-warning')}>{g.title}</span>} subtitle={g.subtitle}>
            <div className="grid gap-4 sm:grid-cols-2">
              {g.fields.map((f) => {
                const v = getP(draft, f.path); const rec = f.path.startsWith('thresholds.') ? getP(d.recommended, f.path.split('.')[1]!) : undefined;
                const hint = [f.hint, rec !== undefined ? `Recommended ${rec}` : null, `Default ${getP(d.defaults, f.path) ?? '—'}`].filter(Boolean).join(' · ');
                if (f.kind === 'bool') return <label key={f.path} className="flex items-start gap-3 rounded-xl border p-3"><input type="checkbox" className="mt-1 h-4 w-4" disabled={!canWrite} checked={!!v} onChange={(e) => setDraft(setP(draft, f.path, e.target.checked))} /><span><span className="block text-sm font-medium">{f.label}</span>{hint && <span className="block text-[11px] text-muted">{hint}</span>}</span></label>;
                if (f.kind === 'select') return <Field key={f.path} label={f.label} hint={hint}><select className="input" disabled={!canWrite} value={v ?? ''} onChange={(e) => setDraft(setP(draft, f.path, e.target.value))}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select></Field>;
                if (f.kind === 'text') return <Field key={f.path} label={f.label} hint={hint}><input className="input" disabled={!canWrite} value={v ?? ''} onChange={(e) => setDraft(setP(draft, f.path, e.target.value || null))} /></Field>;
                return <Field key={f.path} label={f.label} hint={hint}><input type="number" step={f.step} className="input" disabled={!canWrite} value={v ?? ''} onChange={(e) => setDraft(setP(draft, f.path, e.target.value === '' ? null : Number(e.target.value)))} /></Field>;
              })}
            </div>
          </Card>
        ))}
      </div>
      <div className="space-y-4">
        <Card title="Save changes" subtitle={`Version ${d.version} · provider ${d.provider.code} (${d.provider.modelVersion}) · ${d.provider.enrolled} enrolled`}>
          <Alert tone="warning"><span className="flex items-start gap-2"><ShieldAlert size={16} className="mt-0.5 shrink-0" /><span>Thresholds are the balance between false accepts and "not recognized". Change one value at a time and watch the recognition events.</span></span></Alert>
          <Field label="Reason for change" className="mt-3"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} disabled={!canWrite} /></Field>
          {m.error && <div className="mt-2"><Alert tone="danger">{(m.error as ApiError).message}{(m.error as ApiError).details ? <pre className="mt-1 whitespace-pre-wrap text-[11px]">{JSON.stringify((m.error as ApiError).details)}</pre> : null}</Alert></div>}
          <div className="mt-3 flex gap-2"><button className="btn-primary" disabled={!canWrite || !dirty || m.isPending} onClick={() => m.mutate()}>Save as v{d.version + 1}</button><button className="btn-secondary" disabled={!dirty} onClick={() => setDraft(d.value)}><RotateCcw size={14} />Reset</button></div>
        </Card>
        <Card title="History" padded={false}>{d.history.length ? <table className="data"><thead><tr><th>v</th><th>When</th><th>By</th><th>Reason</th></tr></thead><tbody>{d.history.map((h: any) => <tr key={h.version}><td>{h.version}</td><td className="whitespace-nowrap">{fmtDateTime(h.changedAt)}</td><td>{h.changedBy ?? '—'}</td><td className="text-xs">{h.reason ?? '—'}</td></tr>)}</tbody></table> : <EmptyState title="Defaults in use (never saved)" />}</Card>
      </div>
    </div>
  );
}

function Terminals({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/api/v1/biometric/terminals') });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api<any[]>('/api/v1/org/sites') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', siteId: '', terminalType: 'TABLET_KIOSK' });
  const [shown, setShown] = useState<any | null>(null);
  const create = useMutation({ mutationFn: () => api<any>('/api/v1/biometric/terminals', { method: 'POST', json: form }), onSuccess: (t) => { setOpen(false); setShown(t); setForm({ name: '', siteId: '', terminalType: 'TABLET_KIOSK' }); qc.invalidateQueries({ queryKey: ['terminals'] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/v1/biometric/terminals/${id}/revoke`, { method: 'POST', json: { reason: 'Revoked from admin' } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['terminals'] }) });
  const reissue = useMutation({ mutationFn: (id: string) => api<any>(`/api/v1/biometric/terminals/${id}/reissue`, { method: 'POST' }), onSuccess: (t) => { setShown(t); qc.invalidateQueries({ queryKey: ['terminals'] }); } });
  return (
    <>
      <Card title="Attendance terminals" subtitle="A terminal is a shared tablet/phone at a site gate. It authenticates with a device token obtained once from a 6-digit pairing code — no secret lives in the app." padded={false} actions={canWrite && <button className="btn-primary btn-sm" onClick={() => setOpen(true)}><Plus size={14} />Register terminal</button>}>
        {q.isLoading ? <TableSkeleton /> : q.data?.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Terminal</th><th>Device code</th><th>Site</th><th>Type</th><th>Status</th><th>Pairing</th><th>Last seen</th><th></th></tr></thead><tbody>{q.data.map((t: any) => <tr key={t.id}><td className="font-medium">{t.name}</td><td className="font-mono text-xs">{t.deviceCode}</td><td>{t.site ? `${t.site.code} · ${t.site.name}` : '—'}</td><td className="text-xs">{t.terminalType}</td><td><Badge status={t.status} /></td><td className="text-xs">{t.status === 'PENDING' && t.pairingCode ? <span className="font-mono text-base font-bold tracking-widest">{t.pairingCode}</span> : t.pairedAt ? `Paired ${fmtDateTime(t.pairedAt)}` : '—'}{t.status === 'PENDING' && t.pairingExpiresAt && <p className="text-muted">expires {fmtDateTime(t.pairingExpiresAt)}</p>}</td><td className="text-xs">{t.lastSeenAt ? fmtDateTime(t.lastSeenAt) : '—'}</td><td className="whitespace-nowrap">{canWrite && t.status !== 'REVOKED' && <><button className="btn-ghost btn-sm" onClick={() => reissue.mutate(t.id)}><KeyRound size={13} />New code</button><button className="btn-ghost btn-sm text-danger" onClick={() => { if (confirm(`Revoke ${t.name}? Its token stops working immediately.`)) revoke.mutate(t.id); }}><ShieldOff size={13} />Revoke</button></>}</td></tr>)}</tbody></table></div> : <EmptyState title="No terminals registered" hint="Register a tablet or phone as a site kiosk." icon={<Tablet />} />}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Register terminal">
        <div className="space-y-3">
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="C55 main gate tablet" /></Field>
          <Field label="Site"><select className="input" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">Select site…</option>{sites.data?.map((s: any) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></Field>
          <Field label="Type"><select className="input" value={form.terminalType} onChange={(e) => setForm({ ...form, terminalType: e.target.value })}><option value="TABLET_KIOSK">Tablet kiosk</option><option value="MOBILE_KIOSK">Mobile kiosk</option><option value="SUPERVISOR_MOBILE">Supervisor mobile</option></select></Field>
          {create.error && <Alert tone="danger">{(create.error as Error).message}</Alert>}
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={!form.name || !form.siteId || create.isPending} onClick={() => create.mutate()}>Register</button></div>
        </div>
      </Modal>
      <Modal open={!!shown} onClose={() => setShown(null)} title="Pairing code">
        {shown && <div className="space-y-3 text-center"><p className="text-sm text-muted">On the kiosk device open <span className="font-mono">/kiosk/pair</span> and enter this one-time code (valid 24 h):</p><p className="font-mono text-4xl font-extrabold tracking-[0.4em] text-brand">{shown.pairingCode}</p><p className="text-xs text-muted">{shown.name} · {shown.deviceCode}{shown.site ? ` · ${shown.site.code}` : ''}</p><button className="btn-primary" onClick={() => setShown(null)}>Done</button></div>}
      </Modal>
    </>
  );
}

function Geofences({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['geofences'], queryFn: () => api<any[]>('/api/v1/biometric/geofences') });
  const [add, setAdd] = useState<{ siteId: string; name: string; latitude: string; longitude: string; radiusM: string } | null>(null);
  const create = useMutation({ mutationFn: () => api('/api/v1/biometric/geofences', { method: 'POST', json: { siteId: add!.siteId, name: add!.name, latitude: Number(add!.latitude), longitude: Number(add!.longitude), radiusM: Number(add!.radiusM) } }), onSuccess: () => { setAdd(null); qc.invalidateQueries({ queryKey: ['geofences'] }); } });
  const toggle = useMutation({ mutationFn: (f: any) => api(`/api/v1/biometric/geofences/${f.id}`, { method: 'PATCH', json: { isActive: !f.isActive } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['geofences'] }) });
  return (
    <Card title="Site geofences" subtitle="Primary fence = site coordinates + radius (Organization → Sites). Additional fences cover laydown yards, camps or multi-gate sites. GPS accuracy is added as slack." padded={false}>
      {q.isLoading ? <TableSkeleton /> : q.data?.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>Site</th><th>Primary fence</th><th>Additional fences</th><th></th></tr></thead><tbody>{q.data.map((s: any) => <tr key={s.siteId}><td className="font-medium">{s.code} · {s.name}</td><td className="text-xs">{s.latitude !== null ? <span className="font-mono">{s.latitude}, {s.longitude} · r {s.radiusM ?? '—'} m</span> : <span className="text-warning">No coordinates — set in Organization → Sites</span>}</td><td className="text-xs">{s.extra.length ? s.extra.map((f: any) => <p key={f.id} className={cn(!f.isActive && 'line-through text-muted')}><MapPin size={11} className="me-1 inline" />{f.name} · <span className="font-mono">{f.latitude}, {f.longitude}</span> · r {f.radiusM} m{canWrite && <button className="btn-ghost btn-sm ms-2" onClick={() => toggle.mutate(f)}>{f.isActive ? 'Deactivate' : 'Activate'}</button>}</p>) : '—'}</td><td>{canWrite && <button className="btn-ghost btn-sm" onClick={() => setAdd({ siteId: s.siteId, name: '', latitude: String(s.latitude ?? ''), longitude: String(s.longitude ?? ''), radiusM: '150' })}><Plus size={13} />Fence</button>}</td></tr>)}</tbody></table></div> : <EmptyState title="No sites" />}
      <Modal open={!!add} onClose={() => setAdd(null)} title="Add geofence">
        {add && <div className="space-y-3"><Field label="Name"><input className="input" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="Laydown yard / Gate B" /></Field><div className="grid grid-cols-3 gap-3"><Field label="Latitude"><input className="input" value={add.latitude} onChange={(e) => setAdd({ ...add, latitude: e.target.value })} /></Field><Field label="Longitude"><input className="input" value={add.longitude} onChange={(e) => setAdd({ ...add, longitude: e.target.value })} /></Field><Field label="Radius (m)"><input type="number" className="input" value={add.radiusM} onChange={(e) => setAdd({ ...add, radiusM: e.target.value })} /></Field></div>{create.error && <Alert tone="danger">{(create.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setAdd(null)}>Cancel</button><button className="btn-primary" disabled={!add.name || !add.latitude || !add.longitude || create.isPending} onClick={() => create.mutate()}>Add</button></div></div>}
      </Modal>
    </Card>
  );
}

function Events() {
  const [page, setPage] = useState(1);
  const [outcome, setOutcome] = useState('');
  const q = useQuery({ queryKey: ['face-events', page, outcome], queryFn: () => api<Paginated<any>>(`/api/v1/biometric/events${qs({ page, pageSize: 25, outcome: outcome || undefined })}`) });
  return (
    <Card title="Recognition events" subtitle="Immutable log of every recognition attempt and punch — scores and decisions only; no images or templates are ever stored here." padded={false} actions={<select className="input h-8 w-auto text-xs" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}><option value="">All outcomes</option>{['PUNCHED', 'MATCHED', 'NO_MATCH', 'LOW_CONFIDENCE', 'AMBIGUOUS', 'LIVENESS_FAILED', 'NO_FACE', 'MULTIPLE_FACES', 'QUALITY_FAILED', 'REJECTED', 'DUPLICATE'].map((o) => <option key={o}>{o}</option>)}</select>}>
      {q.isLoading ? <TableSkeleton /> : q.data?.data.length ? <><div className="overflow-x-auto"><table className="data"><thead><tr><th>When</th><th>Mode</th><th>Employee</th><th>Outcome</th><th>Dir</th><th>Device / site</th><th>Match</th><th>2nd</th><th>Spoof / live</th><th>Location</th><th>ms</th></tr></thead><tbody>{q.data.data.map((e: any) => <tr key={e.id}><td className="whitespace-nowrap">{fmtDateTime(e.occurredAt)}</td><td className="text-xs">{e.mode}</td><td>{e.employee ? `${e.employee.employeeNo} · ${e.employee.name}` : <span className="text-muted">—</span>}</td><td><Badge status={e.outcome === 'PUNCHED' || e.outcome === 'MATCHED' ? 'ACTIVE' : e.outcome === 'DUPLICATE' ? 'PENDING' : 'REJECTED'}>{e.outcome}</Badge>{e.reason && <p className="max-w-xs truncate text-[11px] text-muted" title={e.reason}>{e.reason}</p>}</td><td>{e.direction ?? '—'}</td><td className="text-xs">{e.deviceCode ?? '—'}{e.site ? ` · ${e.site}` : ''}</td><td className="tabular-nums">{e.topScore?.toFixed(2) ?? '—'}</td><td className="tabular-nums text-muted">{e.secondScore?.toFixed(2) ?? '—'}</td><td className="tabular-nums">{e.antispoof?.toFixed(2) ?? '—'} / {e.liveness?.toFixed(2) ?? '—'}</td><td className="text-xs">{e.geofence ?? '—'}{e.distanceM !== null && e.distanceM !== undefined ? ` · ${Math.round(e.distanceM)} m` : ''}{e.gpsAccuracyM ? ` (±${e.gpsAccuracyM})` : ''}</td><td className="tabular-nums text-xs text-muted">{e.durationMs ?? '—'}</td></tr>)}</tbody></table></div><Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onPage={setPage} /></> : <EmptyState title="No recognition events" icon={<ScanFace />} />}
    </Card>
  );
}
