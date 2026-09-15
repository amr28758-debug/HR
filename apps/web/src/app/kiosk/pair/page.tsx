'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound, ScanFace, Trash2 } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { terminalStore, type TerminalRecord } from '@/lib/face-client';

export default function Page() { return <Suspense><Pair /></Suspense>; }

/**
 * Kiosk pairing: IT registers the terminal in Administration → Face recognition and reads a 6-digit one-time code.
 * Entering it here exchanges it for the terminal token, which lives only in this browser's storage.
 */
function Pair() {
  const router = useRouter();
  const sp = useSearchParams();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<TerminalRecord | null>(null);
  useEffect(() => { setExisting(terminalStore.get()); }, []);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ token: string; terminal: TerminalRecord['terminal'] }>('/api/v1/attendance/mobile/terminals/pair', { method: 'POST', json: { pairingCode: code, userAgent: navigator.userAgent.slice(0, 300) } });
      terminalStore.set({ token: r.token, terminal: r.terminal, pairedAt: new Date().toISOString() });
      router.replace(`/kiosk/${encodeURIComponent(r.terminal.site?.code ?? sp.get('site') ?? 'SITE')}`);
    } catch (e) { setErr(e instanceof ApiError ? (e.status === 401 ? 'Invalid or expired pairing code' : e.message) : 'Network connection required'); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-hero p-6">
      <div className="card w-full max-w-md p-8 rise">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent/70 text-white"><ScanFace size={22} /></div>
        <p className="eyebrow text-center">Burtplace Workforce</p>
        <h1 className="mt-1 text-center text-xl font-bold">Pair attendance kiosk</h1>
        <p className="mt-2 text-center text-sm text-muted">Enter the 6-digit pairing code issued by IT for this device. The code is single-use and expires after 24 hours.</p>
        <input inputMode="numeric" pattern="\d*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="input mt-6 h-14 text-center font-mono text-2xl tracking-[0.5em]" placeholder="••••••" autoFocus />
        {err && <p className="mt-2 text-center text-sm text-danger">{err}</p>}
        <button disabled={code.length !== 6 || busy} onClick={submit} className="btn-primary mt-4 h-12 w-full"><KeyRound size={16} />{busy ? 'Pairing…' : 'Pair device'}</button>
        {existing && (
          <div className="mt-6 rounded-2xl border bg-surface-2 p-4 text-sm">
            <p className="font-semibold">Already paired: {existing.terminal.name}</p>
            <p className="font-mono text-xs text-muted">{existing.terminal.deviceCode}{existing.terminal.site ? ` · ${existing.terminal.site.code}` : ''}</p>
            <div className="mt-3 flex gap-2"><button onClick={() => router.push(`/kiosk/${encodeURIComponent(existing.terminal.site?.code ?? 'SITE')}`)} className="btn-secondary btn-sm">Open kiosk</button><button onClick={() => { terminalStore.clear(); location.reload(); }} className="btn-ghost btn-sm text-danger"><Trash2 size={14} />Forget device</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
