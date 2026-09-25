import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '@burtplace/database';
import { EXAMPLE_COMPENSATION_POLICY } from '@burtplace/database';
import { validateThresholds, type StatusThresholds } from '@burtplace/core';

/**
 * Compensation policy — versioned in app_settings (key `compensation.policy`) with full history in app_settings_history.
 * Holds the non-tabular configuration: band basis, status thresholds, allowed ceiling actions, budget enforcement,
 * segregation of duties, review-due window. Tabular configuration (bands, matrix, rules, budgets) lives in tables.
 */
const color = z.enum(['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLUE', 'GREY']);
const status = z.object({ code: z.string().min(1).max(40), label: z.string().min(1).max(60), color });
export const policySchema = z.object({
  signedOff: z.boolean().default(false),
  bandBasis: z.enum(['BASIC', 'GROSS']).default('BASIC'),
  statusThresholds: z.object({ ranges: z.array(status.extend({ fromPct: z.number().min(0).max(100), toPct: z.number().min(0).max(100) })).min(1), belowMin: status, atMax: status, aboveMax: status, noBand: status }),
  ceilingActions: z.array(z.enum(['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE'])).min(1),
  annualizationMonths: z.number().min(1).max(24).default(12),
  budgetEnforcement: z.enum(['BLOCK', 'WARN', 'OFF']).default('BLOCK'),
  segregationOfDuties: z.boolean().default(true),
  reviewDueMonths: z.number().int().min(1).max(60).default(12),
  maxIncreasePctWithoutOverride: z.number().min(0).max(1000).default(25),
  directSalaryEntry: z.enum(['ALLOWED', 'INITIAL_ONLY']).default('ALLOWED'),
}).superRefine((v, ctx) => { for (const e of validateThresholds(v.statusThresholds as StatusThresholds)) ctx.addIssue({ code: 'custom', path: ['statusThresholds'], message: e }); });
export type CompensationPolicy = z.infer<typeof policySchema> & { statusThresholds: StatusThresholds };
export const POLICY_KEY = 'compensation.policy';
const DEFAULT_POLICY = policySchema.parse(EXAMPLE_COMPENSATION_POLICY) as CompensationPolicy;

let cache: { value: CompensationPolicy; version: number; at: number } | null = null;
export async function loadPolicy(db: Kysely<DB>, maxAgeMs = 5_000): Promise<CompensationPolicy> {
  return (await loadPolicyVersioned(db, maxAgeMs)).value;
}
export async function loadPolicyVersioned(db: Kysely<DB>, maxAgeMs = 5_000): Promise<{ value: CompensationPolicy; version: number }> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache;
  const row = await db.selectFrom('app_settings').select(['value', 'version']).where('key', '=', POLICY_KEY).executeTakeFirst();
  const parsed = policySchema.safeParse({ ...DEFAULT_POLICY, ...((row?.value ?? {}) as object) });
  cache = { value: (parsed.success ? parsed.data : DEFAULT_POLICY) as CompensationPolicy, version: row?.version ?? 0, at: Date.now() };
  return cache;
}
export async function savePolicy(db: Kysely<DB>, value: CompensationPolicy, userId: string, reason?: string): Promise<{ version: number }> {
  const cur = await db.selectFrom('app_settings').select('version').where('key', '=', POLICY_KEY).executeTakeFirst();
  const version = (cur?.version ?? 0) + 1;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('app_settings').values({ key: POLICY_KEY, value: JSON.stringify(value), version, updated_by: userId }).onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), version, updated_by: userId, updated_at: new Date() })).execute();
    await trx.insertInto('app_settings_history').values({ key: POLICY_KEY, version, value: JSON.stringify(value), changed_by: userId, reason: reason ?? null }).execute();
  });
  cache = null;
  return { version };
}
export function invalidatePolicy(): void { cache = null; }
