import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getEnv } from '@burtplace/config';
import { requirePermission } from '../../plugins/rbac.js';
import { createBiometricProvider } from '../../integrations/biometric/registry.js';

/** Integration status & capability matrix. Zoho is intentionally absent from core; see /integrations/zoho (removable package). */
export const integrationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/', { preHandler: requirePermission('integrations:read'), schema: { tags: ['integrations'], summary: 'Integration connections', response: { 200: z.array(z.object({ id: z.string(), code: z.string(), provider: z.string(), status: z.string(), config: z.unknown(), lastSuccessAt: z.string().nullable(), lastErrorAt: z.string().nullable(), lastError: z.string().nullable(), cursor: z.unknown().nullable(), openFailures: z.number() })) } } }, async () => {
    const rows = await app.db.selectFrom('integration_connections as c').selectAll('c').select((eb) => eb.selectFrom('integration_failures as f').select(eb.fn.countAll().as('n')).whereRef('f.connection_id', '=', 'c.id').where('f.resolved_at', 'is', null).as('open_failures')).orderBy('c.code').execute();
    return rows.map((c) => ({ id: c.id, code: c.code, provider: c.provider, status: c.status, config: c.config, lastSuccessAt: c.last_success_at ? new Date(c.last_success_at).toISOString() : null, lastErrorAt: c.last_error_at ? new Date(c.last_error_at).toISOString() : null, lastError: c.last_error, cursor: c.cursor, openFailures: Number(c.open_failures ?? 0) }));
  });
  r.get('/biometric/capabilities', { preHandler: requirePermission('integrations:read'), schema: { tags: ['integrations'], summary: 'Active biometric provider capability matrix (OFFICIALLY_DOCUMENTED / VENDOR_SUPPORTED / UNKNOWN / NOT_SUPPORTED)', response: { 200: z.object({ provider: z.string().nullable(), health: z.object({ ok: z.boolean(), message: z.string().optional() }), capabilities: z.record(z.object({ status: z.string(), note: z.string().optional() })) }) } } }, async () => {
    const provider = createBiometricProvider(getEnv());
    if (!provider) return { provider: null, health: { ok: false, message: 'BIOMETRIC_PROVIDER=none' }, capabilities: {} };
    return { provider: provider.code, health: await provider.healthCheck(), capabilities: provider.capabilities() };
  });
  r.get('/logs', { preHandler: requirePermission('integrations:read'), schema: { tags: ['integrations'], summary: 'Recent integration logs & failures', response: { 200: z.object({ logs: z.array(z.object({ id: z.number(), operation: z.string(), direction: z.string(), status: z.string(), durationMs: z.number().nullable(), createdAt: z.string() })), failures: z.array(z.object({ id: z.string(), operation: z.string(), error: z.string(), attempts: z.number(), nextRetryAt: z.string().nullable(), createdAt: z.string() })) }) } } }, async () => {
    const logs = await app.db.selectFrom('integration_logs').selectAll().orderBy('created_at', 'desc').limit(100).execute();
    const failures = await app.db.selectFrom('integration_failures').selectAll().where('resolved_at', 'is', null).orderBy('created_at', 'desc').limit(100).execute();
    return { logs: logs.map((l) => ({ id: Number(l.id), operation: l.operation, direction: l.direction, status: l.status, durationMs: l.duration_ms, createdAt: new Date(l.created_at).toISOString() })), failures: failures.map((f) => ({ id: f.id, operation: f.operation, error: f.error, attempts: f.attempts, nextRetryAt: f.next_retry_at ? new Date(f.next_retry_at).toISOString() : null, createdAt: new Date(f.created_at).toISOString() })) };
  });
};
