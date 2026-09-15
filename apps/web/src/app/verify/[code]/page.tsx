'use client';
import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { fmtDateTime } from '@/lib/format';

/** Public letter verification page (no login). Linked from the QR code printed on every letter. */
export default function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const q = useQuery({ queryKey: ['verify', code], queryFn: async () => { const r = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1/letters/verify/${encodeURIComponent(code)}`); return r.json(); } });
  const d = q.data;
  return (
    <div className="flex min-h-screen items-center justify-center bg-hero p-6">
      <div className="card w-full max-w-lg p-8 text-center rise">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent/70 text-sm font-extrabold text-white">BP</div>
        <p className="eyebrow">Burtplace General Contracting</p>
        <h1 className="mt-1 text-xl font-bold">Letter verification</h1>
        <p className="mt-1 font-mono text-xs text-muted">{code}</p>
        {q.isLoading ? <p className="mt-6 text-sm text-muted">Checking…</p> : d?.valid ? (
          <div className="mt-6 rounded-2xl border border-success/40 bg-success/5 p-5 text-start">
            <p className="flex items-center gap-2 font-semibold text-success"><ShieldCheck size={18} />This letter was issued by Burtplace HR</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"><dt className="text-muted">Letter no.</dt><dd className="font-mono">{d.letterNo}</dd><dt className="text-muted">Type</dt><dd>{d.letterType}</dd><dt className="text-muted">Employee</dt><dd>{d.employeeName} ({d.employeeNo})</dd><dt className="text-muted">Issued</dt><dd>{fmtDateTime(d.issuedAt)}</dd><dt className="text-muted">Status</dt><dd className={d.status === 'REVOKED' ? 'font-semibold text-danger' : 'font-semibold text-success'}>{d.status}</dd></dl>
            {d.status === 'REVOKED' && <p className="mt-3 text-xs text-danger">This letter has been revoked and is no longer valid.</p>}
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-danger/40 bg-danger/5 p-5"><p className="flex items-center justify-center gap-2 font-semibold text-danger"><ShieldX size={18} />No letter matches this code</p><p className="mt-1 text-xs text-muted">Check the code under the QR and try again, or contact hr@burtplace.ae.</p></div>
        )}
      </div>
    </div>
  );
}
