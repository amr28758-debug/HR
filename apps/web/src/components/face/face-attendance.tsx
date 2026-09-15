'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Camera, CheckCircle2, Clock, Languages, LogIn, LogOut, MapPin, Moon, RefreshCw, ScanFace, ShieldAlert, Sun, WifiOff, XCircle, UserRound } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useAuth, useUi } from '@/lib/providers';
import { Avatar, cn } from '@/components/ui';
import { analyzeVideo, captureFrame, challengeSatisfied, closeCamera, loadHuman, openCamera, pickChallenge, terminalStore, watchGps, type CameraError, type Challenge, type GpsError, type GpsFix, type Human, type LocalFace, type TerminalRecord } from '@/lib/face-client';

/**
 * Face attendance terminal — shared by the employee/supervisor mobile page (/attendance) and the site kiosk (/kiosk/:site).
 * The device is a terminal, not an identity: identification is 1:N on the server, the browser only gates frames and runs
 * the active liveness challenge. Nothing here can create a punch without a server-issued recognition ticket.
 */
export type Phase = 'INIT' | 'BLOCKED' | 'READY' | 'DETECTING' | 'LIVENESS' | 'RECAPTURE' | 'IDENTIFYING' | 'LOCATION' | 'CONFIRM' | 'PUNCHING' | 'DONE' | 'FAILED' | 'OFFLINE';
interface Cfg { enabled: boolean; modes: { employeeMobile: boolean; supervisorMobile: boolean; siteKiosk: boolean }; mode: string; provider: string; thresholds: { faceQuality: number; minFaceSizePx: number; maxYawRad: number; antispoof: number; liveness: number }; liveness: { required: boolean; activeChallenge: boolean; challengeTimeoutSeconds: number }; gps: { required: boolean; geofenceRequired: boolean; accuracyLimitM: number }; duplicateWindowSeconds: number; ticketTtlSeconds: number; showPhoto: boolean; terminal: { name: string; deviceCode: string; site: { code: string; name: string } | null } | null; site: { id: string; code: string; name: string } | null; serverTime: string; offline: { queueEnabled: boolean } }
interface Card { id: string; employeeNo: string; name: string; nameAr: string | null; designation: string | null; site: string | null; project: string | null }
interface Recognized { ticket: string | null; expiresAt: string | null; employee: Card | null; suggestedDirection: 'IN' | 'OUT' | null; lastPunch: { at: string; direction: string } | null; geofence: { result: string; distanceM: number | null; fence: string | null }; scores: { match: number | null; antispoof: number | null; liveness: number | null }; outcome: string; reason: string | null }
interface Punched { outcome: string; reason: string | null; punchedAt: string; direction: string; employee: Card; site: string | null; geofence: string; flagged: string[] }

