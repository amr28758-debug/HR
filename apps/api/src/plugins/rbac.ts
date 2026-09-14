import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Principal } from './auth.js';
import { forbidden, unauthorized } from './errors.js';

export function requireAuth(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

/** Route preHandler: principal must hold at least one of the listed permissions. */
export function requirePermission(...codes: string[]): preHandlerAsyncHookHandler {
  return async (req) => {
    const p = requireAuth(req);
    if (codes.length === 0) return;
    if (!codes.some((c) => p.permissions.has(c))) throw forbidden(`Missing permission: one of [${codes.join(', ')}]`);
  };
}

export function hasPermission(p: Principal, code: string): boolean {
  return p.permissions.has(code);
}

/**
 * Data scope for list/read endpoints: 'all' | 'team' | 'own' | 'none'.
 * Team = employees whose manager chain / project / department is managed by this principal's employee record.
 */
export function resolveScope(p: Principal, resource: string): 'all' | 'team' | 'own' | 'none' {
  if (p.permissions.has(`${resource}:read`)) return 'all';
  if (p.permissions.has(`${resource}:read:team`)) return 'team';
  if (p.permissions.has(`${resource}:read:own`)) return 'own';
  return 'none';
}
