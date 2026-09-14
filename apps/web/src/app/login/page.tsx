'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, Fingerprint, Wallet, Sparkles } from 'lucide-react';
import { useAuth, useUi } from '@/lib/providers';
import { Alert, Field } from '@/components/ui';

function LoginForm() {
  const { loginLocal, loginEntra, authMode } = useAuth();
  const { t } = useUi();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next') ?? '/';
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(null); try { await loginLocal(email, password, remember); router.replace(next); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return (
    <div className="w-full max-w-md rise">
      <div className="mb-8"><p className="eyebrow mb-2">{t('welcome')}</p><h1 className="text-3xl font-bold tracking-tight">{t('signIn')}</h1><p className="mt-2 text-sm text-muted">Sign in to manage people, time and pay in one place.</p></div>
      {authMode === 'entra' && <button className="btn-primary mb-4 h-12 w-full" onClick={() => loginEntra().then(() => router.replace(next)).catch((e) => setError(e.message))}><svg width="16" height="16" viewBox="0 0 16 16"><rect x="0" y="0" width="7" height="7" fill="#f25022"/><rect x="9" y="0" width="7" height="7" fill="#7fba00"/><rect x="0" y="9" width="7" height="7" fill="#00a4ef"/><rect x="9" y="9" width="7" height="7" fill="#ffb900"/></svg>{t('signInMicrosoft')}</button>}
      {authMode === 'local' && (
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('email')}><input className="input h-12" type="email" autoComplete="username" placeholder="name@burtplace.ae" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label={t('password')}><input className="input h-12" type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="accent-brand" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t('remember')}</label>
          {error && <Alert tone="danger">{error}</Alert>}
          <button className="btn-primary h-12 w-full text-[15px]" disabled={busy}>{busy ? t('loading') : t('signIn')}</button>
          <div className="rounded-xl border border-dashed bg-surface-2/60 p-3 text-[11px] leading-relaxed text-muted"><b className="text-fg">Development sign-in.</b> Production uses Microsoft Entra ID single sign-on. Seed accounts: admin@ · hr.admin@ · hr.manager@ · payroll@ · finance@ · pm.c31@ · employee@burtplace.local — password <code>Password123!</code></div>
        </form>
      )}
      {!authMode && <p className="text-sm text-muted">{t('loading')}</p>}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-hero p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -end-32 -top-32 h-96 w-96 rounded-full bg-accent/25 blur-3xl" /><div className="pointer-events-none absolute -bottom-40 -start-20 h-[28rem] w-[28rem] rounded-full bg-white/10 blur-3xl" />
        <div className="relative flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent/70 text-base font-extrabold shadow-lg shadow-black/20">BP</div><div><p className="text-lg font-bold leading-tight">Burtplace</p><p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/70">Workforce</p></div></div>
        <div className="relative max-w-lg">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold backdrop-blur"><Sparkles size={14} className="text-accent" /> One platform for people, time and pay</p>
          <h2 className="text-4xl font-bold leading-[1.15] tracking-tight">From the biometric punch to the payslip, automatically.</h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/75">Employees, shifts, attendance, leave, overtime, timesheets and payroll in a single source of truth. Enter data once; the platform calculates the rest.</p>
          <ul className="mt-8 space-y-4 text-sm">{[[Fingerprint, 'Attendance calculated live from Matrix ARGO FACE terminals'], [Wallet, 'Payroll built from timesheets with auditable formulas'], [ShieldCheck, 'Microsoft Entra single sign-on, role-based access, immutable audit trail']].map(([Icon, text]: any) => <li key={text} className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10"><Icon size={17} className="text-accent" /></span><span className="text-white/90">{text}</span></li>)}</ul>
        </div>
        <p className="relative text-xs text-white/50">© Burtplace General Contracting · Internal system</p>
      </section>
      <section className="flex items-center justify-center bg-bg p-6 sm:p-12"><Suspense><LoginForm /></Suspense></section>
    </div>
  );
}