const T = {
  en: {
    title: 'Face attendance', kiosk: 'Site kiosk', employeeMode: 'Employee mobile', supervisorMode: 'Supervisor mode', sequential: 'Sequential check-in (auto-reset)',
    init: 'Preparing camera & models…', ready: 'Ready', readyHint: 'Tap Start, then look at the camera.', start: 'Start', detecting: 'Detecting face', detectingHint: 'Position your face inside the frame.',
    liveness: 'Verifying live person', identifying: 'Identifying employee', location: 'Verifying location', confirm: 'Ready to check in', confirmOut: 'Ready to check out', punching: 'Recording attendance…',
    done: 'Attendance recorded', failed: 'Not recorded', retry: 'Try again', checkIn: 'CHECK IN', checkOut: 'CHECK OUT', notYou: 'Not you? Cancel', cancel: 'Cancel', doneBtn: 'Done', nextPerson: 'Next employee',
    blink: 'Blink your eyes', turn: 'Turn your head to either side', open_mouth: 'Open your mouth', challengePassed: 'Great — look straight at the camera', hold: 'Hold still…', moveCloser: 'Move closer to the camera', lookStraight: 'Look straight at the camera', onePerson: 'One person at a time', noFaceYet: 'No face detected',
    offline: 'Network connection required for attendance verification.', offlineHint: 'Recognition runs on the server; there is no offline mode on this device.',
    camDenied: 'Camera permission is required for face attendance. Allow camera access in your browser settings and reload.', camNone: 'No camera was found on this device.', camInUse: 'The camera is in use by another app.', camInsecure: 'Face attendance requires a secure (HTTPS) connection.', camUnsupported: 'This browser does not support camera access. Use Safari (iOS) or Chrome (Android).',
    gpsLocating: 'Locating…', gpsDenied: 'Location permission denied', gpsUnavailable: 'Location unavailable', gpsOk: 'GPS', gpsNotRequired: 'GPS not required', gpsRequired: 'Location is required for attendance. Enable location services and allow access.',
    disabled: 'Mobile face attendance is currently disabled.', modeDisabled: 'This attendance mode is disabled by configuration.', notPaired: 'This device is not paired as a kiosk.',
    notRecognized: 'Face not recognized', ambiguous: 'Unable to confidently identify employee', liveFail: 'Unable to verify live person', timeout: 'Liveness check timed out — try again', duplicate: 'Attendance already recorded', outside: 'You are outside the site boundary', lowAcc: 'Location accuracy is too low', suspicious: 'Location could not be trusted', terminated: 'Attendance is not allowed for this employee', ticketExpired: 'Session expired — look at the camera again',
    lastPunch: 'Last punch', suggested: 'Suggested', flagged: 'Sent for HR review', autoIn: 'Auto-confirming in', sec: 's', site: 'Site', recordedAt: 'Recorded at', accuracy: 'accuracy', pairKiosk: 'Pair this device',
    steps: ['Face', 'Live person', 'Identify', 'Location', 'Confirm'],
  },
  ar: {
    title: 'الحضور بالوجه', kiosk: 'كشك الموقع', employeeMode: 'جوال الموظف', supervisorMode: 'وضع المشرف', sequential: 'تسجيل متتابع (إعادة تلقائية)',
    init: 'جارٍ تجهيز الكاميرا والنماذج…', ready: 'جاهز', readyHint: 'اضغط ابدأ ثم انظر إلى الكاميرا.', start: 'ابدأ', detecting: 'جارٍ اكتشاف الوجه', detectingHint: 'ضع وجهك داخل الإطار.',
    liveness: 'التحقق من شخص حقيقي', identifying: 'جارٍ التعرف على الموظف', location: 'جارٍ التحقق من الموقع', confirm: 'جاهز لتسجيل الحضور', confirmOut: 'جاهز لتسجيل الانصراف', punching: 'جارٍ تسجيل الحضور…',
    done: 'تم تسجيل الحضور', failed: 'لم يتم التسجيل', retry: 'حاول مرة أخرى', checkIn: 'تسجيل حضور', checkOut: 'تسجيل انصراف', notYou: 'لست أنت؟ إلغاء', cancel: 'إلغاء', doneBtn: 'تم', nextPerson: 'الموظف التالي',
    blink: 'أغمض عينيك', turn: 'أدر رأسك إلى أحد الجانبين', open_mouth: 'افتح فمك', challengePassed: 'ممتاز — انظر مباشرة إلى الكاميرا', hold: 'اثبت…', moveCloser: 'اقترب من الكاميرا', lookStraight: 'انظر مباشرة إلى الكاميرا', onePerson: 'شخص واحد في كل مرة', noFaceYet: 'لم يتم اكتشاف وجه',
    offline: 'يلزم الاتصال بالشبكة للتحقق من الحضور.', offlineHint: 'يعمل التعرف على الخادم؛ لا يوجد وضع دون اتصال على هذا الجهاز.',
    camDenied: 'إذن الكاميرا مطلوب لتسجيل الحضور بالوجه. اسمح بالوصول إلى الكاميرا من إعدادات المتصفح ثم أعد التحميل.', camNone: 'لم يتم العثور على كاميرا في هذا الجهاز.', camInUse: 'الكاميرا مستخدمة من تطبيق آخر.', camInsecure: 'يتطلب الحضور بالوجه اتصالاً آمناً (HTTPS).', camUnsupported: 'هذا المتصفح لا يدعم الوصول إلى الكاميرا. استخدم Safari (iOS) أو Chrome (Android).',
    gpsLocating: 'جارٍ تحديد الموقع…', gpsDenied: 'تم رفض إذن الموقع', gpsUnavailable: 'الموقع غير متاح', gpsOk: 'GPS', gpsNotRequired: 'الموقع غير مطلوب', gpsRequired: 'الموقع مطلوب لتسجيل الحضور. فعّل خدمات الموقع واسمح بالوصول.',
    disabled: 'الحضور بالوجه عبر الجوال معطّل حالياً.', modeDisabled: 'وضع الحضور هذا معطّل في الإعدادات.', notPaired: 'هذا الجهاز غير مقترن ككشك.',
    notRecognized: 'لم يتم التعرف على الوجه', ambiguous: 'تعذّر تحديد الموظف بثقة', liveFail: 'تعذّر التحقق من شخص حقيقي', timeout: 'انتهت مهلة التحقق من الحيوية — حاول مرة أخرى', duplicate: 'تم تسجيل الحضور مسبقاً', outside: 'أنت خارج حدود الموقع', lowAcc: 'دقة الموقع منخفضة جداً', suspicious: 'تعذّر الوثوق بالموقع', terminated: 'غير مسموح بتسجيل الحضور لهذا الموظف', ticketExpired: 'انتهت الجلسة — انظر إلى الكاميرا مرة أخرى',
    lastPunch: 'آخر بصمة', suggested: 'مقترح', flagged: 'أُرسل لمراجعة الموارد البشرية', autoIn: 'تأكيد تلقائي خلال', sec: 'ث', site: 'الموقع', recordedAt: 'سُجّل في', accuracy: 'الدقة', pairKiosk: 'اقتران هذا الجهاز',
    steps: ['الوجه', 'شخص حقيقي', 'التعرف', 'الموقع', 'التأكيد'],
  },
} as const;

