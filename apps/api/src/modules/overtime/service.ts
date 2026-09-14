import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';

/** Pick the applicable OT rule (most specific scope, highest priority) for an employee and day kind. */
export async function pickOvertimeRule(db: Kysely<DB>, emp: { id: string; site_id: string | null; project_id: string | null }, dayKind: string, date: string) {
  const rules = await db.selectFrom('overtime_rules').selectAll().where('is_active', '=', true).where('day_kind', '=', dayKind).where('effective_from', '<=', date).where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', date)]))
    .where((eb) => eb.or([eb('scope', '=', 'GLOBAL'), eb.and([eb('scope', '=', 'EMPLOYEE'), eb('scope_id', '=', emp.id)]), ...(emp.site_id ? [eb.and([eb('scope', '=', 'SITE'), eb('scope_id', '=', emp.site_id)])] : []), ...(emp.project_id ? [eb.and([eb('scope', '=', 'PROJECT'), eb('scope_id', '=', emp.project_id)])] : [])])).execute();
  const rank: Record<string, number> = { EMPLOYEE: 4, PROJECT: 3, SITE: 2, GLOBAL: 1 };
  rules.sort((a, b) => (rank[b.scope] ?? 0) - (rank[a.scope] ?? 0) || a.priority - b.priority);
  return rules[0] ?? null;
}

/** After approval: write approved minutes into attendance_daily so timesheets/payroll pick them up. */
export async function applyApprovedOvertime(db: Kysely<DB>, overtimeRequestId: string): Promise<void> {
  const ot = await db.selectFrom('overtime_requests').selectAll().where('id', '=', overtimeRequestId).executeTakeFirst();
  if (!ot) return;
  const approved = ot.approved_minutes ?? ot.requested_minutes;
  await db.updateTable('overtime_requests').set({ status: 'APPROVED', approved_minutes: approved, decided_at: new Date() }).where('id', '=', ot.id).execute();
  await db.updateTable('attendance_daily').set({ approved_overtime_minutes: approved }).where('employee_id', '=', ot.employee_id).where('attendance_date', '=', ot.attendance_date).where('locked_at', 'is', null).execute();
  await db.updateTable('attendance_exceptions').set({ status: 'RESOLVED', resolved_at: new Date(), resolution_note: 'OT approved' }).where('employee_id', '=', ot.employee_id).where('attendance_date', '=', ot.attendance_date).where('exception_type', '=', 'UNAPPROVED_OT').where('status', '=', 'OPEN').execute();
}
