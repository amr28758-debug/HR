import { sql, type Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { detectCompression, formatMoney, type CompressionPair, type CompressionFinding } from '@burtplace/core';
import { loadProfiles, PENDING_STATUSES, type Profile } from './data.js';
import { loadPolicy, type CompensationPolicy } from './policy.js';

/**
 * Salary alerts. `scanAlerts` recomputes every condition, upserts OPEN alerts by fingerprint (acknowledged ones stay
 * acknowledged) and resolves alerts whose condition disappeared. Runs daily (job `compensation.alerts.scan`) and on demand.
 */
export const ALERT_TYPES = ['BELOW_MIN', 'NEAR_MAX', 'AT_MAX', 'ABOVE_MAX', 'SALARY_BAND_MISSING', 'GRADE_MISSING', 'JOB_TITLE_WITHOUT_GRADE', 'NO_SALARY_STRUCTURE', 'DUE_FOR_REVIEW', 'ANNUAL_INCREASE_RECEIVED', 'PROMOTION_BELOW_MIN', 'PROMOTION_ABOVE_MAX', 'SALARY_COMPRESSION', 'OUTSIDE_WORKFLOW_CHANGE'] as const;
export interface AlertDraft { type: (typeof ALERT_TYPES)[number]; severity: 'CRITICAL' | 'WARNING' | 'INFO'; employeeId?: string | null; gradeId?: string | null; designationId?: string | null; message: string; details?: Record<string, unknown>; fingerprint: string }

export function profileAlerts(p: Profile, policy: CompensationPolicy, year: number): AlertDraft[] {
  const out: AlertDraft[] = [];
  const fp = (t: string) => `${t}:${p.employeeId}`;
  const cur = p.currency;
  if (p.currentSalary === null) out.push({ type: 'NO_SALARY_STRUCTURE', severity: 'CRITICAL', employeeId: p.employeeId, message: `${p.name} has no salary structure`, fingerprint: fp('NO_SALARY_STRUCTURE') });
  if (!p.gradeId) out.push({ type: 'GRADE_MISSING', severity: 'WARNING', employeeId: p.employeeId, message: `${p.name} has no grade${p.titleGradeCode ? ` (job title maps to ${p.titleGradeCode})` : ''}`, fingerprint: fp('GRADE_MISSING') });
  else if (!p.band) out.push({ type: 'SALARY_BAND_MISSING', severity: 'WARNING', employeeId: p.employeeId, gradeId: p.gradeId, message: `Grade ${p.gradeCode} has no active salary band (${p.name})`, fingerprint: fp('SALARY_BAND_MISSING') });
  if (p.band && p.currentSalary !== null) {
    const s = p.bandStatus, t = policy.statusThresholds;
    const d = { salary: p.currentSalary, min: p.band.min, mid: p.band.mid, max: p.band.max, compaRatio: p.compaRatio, rangePenetration: p.rangePenetration };
    if (s.code === t.aboveMax.code) out.push({ type: 'ABOVE_MAX', severity: 'CRITICAL', employeeId: p.employeeId, message: `${p.name} is above the ${p.gradeCode} maximum by ${formatMoney(p.aboveMaxBy, cur)}`, details: d, fingerprint: fp('ABOVE_MAX') });
    else if (s.code === t.atMax.code) out.push({ type: 'AT_MAX', severity: 'WARNING', employeeId: p.employeeId, message: `${p.name} is at the ${p.gradeCode} maximum`, details: d, fingerprint: fp('AT_MAX') });
    else if (s.code === t.belowMin.code) out.push({ type: 'BELOW_MIN', severity: 'WARNING', employeeId: p.employeeId, message: `${p.name} is below the ${p.gradeCode} minimum by ${formatMoney(p.belowMinBy, cur)}`, details: d, fingerprint: fp('BELOW_MIN') });
    else if (s.color === 'ORANGE' || s.color === 'YELLOW') out.push({ type: 'NEAR_MAX', severity: s.color === 'ORANGE' ? 'WARNING' : 'INFO', employeeId: p.employeeId, message: `${p.name} is ${s.label.toLowerCase()} (${p.rangePenetration}% of range, ${formatMoney(p.remainingToMax ?? 0, cur)} to maximum)`, details: d, fingerprint: fp('NEAR_MAX') });
  }
  if (p.dueForReview && p.currentSalary !== null) out.push({ type: 'DUE_FOR_REVIEW', severity: 'INFO', employeeId: p.employeeId, message: `${p.name} is due for a salary review (last increase ${p.lastIncreaseDate ?? 'never'}, window ${policy.reviewDueMonths} months)`, fingerprint: fp('DUE_FOR_REVIEW') });
  if (p.annualIncrementYears.includes(year)) out.push({ type: 'ANNUAL_INCREASE_RECEIVED', severity: 'INFO', employeeId: p.employeeId, message: `${p.name} already has an annual increase for ${year}`, fingerprint: `ANNUAL_INCREASE_RECEIVED:${p.employeeId}:${year}` });
  return out;
}

/** Build the configured comparison pairs and the salary samples per key (salary basis from policy). */
export async function compressionFindings(db: Kysely<DB>, profiles: Profile[]): Promise<CompressionFinding[]> {
  const rules = await db.selectFrom('salary_compression_rules').selectAll().where('is_active', '=', true).execute();
  if (!rules.length) return [];
  const byKey = new Map<string, number[]>();
  const push = (k: string, v: number) => byKey.set(k, [...(byKey.get(k) ?? []), v]);
  for (const p of profiles) if (p.currentSalary !== null) { if (p.designationId) push(`D:${p.designationId}`, p.currentSalary); if (p.gradeId) push(`G:${p.gradeId}`, p.currentSalary); }
  const titles = await db.selectFrom('designations as d').leftJoin('career_levels as l', 'l.id', 'd.career_level_id').select(['d.id', 'd.title', 'd.job_function_id', 'l.rank']).execute();
  const grades = await db.selectFrom('grades').select(['id', 'code', 'sort_order']).where('deleted_at', 'is', null).orderBy('sort_order').execute();
  const pairs: CompressionPair[] = [];
  for (const r of rules) {
    const base = { ruleId: r.id, ruleName: r.name, minDifferenceAmount: r.min_difference_amount === null ? null : Number(r.min_difference_amount), minDifferencePct: r.min_difference_pct === null ? null : Number(r.min_difference_pct), compare: r.compare as CompressionPair['compare'] };
    if (r.scope === 'DESIGNATION_PAIR' && r.lower_designation_id && r.upper_designation_id) {
      const l = titles.find((t) => t.id === r.lower_designation_id), u = titles.find((t) => t.id === r.upper_designation_id);
      pairs.push({ ...base, lowerKey: `D:${r.lower_designation_id}`, lowerLabel: l?.title ?? 'lower', upperKey: `D:${r.upper_designation_id}`, upperLabel: u?.title ?? 'upper' });
    } else if (r.scope === 'GRADE_SEQUENCE') {
      const used = grades.filter((g) => byKey.has(`G:${g.id}`));
      for (let i = 1; i < used.length; i++) pairs.push({ ...base, lowerKey: `G:${used[i - 1]!.id}`, lowerLabel: `Grade ${used[i - 1]!.code}`, upperKey: `G:${used[i]!.id}`, upperLabel: `Grade ${used[i]!.code}` });
    } else if (r.scope === 'JOB_FUNCTION_LEVELS' && r.job_function_id) {
      const ladder = titles.filter((t) => t.job_function_id === r.job_function_id && t.rank !== null && byKey.has(`D:${t.id}`)).sort((a, b) => a.rank! - b.rank!);
      for (let i = 1; i < ladder.length; i++) if (ladder[i]!.rank! > ladder[i - 1]!.rank!) pairs.push({ ...base, lowerKey: `D:${ladder[i - 1]!.id}`, lowerLabel: ladder[i - 1]!.title, upperKey: `D:${ladder[i]!.id}`, upperLabel: ladder[i]!.title });
    }
  }
  return detectCompression(pairs, byKey);
}

export async function scanAlerts(db: Kysely<DB>): Promise<{ open: number; created: number; resolved: number }> {
  const policy = await loadPolicy(db);
  const year = new Date().getFullYear();
  const profiles = await loadProfiles(db, policy);
  const drafts: AlertDraft[] = profiles.flatMap((p) => profileAlerts(p, policy, year));
  // Job titles without a grade (only titles in use)
  const titles = await sql<{ id: string; title: string; n: number }>`SELECT d.id, d.title, count(e.id)::int AS n FROM designations d JOIN employees e ON e.designation_id = d.id AND e.deleted_at IS NULL WHERE d.default_grade_id IS NULL GROUP BY d.id`.execute(db);
  for (const t of titles.rows) drafts.push({ type: 'JOB_TITLE_WITHOUT_GRADE', severity: 'WARNING', designationId: t.id, message: `Job title "${t.title}" (${t.n} employees) is not mapped to a grade`, fingerprint: `JOB_TITLE_WITHOUT_GRADE:${t.id}` });
  // Pending promotions outside the target band
  const promos = await db.selectFrom('promotion_requests as x').innerJoin('employees as e', 'e.id', 'x.employee_id').select(['x.id', 'x.employee_id', 'x.promotion_no', 'x.alerts', 'e.full_name_en']).where('x.status', 'in', ['DRAFT', ...PENDING_STATUSES]).execute();
  for (const pr of promos) for (const a of (pr.alerts ?? []) as { code: string; message: string }[]) if (a.code === 'PROMOTION_BELOW_MIN' || a.code === 'PROMOTION_ABOVE_MAX') drafts.push({ type: a.code, severity: a.code === 'PROMOTION_ABOVE_MAX' ? 'CRITICAL' : 'WARNING', employeeId: pr.employee_id, message: `${pr.promotion_no} (${pr.full_name_en}): ${a.message}`, details: { promotionId: pr.id }, fingerprint: `${a.code}:${pr.id}` });
  // Salary changed outside the compensation workflow (last 90 days)
  const direct = await db.selectFrom('salary_changes as c').innerJoin('employees as e', 'e.id', 'c.employee_id').select(['c.id', 'c.change_no', 'c.employee_id', 'e.full_name_en', 'c.old_salary', 'c.new_salary']).where('c.outside_workflow', '=', true).where('c.created_at', '>=', new Date(Date.now() - 90 * 864e5)).execute();
  for (const c of direct) drafts.push({ type: 'OUTSIDE_WORKFLOW_CHANGE', severity: 'WARNING', employeeId: c.employee_id, message: `${c.full_name_en}: salary changed outside the compensation workflow (${c.change_no}, ${c.old_salary} → ${c.new_salary})`, details: { changeId: c.id }, fingerprint: `OUTSIDE_WORKFLOW_CHANGE:${c.id}` });
  for (const f of await compressionFindings(db, profiles)) drafts.push({ type: 'SALARY_COMPRESSION', severity: f.reasons.includes('INVERSION') ? 'CRITICAL' : 'WARNING', message: f.message, details: f as unknown as Record<string, unknown>, fingerprint: `SALARY_COMPRESSION:${f.ruleId}:${f.lower.key}:${f.upper.key}` });

  let created = 0, resolved = 0;
  await db.transaction().execute(async (trx) => {
    const live = await trx.selectFrom('salary_alerts').select(['id', 'fingerprint']).where('status', '<>', 'RESOLVED').execute();
    const liveByFp = new Map(live.map((a) => [a.fingerprint, a.id]));
    const seen = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.fingerprint)) continue;
      seen.add(d.fingerprint);
      const id = liveByFp.get(d.fingerprint);
      if (id) await trx.updateTable('salary_alerts').set({ last_detected_at: new Date(), message: d.message, severity: d.severity, details: JSON.stringify(d.details ?? {}) }).where('id', '=', id).execute();
      else { await trx.insertInto('salary_alerts').values({ alert_type: d.type, severity: d.severity, employee_id: d.employeeId ?? null, grade_id: d.gradeId ?? null, designation_id: d.designationId ?? null, message: d.message, details: JSON.stringify(d.details ?? {}), fingerprint: d.fingerprint }).execute(); created++; }
    }
    const gone = live.filter((a) => !seen.has(a.fingerprint)).map((a) => a.id);
    if (gone.length) { resolved = gone.length; await trx.updateTable('salary_alerts').set({ status: 'RESOLVED', resolved_at: new Date(), resolution_note: 'Condition no longer detected' }).where('id', 'in', gone).execute(); }
  });
  return { open: new Set(drafts.map((d) => d.fingerprint)).size, created, resolved };
}
