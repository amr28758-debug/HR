import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { annualCost, bandPosition, round2 } from '@burtplace/core';
import { conflict } from '../../plugins/errors.js';
import { bandFor, nextCompNo } from './data.js';
import { loadPolicy } from './policy.js';

/**
 * The compensation ledger (`salary_changes`) mirrors every salary version, whatever path created it:
 *   • compensation module (COMPENSATION / REVIEW / PROMOTION) — written by service.ts with full approval data,
 *   • generic HR requests (HR_REQUEST) and direct salary entry (DIRECT) — written here, after the fact.
 * This guarantees "no salary change without an auditable salary change record" and applies duplicate protection to every path.
 */
export function duplicateMessage(year: number): string {
  return `Annual salary increase has already been processed for this employee for ${year}.`;
}

async function structurePair(db: Kysely<DB>, employeeId: string, structureId: string) {
  const cur = await db.selectFrom('employee_salary_structures').selectAll().where('id', '=', structureId).executeTakeFirstOrThrow();
  const prev = await db.selectFrom('employee_salary_structures').selectAll().where('employee_id', '=', employeeId).where('version', '<', cur.version).orderBy('version', 'desc').executeTakeFirst();
  return { cur, prev };
}

export async function recordLedgerForRequest(trx: Kysely<DB>, i: { requestId: string; requestType: string; employeeId: string; structureId: string; effectiveDate: string; reason: string; changeType?: string; requestedBy: string | null; approvedBy: string }): Promise<string> {
  const policy = await loadPolicy(trx);
  const { cur, prev } = await structurePair(trx, i.employeeId, i.structureId);
  const type = i.changeType ?? ({ PROMOTION: 'PROMOTION', INCREMENT: 'ANNUAL_INCREMENT', GRADE_CHANGE: 'GRADE_CHANGE' } as Record<string, string>)[i.requestType] ?? 'SPECIAL_ADJUSTMENT';
  const year = Number(i.effectiveDate.slice(0, 4));
  if (type === 'ANNUAL_INCREMENT') {
    const dup = await trx.selectFrom('salary_changes').select('change_no').where('employee_id', '=', i.employeeId).where('change_type', '=', 'ANNUAL_INCREMENT').where('effective_year', '=', year).where('status', 'not in', ['REJECTED', 'CANCELLED', 'FAILED']).where('duplicate_override', '=', false).executeTakeFirst();
    if (dup) throw conflict(duplicateMessage(year), { existing: dup.change_no });
  }
  const emp = await trx.selectFrom('employees').select(['grade_id', 'designation_id']).where('id', '=', i.employeeId).executeTakeFirstOrThrow();
  const band = await bandFor(trx, emp.grade_id, i.effectiveDate);
  const basis = policy.bandBasis;
  const oldS = prev ? Number(basis === 'GROSS' ? prev.gross_salary : prev.basic_salary) : 0;
  const newS = Number(basis === 'GROSS' ? cur.gross_salary : cur.basic_salary);
  const inc = round2(newS - oldS);
  const row = await trx.insertInto('salary_changes').values({
    change_no: await nextCompNo(trx, 'SC'), employee_id: i.employeeId, change_type: type, status: 'COMPLETED', source: 'HR_REQUEST', salary_basis: basis, currency: cur.currency,
    old_salary: oldS, increase_amount: inc, increase_pct: oldS > 0 ? round2((inc / oldS) * 100) : 0, new_salary: newS,
    old_basic: prev ? Number(prev.basic_salary) : null, new_basic: Number(cur.basic_salary), old_gross: prev ? Number(prev.gross_salary) : null, new_gross: Number(cur.gross_salary),
    annual_cost: annualCost(round2(Number(cur.gross_salary) - Number(prev?.gross_salary ?? 0)), policy.annualizationMonths), effective_date: i.effectiveDate, reason: i.reason,
    new_grade_id: emp.grade_id, new_designation_id: emp.designation_id, band_id: band?.id ?? null, band_min: band?.min ?? null, band_mid: band?.mid ?? null, band_max: band?.max ?? null,
    compa_before: band && oldS ? bandPosition(oldS, band).compaRatio : null, compa_after: band ? bandPosition(newS, band).compaRatio : null, exceeds_max_by: band ? Math.max(0, round2(newS - band.max)) : 0,
    hr_request_id: i.requestId, salary_structure_id: cur.id, requested_by: i.requestedBy, approved_by: i.approvedBy, approved_at: new Date(), completed_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/** POST /employees/:id/salary — first version = JOINING, later versions are flagged corrections outside the workflow. */
export async function recordDirectSalaryEntry(trx: Kysely<DB>, i: { employeeId: string; structureId: string; reason: string | null; userId: string }): Promise<string> {
  const policy = await loadPolicy(trx);
  const { cur, prev } = await structurePair(trx, i.employeeId, i.structureId);
  const emp = await trx.selectFrom('employees').select(['grade_id', 'designation_id']).where('id', '=', i.employeeId).executeTakeFirstOrThrow();
  const band = await bandFor(trx, emp.grade_id, cur.effective_from);
  const basis = policy.bandBasis;
  const oldS = prev ? Number(basis === 'GROSS' ? prev.gross_salary : prev.basic_salary) : 0;
  const newS = Number(basis === 'GROSS' ? cur.gross_salary : cur.basic_salary);
  const inc = round2(newS - oldS);
  const row = await trx.insertInto('salary_changes').values({
    change_no: await nextCompNo(trx, 'SC'), employee_id: i.employeeId, change_type: prev ? 'SALARY_CORRECTION' : 'JOINING', status: 'COMPLETED', source: 'DIRECT', outside_workflow: !!prev, salary_basis: basis, currency: cur.currency,
    old_salary: oldS, increase_amount: inc, increase_pct: oldS > 0 ? round2((inc / oldS) * 100) : 0, new_salary: newS,
    old_basic: prev ? Number(prev.basic_salary) : null, new_basic: Number(cur.basic_salary), old_gross: prev ? Number(prev.gross_salary) : null, new_gross: Number(cur.gross_salary),
    annual_cost: prev ? annualCost(round2(Number(cur.gross_salary) - Number(prev.gross_salary)), policy.annualizationMonths) : 0, effective_date: cur.effective_from, reason: i.reason ?? (prev ? 'Direct salary entry' : 'Joining salary'),
    new_grade_id: emp.grade_id, new_designation_id: emp.designation_id, band_id: band?.id ?? null, band_min: band?.min ?? null, band_mid: band?.mid ?? null, band_max: band?.max ?? null,
    compa_after: band ? bandPosition(newS, band).compaRatio : null, exceeds_max_by: band ? Math.max(0, round2(newS - band.max)) : 0,
    salary_structure_id: cur.id, requested_by: i.userId, approved_by: i.userId, approved_at: new Date(), completed_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
