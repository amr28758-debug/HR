'use client';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, ScanFace, ShieldAlert, ShieldCheck, ShieldOff, Trash2, XCircle, RefreshCw } from 'lucide-react';
import { ApiError, api, qs, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/providers';
import { Alert, Badge, Card, EmptyState, Field, KeyValue, Modal, TableSkeleton, cn } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { analyzeVideo, captureFrame, closeCamera, loadHuman, openCamera, type CameraError, type Human, type LocalFace } from '@/lib/face-client';

/**
 * Employee → Biometric tab. Enrollment is performed by an authorised HR/IT user on their device (employees can never
 * enroll themselves or others). Frames are analysed server-side; only encrypted embeddings are stored and the UI never
 * receives template data — only status, quality metadata and recognition history.
 */
interface Status { employeeId: string; enrolled: boolean; status: string | null; provider: string | null; modelVersion: string | null; sampleCount: number | null; enrolledAt: string | null; enrolledBy: string | null; updatedAt: string | null; disabledAt: string | null; disabledReason: string | null; quality: any; recognitionEnabled: boolean; lastRecognition: { at: string; outcome: string; score: number | null } | null; history: { status: string; enrolledAt: string; deletedAt: string | null; by: string | null }[] }

export function BiometricTab({ id, own }: { id: string; own: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['biometric-status', id], queryFn: () => api<Status>(`/api/v1/biometric/employees/${id}/status`) });
  const ev = useQuery({ queryKey: ['biometric-events', id], queryFn: () => api<Paginated<any>>(`/api/v1/biometric/events${qs({ employeeId: id, pageSize: 15 })}`), enabled: can('biometric:events:read') || own });
  const [modal, setModal] = useState<'enroll' | 'test' | 'disable' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['biometric-status', id] }); qc.invalidateQueries({ queryKey: ['biometric-events', id] }); qc.invalidateQueries({ queryKey: ['timeline', id] }); };
  const disable = useMutation({ mutationFn: () => api(`/api/v1/biometric/employees/${id}/disable`, { method: 'POST', json: { reason } }), onSuccess: () => { setModal(null); setReason(''); refresh(); } });
  const enable = useMutation({ mutationFn: () => api(`/api/v1/biometric/employees/${id}/enable`, { method: 'POST' }), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => api(`/api/v1/biometric/employees/${id}/template${qs({ reason })}`, { method: 'DELETE' }), onSuccess: () => { setModal(null); setReason(''); refresh(); } });
  const canEnroll = can('biometric:enroll') && !own;
  if (st.isLoading) return <TableSkeleton />;
  const s = st.data;
  if (!s) return <Alert tone="danger">{(st.error as Error)?.message ?? 'Unavailable'}</Alert>;
  const tone = s.status === 'ACTIVE' ? 'success' : s.status === 'DISABLED' ? 'warning' : 'muted';
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Face recognition" subtitle="Mobile / kiosk attendance identity" className="lg:col-span-1" actions={<Badge status={s.status ?? 'NOT_ENROLLED'}>{s.status ?? 'Not enrolled'}</Badge>}>
        <div className={cn('flex items-center gap-3 rounded-2xl border p-4', tone === 'success' ? 'border-success/30 bg-success/5' : tone === 'warning' ? 'border-warning/30 bg-warning/5' : 'bg-surface-2')}>
          {s.recognitionEnabled ? <ShieldCheck className="text-success" /> : s.status === 'DISABLED' ? <ShieldOff className="text-warning" /> : <ScanFace className="text-muted" />}
          <div><p className="text-sm font-semibold">{s.recognitionEnabled ? 'Recognition active' : s.enrolled ? 'Enrolled — recognition blocked' : s.status === 'DISABLED' ? 'Recognition disabled' : 'No face template'}</p><p className="text-xs text-muted">{s.recognitionEnabled ? 'This employee can check in with any terminal.' : s.enrolled && !s.recognitionEnabled ? 'Blocked by employee status or global switch.' : s.status === 'DISABLED' ? s.disabledReason ?? '—' : 'Enroll from a live camera (3 angles).'}</p></div>
        </div>
        <div className="mt-4"><KeyValue cols={1} items={[{ k: 'Provider', v: s.provider ? `${s.provider} · ${s.modelVersion}` : null }, { k: 'Samples', v: s.sampleCount }, { k: 'Enrolled', v: s.enrolledAt ? `${fmtDateTime(s.enrolledAt)} by ${s.enrolledBy ?? '—'}` : null }, { k: 'Last recognition', v: s.lastRecognition ? `${s.lastRecognition.outcome} · ${fmtDateTime(s.lastRecognition.at)}${s.lastRecognition.score !== null ? ` · ${s.lastRecognition.score.toFixed(2)}` : ''}` : null }]} /></div>
        <div className="mt-4 flex flex-wrap gap-2">
          {canEnroll && (!s.enrolled || s.status !== 'ACTIVE') && <button className="btn-primary btn-sm" onClick={() => setModal('enroll')}><Camera size={14} />{s.status === 'DISABLED' ? 'Re-enroll' : 'Enroll face'}</button>}
          {canEnroll && s.status === 'ACTIVE' && <button className="btn-secondary btn-sm" onClick={() => setModal('enroll')}><RefreshCw size={14} />Re-enroll</button>}
          {can('biometric:test') && s.status === 'ACTIVE' && <button className="btn-secondary btn-sm" onClick={() => setModal('test')}><ScanFace size={14} />Test recognition</button>}
          {can('biometric:enroll') && s.status === 'ACTIVE' && <button className="btn-secondary btn-sm" onClick={() => setModal('disable')}><ShieldOff size={14} />Disable</button>}
          {can('biometric:enroll') && s.status === 'DISABLED' && <button className="btn-secondary btn-sm" onClick={() => enable.mutate()}><ShieldCheck size={14} />Enable</button>}
          {can('biometric:delete') && s.enrolled && <button className="btn-ghost btn-sm text-danger" onClick={() => setModal('delete')}><Trash2 size={14} />Delete template</button>}
        </div>
        {own && <p className="mt-3 text-[11px] text-muted">Enrollment is done by HR/IT on their device. Your face template is encrypted and is never shown or exported.</p>}
        {s.history.length > 1 && <div className="mt-4 border-t pt-3 text-xs text-muted"><p className="mb-1 font-semibold">History</p>{s.history.map((h, i) => <p key={i}>{h.status} · {fmtDateTime(h.enrolledAt)}{h.deletedAt ? ` → deleted ${fmtDateTime(h.deletedAt)}` : ''} · {h.by ?? '—'}</p>)}</div>}
      </Card>
      <Card title="Recognition events" subtitle="Immutable audit — scores only, never images or templates" className="lg:col-span-2" padded={false}>
        {ev.isLoading ? <TableSkeleton /> : ev.data?.data.length ? <div className="overflow-x-auto"><table className="data"><thead><tr><th>When</th><th>Mode</th><th>Outcome</th><th>Direction</th><th>Device / site</th><th>Match</th><th>Live</th><th>Location</th></tr></thead><tbody>{ev.data.data.map((e: any) => <tr key={e.id}><td className="whitespace-nowrap">{fmtDateTime(e.occurredAt)}</td><td className="text-xs">{e.mode}</td><td><Badge status={e.outcome === 'PUNCHED' || e.outcome === 'MATCHED' ? 'ACTIVE' : e.outcome === 'DUPLICATE' ? 'PENDING' : 'REJECTED'}>{e.outcome}</Badge>{e.reason && <p className="text-[11px] text-muted">{e.reason}</p>}</td><td>{e.direction ?? '—'}</td><td className="text-xs">{e.deviceCode ?? '—'}{e.site ? ` · ${e.site}` : ''}</td><td className="tabular-nums">{e.topScore?.toFixed(2) ?? '—'}</td><td className="tabular-nums">{e.antispoof?.toFixed(2) ?? '—'}/{e.liveness?.toFixed(2) ?? '—'}</td><td className="text-xs">{e.geofence ?? '—'}{e.distanceM !== null && e.distanceM !== undefined ? ` · ${Math.round(e.distanceM)} m` : ''}{e.gpsAccuracyM ? ` (±${e.gpsAccuracyM} m)` : ''}</td></tr>)}</tbody></table></div> : <EmptyState title="No recognition events yet" />}
      </Card>

      {modal === 'enroll' && <EnrollModal id={id} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal === 'test' && <TestModal id={id} onClose={() => setModal(null)} />}
      <Modal open={modal === 'disable'} onClose={() => setModal(null)} title="Disable face recognition"><div className="space-y-3"><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. long leave, security review" /></Field><Alert tone="info">The encrypted template is kept (retention policy applies) but recognition stops immediately on every terminal.</Alert>{disable.error && <Alert tone="danger">{(disable.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn-primary" disabled={!reason || disable.isPending} onClick={() => disable.mutate()}>Disable</button></div></div></Modal>
      <Modal open={modal === 'delete'} onClose={() => setModal(null)} title="Delete biometric template"><div className="space-y-3"><Alert tone="danger"><span className="flex items-start gap-2"><ShieldAlert size={16} className="mt-0.5 shrink-0" /><span>Irreversible: the ciphertext is overwritten and the employee must be re-enrolled from a live camera. The deletion is recorded in the audit trail. Retention/deletion policy <b>REQUIRES HR/LEGAL APPROVAL</b>.</span></span></Alert><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. employee request, exit clearance" /></Field>{del.error && <Alert tone="danger">{(del.error as Error).message}</Alert>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn-danger" disabled={!reason || del.isPending} onClick={() => del.mutate()}>Delete template</button></div></div></Modal>
    </div>
  );
}

