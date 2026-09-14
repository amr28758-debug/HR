import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Env } from '@burtplace/config';
import { badRequest, unauthorized } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { errorSchema } from '../../lib/pagination.js';

const meSchema = z.object({
  userId: z.string(), displayName: z.string(), email: z.string().nullable(), roles: z.array(z.string()), permissions: z.array(z.string()),
  employeeId: z.string().nullable(), isServiceAccount: z.boolean(), authMethod: z.string(),
});

export const authRoutes: FastifyPluginAsync<{ env: Env }> = async (app, { env }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/me', { schema: { tags: ['auth'], summary: 'Current principal', response: { 200: meSchema, 401: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    return { ...p, permissions: [...p.permissions].sort() };
  });

  r.get('/config', { schema: { tags: ['auth'], summary: 'Public auth configuration for the web client', security: [], response: { 200: z.object({ mode: z.enum(['local', 'entra']), entra: z.object({ tenantId: z.string(), clientId: z.string(), apiAudience: z.string() }).nullable() }) } } }, async () => ({
    mode: env.AUTH_MODE,
    entra: env.AUTH_MODE === 'entra' ? { tenantId: env.ENTRA_TENANT_ID!, clientId: env.ENTRA_CLIENT_ID!, apiAudience: env.ENTRA_API_AUDIENCE! } : null,
  }));

  if (env.AUTH_MODE === 'local') {
    r.post('/local/login', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], summary: 'Local development login (AUTH_MODE=local only)', security: [], body: z.object({ email: z.string().email(), password: z.string().min(1) }), response: { 200: z.object({ accessToken: z.string(), expiresIn: z.number() }), 401: errorSchema } },
    }, async (req) => {
      const user = await app.db.selectFrom('users').select(['id', 'local_password_hash', 'is_active']).where('email', '=', req.body.email.toLowerCase()).executeTakeFirst();
      if (!user || !user.local_password_hash || !user.is_active || !(await bcrypt.compare(req.body.password, user.local_password_hash))) throw unauthorized('Invalid credentials');
      await app.db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
      await app.audit(req, { action: 'auth.login', entityType: 'user', entityId: user.id, metadata: { method: 'local' } });
      return { accessToken: await app.auth.issueLocalToken(user.id), expiresIn: env.AUTH_SESSION_TTL_SECONDS };
    });
  }

  // API keys for service accounts (device gateway / middleware)
  r.post('/api-keys', {
    preHandler: requirePermission('users:write'),
    schema: { tags: ['auth'], summary: 'Create an API key for a service account', body: z.object({ userId: z.string().uuid(), name: z.string().min(1), expiresAt: z.string().datetime().optional() }),
      response: { 201: z.object({ id: z.string(), apiKey: z.string(), keyPrefix: z.string() }) } },
  }, async (req, reply) => {
    const owner = await app.db.selectFrom('users').select(['id', 'is_service_account']).where('id', '=', req.body.userId).executeTakeFirst();
    if (!owner) throw badRequest('userId not found');
    if (!owner.is_service_account) throw badRequest('API keys can only be issued to service accounts');
    const key = `bpw_${randomBytes(32).toString('base64url')}`;
    const row = await app.db.insertInto('api_keys').values({ user_id: owner.id, name: req.body.name, key_prefix: key.slice(0, 12), key_hash: app.auth.hashApiKey(key), expires_at: req.body.expiresAt ?? null, created_by: req.principal!.userId }).returning(['id', 'key_prefix']).executeTakeFirstOrThrow();
    await app.audit(req, { action: 'auth.api_key.create', entityType: 'api_key', entityId: row.id, newValue: { userId: owner.id, name: req.body.name } });
    return reply.status(201).send({ id: row.id, apiKey: key, keyPrefix: row.key_prefix });
  });

  r.delete('/api-keys/:id', { preHandler: requirePermission('users:write'), schema: { tags: ['auth'], summary: 'Revoke an API key', params: z.object({ id: z.string().uuid() }), response: { 204: z.null() } } }, async (req, reply) => {
    await app.db.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'auth.api_key.revoke', entityType: 'api_key', entityId: req.params.id });
    return reply.status(204).send(null);
  });
};
