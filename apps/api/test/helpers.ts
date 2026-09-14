import { resetEnvCache, getEnv } from '@burtplace/config';
import { buildApp, type App } from '../src/app.js';

export async function testApp(): Promise<App> {
  resetEnvCache();
  const env = getEnv({ NODE_ENV: 'test', AUTH_MODE: 'local', AUTH_LOCAL_JWT_SECRET: process.env.AUTH_LOCAL_JWT_SECRET ?? 'test-secret-0123456789abcdef0123456789abcdef', DATABASE_URL: process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL });
  return buildApp({ env, logger: false, enableQueues: false });
}

export interface Client { get(url: string): Promise<Res>; post(url: string, body?: unknown): Promise<Res>; patch(url: string, body?: unknown): Promise<Res>; put(url: string, body?: unknown): Promise<Res>; del(url: string): Promise<Res> }
export interface Res { status: number; body: any; text: string }

export function client(app: App, headers: Record<string, string>): Client {
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Res> => {
    const res = await app.inject({ method, url, payload: body, headers });
    let parsed: any = undefined;
    try { parsed = res.json(); } catch { parsed = undefined; }
    return { status: res.statusCode, body: parsed, text: res.body };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

export async function login(app: App, email: string, password = 'Password123!'): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/local/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  return client(app, { authorization: `Bearer ${res.json().accessToken}` });
}

export async function gatewayClient(app: App, admin: Client): Promise<Client> {
  const svc = await app.db.selectFrom('users').select('id').where('email', '=', 'svc.device-gateway@burtplace.local').executeTakeFirstOrThrow();
  const key = await admin.post('/api/v1/auth/api-keys', { userId: svc.id, name: `test-${Date.now()}` });
  return client(app, { 'x-api-key': key.body.apiKey });
}

export const punch = (userId: string, deviceCode: string, local: string) => ({ userId, deviceCode, timestamp: `${local}:00+04:00` });