const POSES: { key: 'FRONT' | 'LEFT' | 'RIGHT'; label: string; hint: string; yaw: [number, number] }[] = [
  { key: 'FRONT', label: 'Straight', hint: 'Look straight at the camera', yaw: [-0.15, 0.15] },
  { key: 'LEFT', label: 'Slightly left', hint: 'Turn your head slightly to the left', yaw: [0.2, 0.55] },
  { key: 'RIGHT', label: 'Slightly right', hint: 'Turn your head slightly to the right', yaw: [-0.55, -0.2] },
];

/** Live camera with local face gating; captures a frame automatically when the requested pose is held steady. */
function CameraCapture({ poses, onFrames, single }: { poses: typeof POSES; onFrames: (frames: string[]) => void; single?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const humanRef = useRef<Human | null>(null);
  const [status, setStatus] = useState('Starting camera…');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [frames, setFrames] = useState<string[]>([]);
  const [face, setFace] = useState<LocalFace | null>(null);
  const stable = useRef(0);
  const stepRef = useRef(0);
  const framesRef = useRef<string[]>([]);
  const running = useRef(true);
  useEffect(() => {
    running.current = true;
    (async () => {
      const v = videoRef.current; if (!v) return;
      try { await openCamera(v, 'user'); setStatus('Loading models…'); humanRef.current = await loadHuman(setStatus); setStatus(''); } catch (err) {
        const c = (err as Error).message as CameraError;
        setError(c === 'PERMISSION_DENIED' ? 'Camera permission denied — allow camera access and try again.' : c === 'NO_CAMERA' ? 'No camera found.' : c === 'INSECURE_CONTEXT' ? 'HTTPS is required for camera access.' : c === 'IN_USE' ? 'Camera is in use by another application.' : (err as Error).message); return;
      }
      const loop = async () => {
        if (!running.current || !videoRef.current || !humanRef.current) return;
        let f: LocalFace | null = null;
        try { f = await analyzeVideo(humanRef.current, videoRef.current); } catch {}
        setFace(f);
        const pose = poses[stepRef.current];
        if (pose && f) {
          let ok = false;
          if (f.faces === 0) setStatus('No face detected');
          else if (f.faces > 1) setStatus('Only one person in view');
          else if (f.sizePx * Math.min(1, 640 / f.frameW) < 110) setStatus('Move closer');
          else if (f.yaw !== null && (f.yaw < pose.yaw[0] || f.yaw > pose.yaw[1])) setStatus(pose.hint);
          else { ok = true; setStatus('Hold still…'); }
          stable.current = ok ? stable.current + 1 : 0;
          if (ok && stable.current >= 5) {
            const frame = captureFrame(videoRef.current, 800, 0.9);
            framesRef.current = [...framesRef.current, frame]; setFrames(framesRef.current); stable.current = 0;
            if (stepRef.current + 1 >= poses.length) { running.current = false; closeCamera(videoRef.current); onFrames(framesRef.current); return; }
            stepRef.current += 1; setStep(stepRef.current);
          }
        }
        requestAnimationFrame(() => { void loop(); });
      };
      void loop();
    })();
    return () => { running.current = false; closeCamera(videoRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div>
      <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-2xl border-4 border-brand/30 bg-black">
        <video ref={videoRef} className="h-full w-full object-cover [transform:scaleX(-1)]" playsInline muted autoPlay />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className={cn('h-[72%] w-[52%] rounded-[50%] border-2 border-dashed', face && face.faces === 1 ? 'border-accent' : 'border-white/40')} /></div>
        {error ? <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center text-sm text-white">{error}</div> : <div className="absolute inset-x-0 bottom-3 flex justify-center"><span className="rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-white">{status || poses[step]?.hint}</span></div>}
      </div>
      {!single && <ol className="mt-3 flex justify-center gap-2">{poses.map((p, i) => <li key={p.key} className={cn('flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold', i < step || frames.length === poses.length ? 'bg-success/10 text-success' : i === step ? 'bg-brand text-brand-fg' : 'bg-surface-2 text-muted')}>{i < step ? <CheckCircle2 size={12} /> : null}{p.label}</li>)}</ol>}
    </div>
  );
}

function EnrollModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [consent, setConsent] = useState(false);
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api<any>(`/api/v1/biometric/employees/${id}/enroll`, { method: 'POST', json: { frames, consentNote: note || undefined, replace: true } }) });
  return (
    <Modal open onClose={onClose} title="Enroll face template" wide>
      <div className="space-y-4">
        <Alert tone="warning"><span className="flex items-start gap-2"><ShieldAlert size={16} className="mt-0.5 shrink-0" /><span>Capture the employee's face live with this device — never from a photo. Three angles are captured automatically. The consent notice text and retention rules are <b>configurable and REQUIRE HR/LEGAL APPROVAL</b> before go-live.</span></span></Alert>
        {!frames ? <CameraCapture poses={POSES} onFrames={setFrames} /> : (
          <div>
            <div className="grid grid-cols-3 gap-2">{frames.map((f, i) => <img key={i} src={f} alt={POSES[i]?.label} className="aspect-[4/3] w-full rounded-xl object-cover [transform:scaleX(-1)]" />)}</div>
            <p className="mt-2 text-xs text-muted">Frames are sent once for analysis and discarded; only encrypted embeddings are stored.</p>
          </div>
        )}
        {frames && !m.data && (
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />The employee has been informed and consent has been recorded per company policy (reference below).</label>
            <Field label="Consent reference / note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Biometric consent form BF-01 signed 2026-09-15" /></Field>
            {m.error && <Alert tone="danger">{(m.error as ApiError).message}{(m.error as ApiError).details ? <pre className="mt-1 whitespace-pre-wrap text-[11px]">{JSON.stringify((m.error as ApiError).details)}</pre> : null}</Alert>}
            <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setFrames(null)}><RefreshCw size={14} />Retake</button><button className="btn-primary" disabled={!consent || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Analysing…' : 'Enroll'}</button></div>
          </div>
        )}
        {m.data && (
          <div className="space-y-3">
            <Alert tone="success"><span className="flex items-center gap-2"><CheckCircle2 size={16} />Enrolled with {m.data.sampleCount} sample(s) · {m.data.provider} · {m.data.modelVersion}{m.data.consistency !== null ? ` · consistency ${m.data.consistency}` : ''}</span></Alert>
            {m.data.rejectedFrames?.length > 0 && <Alert tone="warning">Rejected frames: {m.data.rejectedFrames.map((r: any) => `#${r.index + 1} ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`).join('; ')}</Alert>}
            <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>Done</button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TestModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const m = useMutation({ mutationFn: (f: string) => api<any>(`/api/v1/biometric/employees/${id}/test`, { method: 'POST', json: { frame: f } }) });
  return (
    <Modal open onClose={onClose} title="Test recognition (no attendance is created)">
      <div className="space-y-4">
        {!frame ? <CameraCapture poses={[{ ...POSES[0]!, yaw: [-0.45, 0.45] }]} single onFrames={(f) => { setFrame(f[0]!); m.mutate(f[0]!); }} /> : (
          <div className="space-y-3">
            {m.isPending && <p className="text-sm text-muted">Analysing…</p>}
            {m.error && <Alert tone="danger">{(m.error as Error).message}</Alert>}
            {m.data && (
              <div className={cn('rounded-2xl border p-4', m.data.identified?.isThisEmployee ? 'border-success/40 bg-success/5' : 'border-danger/40 bg-danger/5')}>
                <p className="flex items-center gap-2 font-semibold">{m.data.identified?.isThisEmployee ? <><CheckCircle2 className="text-success" size={18} />Recognised as this employee</> : <><XCircle className="text-danger" size={18} />{m.data.outcome}{m.data.identified ? ` — top match ${m.data.identified.employeeNo}` : ''}</>}</p>
                <KeyValue cols={3} items={[{ k: 'Verify score', v: m.data.verifyScore?.toFixed(3) ?? '—' }, { k: 'Top similarity', v: m.data.identified?.similarity?.toFixed(3) ?? '—' }, { k: 'Anti-spoof / live', v: `${m.data.antispoof?.toFixed(2) ?? '—'} / ${m.data.liveness?.toFixed(2) ?? '—'}` }]} />
                {m.data.reason && <p className="mt-2 text-xs text-muted">{m.data.reason}</p>}
              </div>
            )}
            <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => { setFrame(null); m.reset(); }}><RefreshCw size={14} />Again</button><button className="btn-primary" onClick={onClose}>Close</button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}
