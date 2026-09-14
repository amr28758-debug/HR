'use client';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const TOKEN_KEY = 'bpw.token';
export const tokenStore = {
  get: () => (typeof window === 'undefined' ? null : window.sessionStorage.getItem(TOKEN_KEY) ?? window.localStorage.getItem(TOKEN_KEY)),
  set: (t: string, remember = false) => { (remember ? window.localStorage : window.sessionStorage).setItem(TOKEN_KEY, t); },
  clear: () => { window.sessionStorage.removeItem(TOKEN_KEY); window.localStorage.removeItem(TOKEN_KEY); },
};
const BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const token = tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  if (init.raw) return (await res.text()) as T;
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/')) { tokenStore.clear(); window.dispatchEvent(new Event('bpw:unauthorized')); }
    throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return body as T;
}
export const qs = (params: Record<string, unknown>) => { const s = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v)); const q = s.toString(); return q ? `?${q}` : ''; };
export interface Paginated<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }
