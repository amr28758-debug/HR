'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FaceAttendance } from '@/components/face/face-attendance';
import { terminalStore, type TerminalRecord } from '@/lib/face-client';

/** Site kiosk: continuous camera on a shared tablet/phone. Requires a paired terminal token stored on the device. */
export default function Page({ params }: { params: Promise<{ siteCode: string }> }) {
  const { siteCode } = use(params);
  const router = useRouter();
  const [terminal, setTerminal] = useState<TerminalRecord | null | undefined>(undefined);
  useEffect(() => { const t = terminalStore.get(); if (!t) { router.replace(`/kiosk/pair?site=${encodeURIComponent(siteCode)}`); return; } setTerminal(t); }, [router, siteCode]);
  if (terminal === undefined) return <div className="flex min-h-screen items-center justify-center bg-[rgb(var(--side))] text-side-muted">…</div>;
  return <FaceAttendance mode="KIOSK" terminal={terminal} siteCode={siteCode.toUpperCase()} />;
}
