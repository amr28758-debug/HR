import type { FastifyInstance } from 'fastify';
import { eachDate } from '@burtplace/core';

/** Apply an approval/rejection to balances and attendance. */
export async function applyLeaveDecision(app: FastifyInstance, leaveRequestId: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const lr = await app.db.selectFrom('leave_requests').selectAll().where('id', '=', leaveRequestId).executeTakeFirst();
  if (!lr) return;
  const year = Number(lr.start_date.slice(0, 4));
  const bal = await app.db.selectFrom('leave_balances').select(['id']).where('employee_id', '=', lr.employee_id).where('leave_type_id', '=', lr.leave_type_id).where('period_year', '=', year).executeTakeFirst();
  await app.db.transaction().execute(async (trx) => {
    if (bal) {
      if (decision === 'APPROVED') {
        await trx.updateTable('leave_balances').set((eb) => ({ used_days: eb('used_days', '+', Number(lr.total_days)), pending_days: eb('pending_days', '-', Number(lr.total_days)) })).where('id', '=', bal.id).execute();
        await trx.insertInto('leave_balance_transactions').values({ balance_id: bal.id, txn_type: 'USAGE', days: -Number(lr.total_days), reference_id: lr.id }).execute();
      } else {
        await trx.updateTable('leave_balances').set((eb) => ({ pending_days: eb('pending_days', '-', Number(lr.total_days)) })).where('id', '=', bal.id).execute();
      }
    }
    await trx.updateTable('leave_requests').set({ status: decision, decided_at: new Date() }).where('id', '=', lr.id).execute();
  });
  if (decision === 'APPROVED') {
    const today = new Date().toISOString().slice(0, 10);
    const dates = eachDate(lr.start_date, lr.end_date).filter((d) => d <= today);
    if (dates.length) await app.queues.enqueueProcessAffected(dates.map((date) => ({ employeeId: lr.employee_id, date })));
  }
}

/** Monthly accrual job: add entitlement/12 for every active employee for MONTHLY policies. Idempotent per month. */
export async function runMonthlyAccrual(app: FastifyInstance, year: number, month: number): Promise<number> {
  const policies = await app.db.selectFrom('leave_policies as p').innerJoin('leave_types as t', 't.id', 'p.leave_type_id').select(['p.leave_type_id', 'p.annual_entitlement_days', 'p.accrual_starts_after_days', 'p.max_balance_days']).where('p.accrual_method', '=', 'MONTHLY').where('p.is_active', '=', true).execute();
  const emps = await app.db.selectFrom('employees').select(['id', 'joining_date']).where('deleted_at', 'is', null).where('status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED']).execute();
  const marker = `${year}-${String(month).padStart(2, '0')}-01`;
  let n = 0;
  for (const pol of policies) {
    const monthly = Number(pol.annual_entitlement_days) / 12;
    for (const e of emps) {
      if (e.joining_date && (Date.now() - new Date(e.joining_date).getTime()) / 864e5 < pol.accrual_starts_after_days) continue;
      const bal = await app.db.insertInto('leave_balances').values({ employee_id: e.id, leave_type_id: pol.leave_type_id, period_year: year }).onConflict((oc) => oc.columns(['employee_id', 'leave_type_id', 'period_year']).doUpdateSet({ updated_at: new Date() })).returning(['id', 'last_accrued_at', 'balance_days']).executeTakeFirstOrThrow();
      if (bal.last_accrued_at && bal.last_accrued_at >= marker) continue;
      const add = pol.max_balance_days ? Math.max(0, Math.min(monthly, Number(pol.max_balance_days) - Number(bal.balance_days))) : monthly;
      await app.db.updateTable('leave_balances').set((eb) => ({ accrued_days: eb('accrued_days', '+', add), last_accrued_at: marker })).where('id', '=', bal.id).execute();
      await app.db.insertInto('leave_balance_transactions').values({ balance_id: bal.id, txn_type: 'ACCRUAL', days: add, note: `Monthly accrual ${marker}` }).execute();
      n++;
    }
  }
  return n;
}
