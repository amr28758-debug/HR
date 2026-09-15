import type { FastifyInstance } from 'fastify';
import { getEnv } from '@burtplace/config';
import type { JobName, JobPayloads } from './queues.js';
import { processAffected, processRange } from '../modules/attendance/processor.service.js';
import { runReconciliation } from '../modules/attendance/reconciliation.service.js';
import { generateTimesheetsForPeriod } from '../modules/timesheets/service.js';
import { runMonthlyAccrual } from '../modules/leave/service.js';
import { calculateRun } from '../modules/payroll/service.js';
import { ingestEvents } from '../modules/attendance/ingest.service.js';
import { createBiometricProvider } from '../integrations/biometric/registry.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
function resolveDate(token: string): string {
  const now = new Date();
  if (token === 'today') return iso(now);
  if (token === 'yesterday') return iso(new Date(now.getTime() - 864e5));
  if (token === 'month-start') return `${iso(now).slice(0, 7)}-01`;
  return token;
}

export async function runJob<N extends JobName>(app: FastifyInstance, name: N, payload: JobPayloads[N]): Promise<unknown> {
  const log = app.log.child({ job: name });
  switch (name) {
    case 'attendance.processAffected': {
      const n = await processAffected(app.db, (payload as JobPayloads['attendance.processAffected']).pairs);
      log.info({ n }, 'processed affected employee-days');
      return { processed: n };
    }
    case 'attendance.processRange': {
      const p = payload as JobPayloads['attendance.processRange'];
      const res = await processRange(app.db, resolveDate(p.from), resolveDate(p.to), p.employeeIds);
      log.info(res, 'processed range');
      return res;
    }
    case 'attendance.reconcile': {
      const p = payload as JobPayloads['attendance.reconcile'];
      return runReconciliation(app.db, resolveDate(p.from), resolveDate(p.to));
    }
    case 'timesheets.generate': {
      const p = payload as JobPayloads['timesheets.generate'];
      const now = new Date();
      const year = p.year || now.getUTCFullYear(), month = p.month || now.getUTCMonth() + 1;
      return generateTimesheetsForPeriod(app.db, year, month);
    }
    case 'leave.accrual': {
      const p = payload as JobPayloads['leave.accrual'];
      const now = new Date();
      return { accrued: await runMonthlyAccrual(app, p.year || now.getUTCFullYear(), p.month || now.getUTCMonth() + 1) };
    }
    case 'notifications.deliver': { const { deliverPending } = await import('../notifications/channels.js'); return { delivered: await deliverPending(app) }; }
    case 'documents.expiryScan': {
      // Update statuses + notify HR about documents expiring within their reminder window (once per day per document)
      await app.db.updateTable('employee_documents').set({ status: 'EXPIRED' }).where('expiry_date', '<', iso(new Date())).where('deleted_at', 'is', null).where('status', '<>', 'EXPIRED').execute();
      const soon = await app.db.selectFrom('v_document_expiry').selectAll().where('days_to_expiry', '>=', 0).where('computed_status', '=', 'EXPIRING').execute();
      await app.db.updateTable('employee_documents').set({ status: 'EXPIRING' }).where('id', 'in', soon.length ? soon.map((s) => s.id) : ['00000000-0000-0000-0000-000000000000']).execute();
      const hrUsers = await app.db.selectFrom('user_roles').innerJoin('roles', 'roles.id', 'user_roles.role_id').select('user_roles.user_id').where('roles.code', 'in', ['HR_ADMIN', 'HR_MANAGER']).execute();
      let notified = 0;
      for (const d of soon) {
        const already = await app.db.selectFrom('employee_documents').select('last_reminded_at').where('id', '=', d.id).executeTakeFirst();
        if (already?.last_reminded_at && Date.now() - new Date(already.last_reminded_at).getTime() < 6 * 864e5) continue;
        for (const u of hrUsers) await app.db.insertInto('notifications').values({ user_id: u.user_id, type: 'document.expiring', title: `${d.document_type} expiring in ${d.days_to_expiry} days`, body: `${d.employee_no} ${d.full_name_en}`, link: `/employees/${d.employee_id}?tab=documents` }).execute();
        await app.db.updateTable('employee_documents').set({ last_reminded_at: new Date() }).where('id', '=', d.id).execute();
        notified++;
      }
      return { expiring: soon.length, notified };
    }
    case 'devices.healthScan': {
      const res = await app.db.updateTable('devices').set({ status: 'OFFLINE' }).where('is_active', '=', true).where('status', '=', 'ONLINE').where((eb) => eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', new Date(Date.now() - 3 * 3600e3))])).returning('id').execute();
      if (res.length) {
        const itUsers = await app.db.selectFrom('user_roles').innerJoin('roles', 'roles.id', 'user_roles.role_id').select('user_roles.user_id').where('roles.code', '=', 'IT_ADMIN').execute();
        for (const u of itUsers) await app.db.insertInto('notifications').values({ user_id: u.user_id, type: 'device.offline', title: `${res.length} device(s) went offline`, body: null, link: '/devices' }).execute();
      }
      return { markedOffline: res.length };
    }
    case 'biometric.sync': {
      // Polling providers only (VYOM). Webhook provider has nothing to pull.
      const provider = createBiometricProvider(getEnv());
      if (!provider?.getAttendanceEvents) return { skipped: true };
      const conn = await app.db.selectFrom('integration_connections').selectAll().where('code', '=', 'MATRIX_VYOM').executeTakeFirst();
      if (!conn || conn.status !== 'ACTIVE') return { skipped: true, reason: 'connection not active' };
      const started = Date.now();
      try {
        const { events, nextCursor } = await provider.getAttendanceEvents((conn.cursor as Record<string, unknown>) ?? null);
        const res = await ingestEvents(app.db, events, 'VYOM_SYNC', null);
        await app.queues.enqueueProcessAffected(res.affectedEmployeeDates);
        await app.db.updateTable('integration_connections').set({ cursor: JSON.stringify(nextCursor), last_success_at: new Date() }).where('id', '=', conn.id).execute();
        await app.db.insertInto('integration_logs').values({ connection_id: conn.id, operation: 'sync', status: 'SUCCESS', response_summary: JSON.stringify({ received: res.received, inserted: res.inserted }), duration_ms: Date.now() - started }).execute();
        return res;
      } catch (e) {
        const msg = (e as Error).message;
        await app.db.updateTable('integration_connections').set({ last_error: msg, last_error_at: new Date() }).where('id', '=', conn.id).execute();
        await app.db.insertInto('integration_logs').values({ connection_id: conn.id, operation: 'sync', status: 'FAILURE', response_summary: JSON.stringify({ error: msg }), duration_ms: Date.now() - started }).execute();
        throw e;
      }
    }
    case 'payroll.calculate':
      return calculateRun(app.db, (payload as JobPayloads['payroll.calculate']).runId);
  }
}
