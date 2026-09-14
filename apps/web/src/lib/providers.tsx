'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, tokenStore } from './api';
import { dict, type Locale, type TKey } from '@/i18n/dictionary';

export interface Principal { userId: string; displayName: string; email: string | null; roles: string[]; permissions: string[]; employeeId: string | null; authMethod: string }
interface AuthCtx { principal: Principal | null; loading: boolean; can: (...perms: string[]) => boolean; loginLocal: (email: string, password: string, remember: boolean) => Promise<void>; loginEntra: () => Promise<void>; logout: () => void; authMode: 'local' | 'entra' | null }
const AuthContext = createContext<AuthCtx | null>(null);
interface UiCtx { locale: Locale; setLocale: (l: Locale) => void; dark: boolean; setDark: (d: boolean) => void; t: (k: TKey) => string; dir: 'ltr' | 'rtl' }
const UiContext = createContext<UiCtx | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: (n, e: any) => (e?.status >= 400 && e?.status < 500 ? false : n < 2) } } }));
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'local' | 'entra' | null>(null);
  const [entraCfg, setEntraCfg] = useState<{ tenantId: string; clientId: string; apiAudience: string } | null>(null);
  const [locale, setLocaleState] = useState<Locale>('en');
  const [dark, setDarkState] = useState(false);

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) { setPrincipal(null); setLoading(false); return; }
    try { setPrincipal(await api<Principal>('/api/v1/auth/me')); } catch { tokenStore.clear(); setPrincipal(null); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    api<{ mode: 'local' | 'entra'; entra: any }>('/api/v1/auth/config').then((c) => { setAuthMode(c.mode); setEntraCfg(c.entra); }).catch(() => setAuthMode('local'));
    void refresh();
    const onUnauthorized = () => setPrincipal(null);
    window.addEventListener('bpw:unauthorized', onUnauthorized);
    try { const l = localStorage.getItem('bpw.locale') as Locale | null; if (l) setLocaleState(l); const d = localStorage.getItem('bpw.dark'); setDarkState(d ? d === '1' : window.matchMedia('(prefers-color-scheme: dark)').matches); } catch {}
    return () => window.removeEventListener('bpw:unauthorized', onUnauthorized);
  }, [refresh]);

  useEffect(() => { document.documentElement.classList.toggle('dark', dark); document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; }, [dark, locale]);
  const setLocale = (l: Locale) => { setLocaleState(l); try { localStorage.setItem('bpw.locale', l); } catch {} };
  const setDark = (d: boolean) => { setDarkState(d); try { localStorage.setItem('bpw.dark', d ? '1' : '0'); } catch {} };

  const loginLocal = async (email: string, password: string, remember: boolean) => {
    const res = await api<{ accessToken: string }>('/api/v1/auth/local/login', { method: 'POST', json: { email, password } });
    tokenStore.set(res.accessToken, remember);
    await refresh();
  };
  const loginEntra = async () => {
    if (!entraCfg) throw new Error('Entra not configured');
    const { PublicClientApplication } = await import('@azure/msal-browser');
    const pca = new PublicClientApplication({ auth: { clientId: entraCfg.clientId, authority: `https://login.microsoftonline.com/${entraCfg.tenantId}`, redirectUri: window.location.origin + '/login' }, cache: { cacheLocation: 'sessionStorage' } });
    await pca.initialize();
    const scope = entraCfg.apiAudience.startsWith('api://') ? `${entraCfg.apiAudience}/.default` : `${entraCfg.apiAudience}/.default`;
    const result = await pca.loginPopup({ scopes: [scope] });
    tokenStore.set(result.accessToken, false);
    await refresh();
  };
  const logout = () => { tokenStore.clear(); setPrincipal(null); qc.clear(); };
  const can = useCallback((...perms: string[]) => !!principal && perms.some((p) => principal.permissions.includes(p)), [principal]);
  const t = useCallback((k: TKey) => dict[locale][k] ?? dict.en[k], [locale]);

  const auth = useMemo<AuthCtx>(() => ({ principal, loading, can, loginLocal, loginEntra, logout, authMode }), [principal, loading, can, authMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const ui = useMemo<UiCtx>(() => ({ locale, setLocale, dark, setDark, t, dir: locale === 'ar' ? 'rtl' : 'ltr' }), [locale, dark, t]); // eslint-disable-line react-hooks/exhaustive-deps
  return <QueryClientProvider client={qc}><AuthContext.Provider value={auth}><UiContext.Provider value={ui}>{children}</UiContext.Provider></AuthContext.Provider></QueryClientProvider>;
}
export const useAuth = () => { const c = useContext(AuthContext); if (!c) throw new Error('useAuth outside Providers'); return c; };
export const useUi = () => { const c = useContext(UiContext); if (!c) throw new Error('useUi outside Providers'); return c; };
