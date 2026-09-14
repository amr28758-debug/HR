'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
    <div className="card w-full max-w-md p-8">
      <div className="mb-6 flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-base font-bold text-brand-fg">BP</div><div><p className="text-lg font-semibold leading-tight">Burtplace Workforce</p><p className="text-xs text-muted">{t('welcome')}</p></div></div>
      {authMode === 'entra' && <button className="btn-primary mb-4 w-full" onClick={() => loginEntra().then(() => router.replace(next)).catch((e) => setError(e.message))}>{t('signInMicrosoft')}</button>}
      {authMode === 'local' && (
        <form onSubmit={submit} className="space-y-4">
          <Alert tone="info">Development sign-in. Production uses Microsoft Entra ID single sign-on.</Alert>
          <Field label={t('email')}><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label={t('password')}><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t('remember')}</label>
          {error && <Alert tone="danger">{error}</Alert>}
          <button className="btn-primary w-full" disabled={busy}>{t('signIn')}</button>
          <p className="text-center text-[11px] text-muted">Seed accounts: admin@ · hr.admin@ · hr.manager@ · payroll@ · finance@ · pm.c31@ · employee@burtplace.local — Password123!</p>
        </form>
      )}
      {!authMode && <p className="text-sm text-muted">{t('loading')}</p>}
    </div>
  );
}
export default function LoginPage() {
  return <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-bg via-bg to-brand-soft/40 p-4"><Suspense><LoginForm /></Suspense></div>;
}
