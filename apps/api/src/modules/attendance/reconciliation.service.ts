import { sql, type Kysely } from 'kysely';
import type { DB } from '@burtplace/database';

/**
 * Reconciliation: identify mismatches across the pipeline
 *   device events → processed events → daily attendance → timesheets
 */
export async function runReconciliation(db: Kysely<DB>, from: string, to: string): Promise<{ id: string; summary: Record<string, number>; findings: unknown[] }> {
  const findings: unknown[] = [];
  const rawUnprocessed = await sql<{ n: number }>`SELECT count(*)::int AS n FROM attendance_raw_events WHERE employee_id IS NOT NULL AND processed_at IS NULL AND punched_at::date BETWEEN ${from}::date AND ${to}::date`.execute(db);
  const unmapped = await sql<{ n: number; users: string[] }>`SELECT count(*)::int AS n, array_agg(DISTINCT external_user_id) AS users FROM attendance_raw_events WHERE employee_id IS NULL AND punched_at::date BETWEEN ${from}::date AND ${to}::date`.execute(db);
  const missingDaily = await sql<{ employee_id: string; employee_no: string; missing_days: number }>`
    SELECT e.id AS employee_id, e.employee_no, (SELECT count(*) FROM generate_series(${from}::date, ${to}::date, '1 day') d WHERE NOT EXISTS (SELECT 1 FROM attendance_daily a WHERE a.employee_id = e.id AND a.attendance_date = d::date))::int AS missing_days
    FROM employees e WHERE e.deleted_at IS NULL AND e.status IN ('ACTIVE','PROBATION','CONFIRMED','TRANSFERRED','PROMOTED') AND (e.joining_date IS NULL OR e.joining_date <= ${to}::date)
  `.execute(db);
  const missing = missingDaily.rows.filter((r) => r.missing_days > 0);
  const eventsWithoutDaily = await sql<{ n: number }>`
    SELECT count(DISTINCT (r.employee_id, r.punched_at::date))::int AS n FROM attendance_raw_events r
    WHERE r.employee_id IS NOT NULL AND r.punched_at::date BETWEEN ${from}::date AND ${to}::date
      AND NOT EXISTS (SELECT 1 FROM attendance_events ae WHERE ae.raw_event_id = r.id)`.execute(db);
  const tsMismatch = await sql<{ timesheet_id: string; employee_no: string; ts_worked: number; daily_worked: number }>`
    SELECT t.id AS timesheet_id, e.employee_no, t.worked_minutes AS ts_worked, coalesce(sum(a.worked_minutes),0)::int AS daily_worked
    FROM timesheets t JOIN employees e ON e.id = t.employee_id
    LEFT JOIN attendance_daily a ON a.employee_id = t.employee_id AND a.attendance_date BETWEEN t.period_start AND t.period_end
    WHERE t.period_start <= ${to}::date AND t.period_end >= ${from}::date AND t.status <> 'LOCKED'
    GROUP BY t.id, e.employee_no, t.worked_minutes HAVING t.worked_minutes <> coalesce(sum(a.worked_minutes),0)`.execute(db);
  const payrollMismatch = await sql<{ payroll_employee_id: string; employee_no: string }>`
    SELECT pe.id AS payroll_employee_id, pe.employee_no FROM payroll_employees pe JOIN payroll_runs pr ON pr.id = pe.payroll_run_id JOIN timesheets t ON t.id = pe.timesheet_id
    WHERE pr.period_start <= ${to}::date AND pr.period_end >= ${from}::date AND pr.status NOT IN ('LOCKED','BANK_WPS','PAID','CLOSED') AND pe.overtime_minutes <> (t.overtime_minutes + t.weekend_ot_minutes + t.holiday_ot_minutes)`.execute(db);

  if (unmapped.rows[0]!.n > 0) findings.push({ type: 'UNMAPPED_USERS', count: unmapped.rows[0]!.n, externalUserIds: unmapped.rows[0]!.users });
  for (const m of missing.slice(0, 200)) findings.push({ type: 'EMPLOYEE_MISSING_DAILY', employeeId: m.employee_id, employeeNo: m.employee_no, missingDays: m.missing_days });
  for (const t of tsMismatch.rows) findings.push({ type: 'TIMESHEET_DAILY_MISMATCH', timesheetId: t.timesheet_id, employeeNo: t.employee_no, timesheetWorked: t.ts_worked, dailyWorked: t.daily_worked });
  for (const p of payrollMismatch.rows) findings.push({ type: 'PAYROLL_TIMESHEET_MISMATCH', payrollEmployeeId: p.payroll_employee_id, employeeNo: p.employee_no });

  const summary = { rawUnprocessed: rawUnprocessed.rows[0]!.n, unmappedEvents: unmapped.rows[0]!.n, rawEventsWithoutProcessedEvent: eventsWithoutDaily.rows[0]!.n, employeesMissingDaily: missing.length, timesheetMismatches: tsMismatch.rows.length, payrollMismatches: payrollMismatch.rows.length };
  const run = await db.insertInto('reconciliation_runs').values({ period_start: from, period_end: to, summary: JSON.stringify(summary), findings: JSON.stringify(findings) }).returning('id').executeTakeFirstOrThrow();
  return { id: run.id, summary, findings };
}
