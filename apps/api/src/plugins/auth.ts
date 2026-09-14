import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { Env } from '@burtplace/config';
import { unauthorized } from './errors.js';

export interface Principal {
  userId: string;
  displayName: string;
  email: string | null;
  roles: string[];
  permissions: Set<string>;
  employeeId: string | null;
  isServiceAccount: boolean;
  authMethod: 'local-jwt' | 'entra' | 'api-key';
}

declare module 'fastify' {
  interface FastifyRequest { principal: Principal | null }
  interface FastifyInstance {
    auth: {
      issueLocalToken(userId: string): Promise<string>;
      loadPrincipal(userId: string, method: Principal['authMethod']): Promise<Principal | null>;
      hashApiKey(key: string): string;
    };
  }
}

/**
 * Authentication:
 *  - Bearer <JWT>: AUTH_MODE=local → HS256 signed by AUTH_LOCAL_JWT_SECRET; AUTH_MODE=entra → RS256 validated against tenant JWKS (issuer + audience checked).
 *  - X-API-Key: service accounts (device gateway). Keys stored as sha256(pepper + key).
 * Users are provisioned/linked in the users table. Entra users are matched by oid (entra_object_id), then by UPN/email (first login links).
 */
export default fp(async function authPlugin(app: FastifyInstance, opts: { env: Env }) {
  const { env } = opts;
  const localSecret = env.AUTH_LOCAL_JWT_SECRET ? new TextEncoder().encode(env.AUTH_LOCAL_JWT_SECRET) : null;
  const jwks = env.AUTH_MODE === 'entra' ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`)) : null;

  async function loadPrincipal(userId: string, method: Principal['authMethod']): Promise<Principal | null> {
    const user = await app.db.selectFrom('users').select(['id', 'display_name', 'email', 'is_active', 'is_service_account', 'deleted_at']).where('id', '=', userId).executeTakeFirst();
    if (!user || !user.is_active || user.deleted_at) return null;
    const roles = await app.db.selectFrom('user_roles').innerJoin('roles', 'roles.id', 'user_roles.role_id').select('roles.code').where('user_roles.user_id', '=', userId).execute();
    const perms = await app.db.selectFrom('user_roles').innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id').innerJoin('permissions', 'permissions.id', 'role_permissions.permission_id')
      .select('permissions.code').where('user_roles.user_id', '=', userId).execute();
    const emp = await app.db.selectFrom('employees').select('id').where('user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst();
    return { userId, displayName: user.display_name, email: user.email, roles: roles.map((r) => r.code), permissions: new Set(perms.map((p) => p.code)), employeeId: emp?.id ?? null, isServiceAccount: user.is_service_account, authMethod: method };
  }

  async function issueLocalToken(userId: string): Promise<string> {
    if (!localSecret) throw new Error('local auth not configured');
    return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer('burtplace-workforce').setAudience('burtplace-api').setIssuedAt().setExpirationTime(`${env.AUTH_SESSION_TTL_SECONDS}s`).sign(localSecret);
  }

  function hashApiKey(key: string): string {
    return createHash('sha256').update(env.API_KEY_PEPPER + key).digest('hex');
  }

  async function resolveEntraUser(payload: JWTPayload): Promise<string | null> {
    const oid = typeof payload.oid === 'string' ? payload.oid : null;
    const upn = (typeof payload.preferred_username === 'string' ? payload.preferred_username : typeof payload.upn === 'string' ? payload.upn : null)?.toLowerCase() ?? null;
    if (oid) {
      const byOid = await app.db.selectFrom('users').select('id').where('entra_object_id', '=', oid).executeTakeFirst();
      if (byOid) return byOid.id;
    }
    if (upn) {
      const byUpn = await app.db.selectFrom('users').select('id').where((eb) => eb.or([eb('entra_upn', '=', upn), eb('email', '=', upn)])).executeTakeFirst();
      if (byUpn) {
        if (oid) await app.db.updateTable('users').set({ entra_object_id: oid, entra_upn: upn, last_login_at: new Date() }).where('id', '=', byUpn.id).execute();
        return byUpn.id;
      }
    }
    // Unknown Entra user: auto-provision with EMPLOYEE role only if an employee record with this work email exists.
    if (upn) {
      const emp = await app.db.selectFrom('employees').select(['id', 'full_name_en']).where('work_email', '=', upn).where('user_id', 'is', null).executeTakeFirst();
      if (emp) {
        const created = await app.db.insertInto('users').values({ email: upn, display_name: emp.full_name_en, entra_object_id: oid, entra_upn: upn }).returning('id').executeTakeFirstOrThrow();
        await app.db.insertInto('user_roles').columns(['user_id', 'role_id']).expression((eb) => eb.selectFrom('roles').select([eb.val(created.id).as('user_id'), 'roles.id']).where('roles.code', '=', 'EMPLOYEE')).execute();
        await app.db.updateTable('employees').set({ user_id: created.id }).where('id', '=', emp.id).execute();
        return created.id;
      }
    }
    return null;
  }

  app.decorate('auth', { issueLocalToken, loadPrincipal, hashApiKey });
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.principal = null;
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      const row = await app.db.selectFrom('api_keys').select(['id', 'user_id', 'expires_at', 'revoked_at']).where('key_hash', '=', hashApiKey(apiKey)).executeTakeFirst();
      if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) < new Date())) throw unauthorized('Invalid API key');
      req.principal = await loadPrincipal(row.user_id, 'api-key');
      if (!req.principal) throw unauthorized('API key owner is inactive');
      void app.db.updateTable('api_keys').set({ last_used_at: new Date() }).where('id', '=', row.id).execute().catch(() => {});
      return;
    }
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const token = header.slice(7);
    try {
      if (env.AUTH_MODE === 'local') {
        const { payload } = await jwtVerify(token, localSecret!, { issuer: 'burtplace-workforce', audience: 'burtplace-api' });
        req.principal = await loadPrincipal(payload.sub!, 'local-jwt');
      } else {
        const { payload } = await jwtVerify(token, jwks!, {
          issuer: [`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`, `https://sts.windows.net/${env.ENTRA_TENANT_ID}/`],
          audience: env.ENTRA_API_AUDIENCE!,
        });
        const userId = await resolveEntraUser(payload);
        req.principal = userId ? await loadPrincipal(userId, 'entra') : null;
      }
    } catch (e) {
      req.log.debug({ err: e }, 'token rejected');
      throw unauthorized('Invalid or expired token');
    }
    if (!req.principal) throw unauthorized('User not provisioned or inactive');
  });
});
