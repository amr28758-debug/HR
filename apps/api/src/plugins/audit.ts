import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  approvalRef?: string | null;
  metadata?: unknown;
}

declare module 'fastify' {
  /** `executor` lets callers write the audit row inside their own transaction (it then commits/rolls back with the change). */
  interface FastifyInstance { audit(req: FastifyRequest | null, entry: AuditEntry, source?: string, executor?: Kysely<DB>): Promise<void> }
}

/** Sensitive keys are masked in audit payloads (values are still tracked as changed). */
const MASKED = new Set(['local_password_hash', 'bank_account_number', 'bank_iban', 'key_hash']);
function mask(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = MASKED.has(k) && val != null ? '***' : val;
  return out;
}

export default fp(async function auditPlugin(app: FastifyInstance) {
  app.decorate('audit', async (req: FastifyRequest | null, entry: AuditEntry, source = 'api', executor?: Kysely<DB>) => {
    await (executor ?? app.db).insertInto('audit_logs').values({
      actor_user_id: req?.principal?.userId ?? null,
      actor_label: req?.principal?.displayName ?? (source === 'worker' ? 'system-worker' : null),
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      old_value: entry.oldValue === undefined ? null : JSON.stringify(mask(entry.oldValue)),
      new_value: entry.newValue === undefined ? null : JSON.stringify(mask(entry.newValue)),
      reason: entry.reason ?? null,
      ip_address: req?.ip ?? null,
      user_agent: typeof req?.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : null,
      source,
      approval_ref: entry.approvalRef ?? null,
      request_id: req?.id ?? null,
      metadata: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
    }).execute();
  });
});