export function FaceAttendance({ mode, terminal, siteCode }: { mode: 'EMPLOYEE' | 'KIOSK'; terminal?: TerminalRecord | null; siteCode?: string }) {
  const { locale, setLocale, dark, setDark, dir } = useUi();
  const { principal, can } = useAuth();
  const t = T[locale];
  const kiosk = mode === 'KIOSK';
  const supervisor = !kiosk && can('attendance:read:team', 'attendance:read', 'employees:read:team');
  const [sequential, setSequential] = useState(false);
  const [phase, setPhase] = useState<Phase>('INIT');
  const [blocked, setBlocked] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [hint, setHint] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [gps, setGps] = useState<GpsFix | null>(null);
  const [gpsErr, setGpsErr] = useState<GpsError | null>(null);
  const [rec, setRec] = useState<Recognized | null>(null);
  const [punched, setPunched] = useState<Punched | null>(null);
  const [failure, setFailure] = useState<{ title: string; detail?: string | null } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [now, setNow] = useState<Date | null>(null); // set after mount (avoids SSR/CSR clock mismatch)
  const [faceBox, setFaceBox] = useState<LocalFace | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const humanRef = useRef<Human | null>(null);
  const phaseRef = useRef<Phase>('INIT');
  const gpsRef = useRef<GpsFix | null>(null);
  const cfgRef = useRef<Cfg | null>(null); // callbacks created before the config arrived (kiosk auto-start) read the ref
  const loopRef = useRef<number | null>(null);
  const stableRef = useRef(0);
  const frameRef = useRef<string | null>(null);
  const challengeRef = useRef<{ c: Challenge; started: number; passed: boolean } | null>(null);
  const setP = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);
  const headers = useMemo<Record<string, string>>(() => { const h: Record<string, string> = {}; if (terminal) h['x-terminal-token'] = terminal.token; return h; }, [terminal]);

  useEffect(() => { setNow(new Date()); const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { gpsRef.current = gps; }, [gps]);

  // ---- bootstrap: config → camera → models → GPS
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await api<Cfg>(`/api/v1/attendance/mobile/config${siteCode ? `?siteCode=${encodeURIComponent(siteCode)}` : ''}`, { headers });
        if (cancelled) return;
        setCfg(c); cfgRef.current = c;
        if (!c.enabled) { setBlocked(t.disabled); setP('BLOCKED'); return; }
        if (kiosk && !c.terminal) { setBlocked(t.notPaired); setP('BLOCKED'); return; }
        if ((kiosk && !c.modes.siteKiosk) || (!kiosk && !supervisor && !c.modes.employeeMobile) || (!kiosk && supervisor && !c.modes.supervisorMobile)) { setBlocked(t.modeDisabled); setP('BLOCKED'); return; }
        if (!videoRef.current) return;
        await openCamera(videoRef.current, 'user');
        setHint(t.init);
        humanRef.current = await loadHuman((m) => setHint(m));
        if (cancelled) return;
        setHint('');
        setP('READY');
        if (kiosk) startDetect();
      } catch (err) {
        if (cancelled) return;
        const code = (err as Error).message as CameraError;
        const msg = err instanceof ApiError ? (err.status === 503 ? t.disabled : err.status === 401 ? t.notPaired : err.message) : code === 'PERMISSION_DENIED' ? t.camDenied : code === 'NO_CAMERA' ? t.camNone : code === 'IN_USE' ? t.camInUse : code === 'INSECURE_CONTEXT' ? t.camInsecure : code === 'NO_MEDIA_DEVICES' ? t.camUnsupported : (err as Error).message;
        if (err instanceof TypeError) { setP('OFFLINE'); return; }
        setBlocked(msg); setP('BLOCKED');
      }
    })();
    const stopGps = watchGps((f) => { setGps(f); setGpsErr(null); }, (e) => setGpsErr(e));
    const onOffline = () => setP('OFFLINE');
    const onOnline = () => { if (phaseRef.current === 'OFFLINE') setP('READY'); };
    window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
    return () => { cancelled = true; stopGps(); window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline); if (loopRef.current) cancelAnimationFrame(loopRef.current); closeCamera(videoRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- local detection loop (gating + active challenge)
  const startDetect = useCallback(() => {
    stableRef.current = 0; frameRef.current = null; challengeRef.current = null; setChallenge(null); setRec(null); setPunched(null); setFailure(null); setCountdown(null);
    setP('DETECTING');
    const tick = async () => {
      const v = videoRef.current, h = humanRef.current, cfg = cfgRef.current;
      const ph = phaseRef.current;
      if (!v || !h || !cfg || !['DETECTING', 'LIVENESS', 'RECAPTURE'].includes(ph)) return;
      let face: LocalFace | null = null;
      try { face = await analyzeVideo(h, v); } catch { /* transient GPU hiccup */ }
      if (phaseRef.current !== ph) return;
      setFaceBox(face);
      const th = cfg.thresholds;
      const uploadScale = Math.min(1, 640 / (face?.frameW || 640));
      if (ph === 'LIVENESS') {
        const ch = challengeRef.current!;
        if (Date.now() - ch.started > cfg.liveness.challengeTimeoutSeconds * 1000) { fail(t.timeout); return; }
        if (face && face.faces >= 1 && challengeSatisfied(ch.c, face)) { ch.passed = true; setHint(t.challengePassed); stableRef.current = 0; setP('RECAPTURE'); }
        else setHint(t[ch.c]);
      } else {
        // DETECTING / RECAPTURE: need one stable, frontal, close-enough face
        let ok = false;
        if (!face || face.faces === 0) setHint(t.noFaceYet);
        else if (face.faces > 1) setHint(t.onePerson);
        else if (face.sizePx * uploadScale < th.minFaceSizePx) setHint(t.moveCloser);
        else if (face.yaw !== null && Math.abs(face.yaw) > th.maxYawRad) setHint(t.lookStraight);
        else { ok = true; setHint(t.hold); }
        stableRef.current = ok ? stableRef.current + 1 : 0;
        if (ok && stableRef.current >= 4) {
          frameRef.current = captureFrame(v);
          if (ph === 'DETECTING' && cfg.liveness.required && cfg.liveness.activeChallenge) {
            const c = pickChallenge(); challengeRef.current = { c, started: Date.now(), passed: false }; setChallenge(c); setHint(t[c]); setP('LIVENESS');
          } else { void identifyNow(); return; }
        }
      }
      loopRef.current = requestAnimationFrame(() => { void tick(); });
    };
    loopRef.current = requestAnimationFrame(() => { void tick(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  const fail = useCallback((title: string, detail?: string | null) => { setFailure({ title, detail: detail ?? null }); setP('FAILED'); }, [setP]);

  const identifyNow = useCallback(async () => {
    const cfg = cfgRef.current;
    if (!cfg || !frameRef.current) return;
    setP('IDENTIFYING');
    const gpsRequired = cfg.gps.required;
    // wait briefly for a GPS fix when the site requires it (VERIFYING LOCATION)
    if (gpsRequired && !gpsRef.current && !gpsErr) { setP('LOCATION'); for (let i = 0; i < 40 && !gpsRef.current; i++) await new Promise((r) => setTimeout(r, 250)); setP('IDENTIFYING'); }
    if (gpsRequired && !gpsRef.current) { fail(t.gpsRequired); return; }
    try {
      const r = await api<Recognized>('/api/v1/attendance/mobile/recognize', { method: 'POST', headers, json: { frame: frameRef.current, gps: gpsRef.current, siteCode: siteCode ?? cfg.site?.code, clientSignals: { activeChallengePassed: !!challengeRef.current?.passed, challenge: challengeRef.current?.c, userAgent: navigator.userAgent.slice(0, 300) } } });
      setRec(r);
      if (r.outcome === 'MATCHED' && r.ticket) { setP('CONFIRM'); if (kiosk) setCountdown(4); return; }
      const map: Record<string, string> = { NO_MATCH: t.notRecognized, LOW_CONFIDENCE: t.notRecognized, AMBIGUOUS: t.ambiguous, LIVENESS_FAILED: t.liveFail, DUPLICATE: t.duplicate, NO_FACE: t.noFaceYet, MULTIPLE_FACES: t.onePerson, QUALITY_FAILED: r.reason ?? t.retry };
      const geoMap: Record<string, string> = { OUTSIDE: t.outside, LOW_ACCURACY: t.lowAcc, SUSPICIOUS: t.suspicious, NO_GPS: t.gpsRequired };
      const title = r.outcome === 'REJECTED' ? (geoMap[r.geofence.result] ?? (/terminated|archived|not allowed/i.test(r.reason ?? '') ? t.terminated : r.reason ?? t.failed)) : map[r.outcome] ?? r.reason ?? t.failed;
      fail(title, r.outcome === 'DUPLICATE' && r.lastPunch ? `${t.lastPunch}: ${r.lastPunch.direction} · ${new Date(r.lastPunch.at).toLocaleTimeString(locale === 'ar' ? 'ar-AE' : 'en-GB')}` : r.outcome === 'REJECTED' && r.geofence.distanceM !== null ? `${Math.round(r.geofence.distanceM)} m` : null);
    } catch (err) {
      if (err instanceof ApiError) fail(err.status === 503 ? t.disabled : err.status === 403 ? t.modeDisabled : err.status === 401 ? t.notPaired : err.message);
      else setP('OFFLINE');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers, siteCode, kiosk, locale, gpsErr]);

  const punch = useCallback(async (direction: 'IN' | 'OUT') => {
    if (!rec?.ticket) return;
    setCountdown(null); setP('PUNCHING');
    try {
      const r = await api<Punched>('/api/v1/attendance/mobile/punch', { method: 'POST', headers, json: { ticket: rec.ticket, direction, gps: gpsRef.current } });
      setPunched(r); setP('DONE');
    } catch (err) {
      if (err instanceof ApiError) fail(err.status === 401 ? t.ticketExpired : err.status === 409 ? t.duplicate : err.message);
      else setP('OFFLINE');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, headers, locale]);

  // kiosk auto-confirm countdown + auto-reset after result
  useEffect(() => {
    if (countdown === null || phase !== 'CONFIRM') return;
    if (countdown <= 0) { void punch(rec?.suggestedDirection ?? 'IN'); return; }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown, phase, punch, rec]);
  useEffect(() => {
    if (!(kiosk || sequential)) return;
    if (phase === 'DONE' || phase === 'FAILED') { const id = setTimeout(() => (kiosk ? startDetect() : setP('READY')), phase === 'DONE' ? 3000 : 3500); return () => clearTimeout(id); }
  }, [phase, kiosk, sequential, startDetect, setP]);

  const reset = () => { setCountdown(null); setRec(null); setPunched(null); setFailure(null); setP('READY'); if (kiosk) startDetect(); };
  const stepIndex = phase === 'DETECTING' ? 0 : phase === 'LIVENESS' || phase === 'RECAPTURE' ? 1 : phase === 'IDENTIFYING' ? 2 : phase === 'LOCATION' ? 3 : phase === 'CONFIRM' || phase === 'PUNCHING' ? 4 : phase === 'DONE' ? 5 : -1;
  const statusTitle = { INIT: t.init, BLOCKED: t.failed, READY: t.ready, DETECTING: t.detecting, LIVENESS: t.liveness, RECAPTURE: t.liveness, IDENTIFYING: t.identifying, LOCATION: t.location, CONFIRM: rec?.suggestedDirection === 'OUT' ? t.confirmOut : t.confirm, PUNCHING: t.punching, DONE: t.done, FAILED: failure?.title ?? t.failed, OFFLINE: t.offline }[phase];
  const ringTone = phase === 'DONE' ? 'border-success shadow-[0_0_0_6px_rgb(var(--success)/0.25)]' : phase === 'FAILED' || phase === 'OFFLINE' ? 'border-danger' : phase === 'LIVENESS' ? 'border-accent shadow-[0_0_0_6px_rgb(var(--accent)/0.25)] animate-pulse' : phase === 'CONFIRM' ? 'border-success' : faceBox && faceBox.faces === 1 ? 'border-accent' : 'border-white/30';
  const timeFmt = (d: Date | string) => new Date(d).toLocaleTimeString(locale === 'ar' ? 'ar-AE' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div dir={dir} className="flex min-h-screen flex-col bg-[rgb(var(--side))] text-side-fg">
      {/* header */}
      <header className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent/70 text-sm font-extrabold text-white">BP</div>
          <div><p className="eyebrow">{kiosk ? t.kiosk : supervisor ? t.supervisorMode : t.employeeMode}</p><h1 className="text-base font-bold leading-tight">{cfg?.terminal?.name ?? cfg?.site?.name ?? t.title}</h1></div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="hidden rounded-xl bg-white/10 px-3 py-1.5 font-mono text-sm tabular-nums sm:inline-flex"><Clock size={14} className="me-1.5 mt-0.5" />{now ? timeFmt(now) : '--:--:--'}</span>
          <button onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')} className="rounded-xl bg-white/10 p-2 hover:bg-white/20" aria-label="Language"><Languages size={16} /></button>
          <button onClick={() => setDark(!dark)} className="rounded-xl bg-white/10 p-2 hover:bg-white/20" aria-label="Theme">{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center px-4 pb-6">
        {/* steps */}
        <ol className="mb-4 flex w-full items-center justify-between gap-1 text-[10px] font-semibold uppercase tracking-wider text-side-muted">
          {t.steps.map((s, i) => <li key={s} className={cn('flex flex-1 flex-col items-center gap-1', i < stepIndex && 'text-success', i === stepIndex && 'text-accent')}><span className={cn('h-1.5 w-full rounded-full bg-white/10', i < stepIndex && 'bg-success', i === stepIndex && 'bg-accent')} />{s}</li>)}
        </ol>

        {/* camera */}
        <div className={cn('relative aspect-[3/4] w-full overflow-hidden rounded-[2rem] border-4 bg-black transition-all duration-300', ringTone)}>
          <video ref={videoRef} className="h-full w-full object-cover [transform:scaleX(-1)]" playsInline muted autoPlay />
          {/* face guide */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className={cn('h-[62%] w-[70%] rounded-[50%] border-2 border-dashed transition-colors', faceBox && faceBox.faces === 1 ? 'border-accent/90' : 'border-white/40')} /></div>
          {faceBox && faceBox.faces >= 1 && ['DETECTING', 'LIVENESS', 'RECAPTURE'].includes(phase) && <div className="pointer-events-none absolute rounded-xl border-2 border-accent/80" style={{ left: `${(1 - (faceBox.box.x + faceBox.box.width) / faceBox.frameW) * 100}%`, top: `${(faceBox.box.y / faceBox.frameH) * 100}%`, width: `${(faceBox.box.width / faceBox.frameW) * 100}%`, height: `${(faceBox.box.height / faceBox.frameH) * 100}%` }} />}
          {/* overlays */}
          {(phase === 'INIT' || phase === 'BLOCKED' || phase === 'OFFLINE') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-center">
              {phase === 'OFFLINE' ? <WifiOff size={40} className="text-danger" /> : phase === 'BLOCKED' ? <ShieldAlert size={40} className="text-danger" /> : <ScanFace size={40} className="animate-pulse text-accent" />}
              <p className="text-base font-semibold">{phase === 'OFFLINE' ? t.offline : phase === 'BLOCKED' ? blocked : hint || t.init}</p>
              {phase === 'OFFLINE' && <p className="text-xs text-side-muted">{t.offlineHint}</p>}
              {phase === 'BLOCKED' && kiosk && blocked === t.notPaired && <Link href="/kiosk/pair" className="btn-accent">{t.pairKiosk}</Link>}
              {phase === 'OFFLINE' && <button onClick={() => setP('READY')} className="btn-secondary"><RefreshCw size={15} />{t.retry}</button>}
            </div>
          )}
          {phase === 'READY' && !kiosk && (
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-gradient-to-t from-black/80 to-transparent p-6">
              <p className="text-sm text-white/80">{t.readyHint}</p>
              <button onClick={startDetect} className="btn-accent h-12 w-full max-w-xs text-base"><Camera size={18} />{t.start}</button>
            </div>
          )}
          {['DETECTING', 'LIVENESS', 'RECAPTURE'].includes(phase) && <div className="absolute inset-x-0 bottom-4 flex justify-center"><span className={cn('rounded-full px-4 py-2 text-sm font-semibold backdrop-blur', phase === 'LIVENESS' ? 'bg-accent text-white' : 'bg-black/60 text-white')}>{hint}</span></div>}
          {(phase === 'IDENTIFYING' || phase === 'LOCATION' || phase === 'PUNCHING') && <div className="absolute inset-0 flex items-center justify-center bg-black/50"><div className="flex items-center gap-3 rounded-2xl bg-black/70 px-5 py-3 text-sm font-semibold"><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-accent" />{statusTitle}</div></div>}
          {phase === 'DONE' && punched && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-success/90 p-6 text-center text-white rise">
              <CheckCircle2 size={56} />
              <p className="text-2xl font-extrabold">{punched.direction === 'IN' ? t.checkIn : t.checkOut}</p>
              <p className="text-lg font-semibold">{locale === 'ar' && punched.employee.nameAr ? punched.employee.nameAr : punched.employee.name}</p>
              <p className="font-mono text-sm opacity-90">{punched.employee.employeeNo} · {timeFmt(punched.punchedAt)}</p>
              {punched.flagged.length > 0 && <p className="mt-1 rounded-full bg-white/20 px-3 py-1 text-xs">{t.flagged}: {punched.flagged.join(', ')}</p>}
            </div>
          )}
          {phase === 'FAILED' && failure && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 p-6 text-center">
              <XCircle size={48} className="text-danger" />
              <p className="text-lg font-bold">{failure.title}</p>
              {failure.detail && <p className="text-sm text-side-muted">{failure.detail}</p>}
              {!kiosk && <button onClick={reset} className="btn-secondary mt-2"><RefreshCw size={15} />{t.retry}</button>}
            </div>
          )}
        </div>

        {/* status line + GPS */}
        <div className="mt-3 flex w-full items-center justify-between gap-2 text-xs text-side-muted">
          <span className="font-semibold uppercase tracking-wider">{statusTitle}</span>
          {cfg?.gps.required ? <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1', gps ? (gps.accuracyM <= (cfg?.gps.accuracyLimitM ?? 100) ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning') : gpsErr ? 'bg-danger/20 text-danger' : 'bg-white/10')}><MapPin size={12} />{gps ? `${t.gpsOk} ±${gps.accuracyM} m` : gpsErr === 'PERMISSION_DENIED' ? t.gpsDenied : gpsErr ? t.gpsUnavailable : t.gpsLocating}</span>
            : <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1"><MapPin size={12} />{gps ? `${t.gpsOk} ±${gps.accuracyM} m` : t.gpsNotRequired}</span>}
        </div>

        {/* confirm card */}
        {phase === 'CONFIRM' && rec?.employee && (
          <div className="mt-4 w-full rounded-3xl bg-surface p-5 text-fg shadow-pop rise">
            <div className="flex items-center gap-3">
              <Avatar name={rec.employee.name} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-bold">{locale === 'ar' && rec.employee.nameAr ? rec.employee.nameAr : rec.employee.name}</p>
                <p className="font-mono text-xs text-muted">{rec.employee.employeeNo}{!kiosk && rec.employee.designation ? ` · ${rec.employee.designation}` : ''}</p>
                {!kiosk && (rec.employee.site || rec.employee.project) && <p className="truncate text-xs text-muted">{[rec.employee.project, rec.employee.site].filter(Boolean).join(' · ')}</p>}
              </div>
              <UserRound size={18} className="text-muted" />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
              {rec.lastPunch && <span className="rounded-full bg-surface-2 px-2.5 py-1">{t.lastPunch}: {rec.lastPunch.direction} {timeFmt(rec.lastPunch.at)}</span>}
              <span className={cn('rounded-full px-2.5 py-1', rec.geofence.result === 'INSIDE' ? 'bg-success/15 text-success' : rec.geofence.result === 'NOT_REQUIRED' || rec.geofence.result === 'NO_FENCE' ? 'bg-surface-2' : 'bg-warning/15 text-warning')}><MapPin size={11} className="me-1 inline" />{rec.geofence.result}{rec.geofence.distanceM !== null ? ` · ${Math.round(rec.geofence.distanceM)} m` : ''}</span>
              {countdown !== null && <span className="ms-auto rounded-full bg-accent/15 px-2.5 py-1 font-semibold text-accent">{t.autoIn} {countdown}{t.sec}</span>}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button onClick={() => punch('IN')} className={cn('btn h-14 text-base', rec.suggestedDirection === 'IN' ? 'bg-success text-white shadow-lift' : 'border bg-surface text-fg hover:bg-surface-2')}><LogIn size={18} />{t.checkIn}</button>
              <button onClick={() => punch('OUT')} className={cn('btn h-14 text-base', rec.suggestedDirection === 'OUT' ? 'bg-brand text-brand-fg shadow-lift' : 'border bg-surface text-fg hover:bg-surface-2')}><LogOut size={18} />{t.checkOut}</button>
            </div>
            <button onClick={reset} className="btn-ghost mt-2 w-full text-xs">{t.notYou}</button>
          </div>
        )}
        {phase === 'DONE' && !kiosk && !sequential && punched && (
          <div className="mt-4 w-full rounded-3xl bg-surface p-5 text-fg shadow-pop">
            <div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted">{t.recordedAt}</p><p className="font-semibold">{timeFmt(punched.punchedAt)}</p></div><div><p className="text-xs text-muted">{t.site}</p><p className="font-semibold">{punched.site ?? '—'}</p></div></div>
            <button onClick={reset} className="btn-primary mt-4 w-full">{t.doneBtn}</button>
          </div>
        )}
        {supervisor && phase === 'READY' && (
          <label className="mt-4 flex items-center gap-2 text-xs text-side-muted"><input type="checkbox" checked={sequential} onChange={(e) => setSequential(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />{t.sequential}</label>
        )}
        {!kiosk && principal && <p className="mt-3 text-[11px] text-side-muted">{principal.displayName} · {supervisor ? t.supervisorMode : t.employeeMode}</p>}
        {kiosk && cfg?.terminal && <p className="mt-3 font-mono text-[11px] text-side-muted">{cfg.terminal.deviceCode}{cfg.terminal.site ? ` · ${cfg.terminal.site.code}` : ''}</p>}
      </main>
    </div>
  );
}

export { terminalStore };
