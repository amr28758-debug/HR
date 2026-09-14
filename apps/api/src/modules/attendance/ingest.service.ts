import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { eventFingerprint } from '@burtplace/core';
import type { EventSource } from '@burtplace/types';
import type { ExternalAttendanceEvent } from '../../integrations/biometric/provider.js';

export interface IngestResult { batchId: string; received: number; inserted: number; duplicates: number; rejected: number; unmapped: number; rawEventIds: string[]; affectedEmployeeDates: { employeeId: string; date: string }[] }

/**
 * Append normalised events to the immutable raw ledger. Idempotent through event_fingerprint.
 * Resolves device → site and external user → employee at ingest time (mapping may be added later; processor re-resolves).
 */
export async function ingestEvents(db: Kysely<DB>, events: ExternalAttendanceEvent[], source: EventSource, actorUserId: string | null): Promise<IngestResult> {
  const deviceCodes = [...new Set(events.map((e) => e.deviceCode))];
  const devices = deviceCodes.length ? await db.selectFrom('devices').select(['id', 'device_code', 'site_id', 'timezone']).where('device_code', 'in', deviceCodes).execute() : [];
  const deviceByCode = new Map(devices.map((d) => [d.device_code, d]));
  const userIds = [...new Set(events.map((e) => e.externalUserId))];
  const mappings = userIds.length ? await db.selectFrom('biometric_mappings').select(['external_user_id', 'employee_id']).where('external_user_id', 'in', userIds).where('is_active', '=', true).execute() : [];
  const empByExternal = new Map(mappings.map((m) => [m.external_user_id, m.employee_id]));

  const batch = await db.insertInto('attendance_ingest_batches').values({ source, received_count: events.length, actor_user_id: actorUserId, device_id: devices.length === 1 ? devices[0]!.id : null }).returning('id').executeTakeFirstOrThrow();
  let inserted = 0, duplicates = 0, rejected = 0, unmapped = 0;
  const rawEventIds: string[] = [];
  const affected = new Map<string, { employeeId: string; date: string }>();

  for (const e of events) {
    if (Number.isNaN(e.punchedAt.getTime()) || e.punchedAt.getTime() > Date.now() + 5 * 60_000) { rejected++; continue; }
    const device = deviceByCode.get(e.deviceCode);
    const employeeId = empByExternal.get(e.externalUserId) ?? null;
    if (!employeeId) unmapped++;
    const fp = eventFingerprint({ externalUserId: e.externalUserId, punchedAt: e.punchedAt, direction: e.direction, deviceCode: e.deviceCode });
    const row = await db.insertInto('attendance_raw_events').values({
      event_fingerprint: fp, external_user_id: e.externalUserId, employee_id: employeeId, device_id: device?.id ?? null, device_code: e.deviceCode, site_id: device?.site_id ?? null,
      punched_at: e.punchedAt, direction: e.direction, verification_method: e.verificationMethod, source, vendor_event_id: e.vendorEventId ?? null,
      vendor_payload: e.vendorPayload === undefined ? null : JSON.stringify(e.vendorPayload), ingest_batch_id: batch.id,
    }).onConflict((oc) => oc.column('event_fingerprint').doNothing()).returning('id').executeTakeFirst();
    if (!row) { duplicates++; continue; }
    inserted++;
    rawEventIds.push(row.id);
    if (employeeId) {
      // the processor attributes the business date precisely; here we mark calendar date ± 1 so cross-midnight shifts get recalculated
      const zone = device?.timezone ?? 'Asia/Dubai';
      const cal = new Date(e.punchedAt.toLocaleString('en-US', { timeZone: zone }));
      const iso = `${cal.getFullYear()}-${String(cal.getMonth() + 1).padStart(2, '0')}-${String(cal.getDate()).padStart(2, '0')}`;
      const prev = new Date(cal); prev.setDate(prev.getDate() - 1);
      const prevIso = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
      for (const d of [prevIso, iso]) affected.set(`${employeeId}|${d}`, { employeeId, date: d });
    } else {
      await db.insertInto('attendance_exceptions').values({ employee_id: null, attendance_date: e.punchedAt.toISOString().slice(0, 10), exception_type: 'UNMAPPED_USER', severity: 'HIGH', details: JSON.stringify({ externalUserId: e.externalUserId, deviceCode: e.deviceCode }), raw_event_id: row.id }).onConflict((oc) => oc.doNothing()).execute();
    }
    if (device) {
      await db.updateTable('devices').set({ last_seen_at: new Date(), last_punch_at: e.punchedAt, status: 'ONLINE' }).where('id', '=', device.id).execute();
    }
  }
  await db.updateTable('attendance_ingest_batches').set({ inserted_count: inserted, duplicate_count: duplicates, rejected_count: rejected }).where('id', '=', batch.id).execute();
  return { batchId: batch.id, received: events.length, inserted, duplicates, rejected, unmapped, rawEventIds, affectedEmployeeDates: [...affected.values()] };
}
