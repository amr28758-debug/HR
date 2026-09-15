import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';

export interface TimelineInput { employeeId: string; type: string; title: string; description?: string | null; occurredAt?: Date; refType?: string | null; refId?: string | null; visibility?: 'EMPLOYEE' | 'MANAGER' | 'HR' | 'RESTRICTED'; actorUserId?: string | null; metadata?: unknown }

/** Append a business-readable event to the employee timeline (append-only table). */
export async function addTimeline(db: Kysely<DB>, e: TimelineInput): Promise<void> {
  await db.insertInto('employee_timeline_events').values({ employee_id: e.employeeId, event_type: e.type, title: e.title, description: e.description ?? null, occurred_at: e.occurredAt ?? new Date(), ref_type: e.refType ?? null, ref_id: e.refId ?? null, visibility: e.visibility ?? 'HR', actor_user_id: e.actorUserId ?? null, metadata: e.metadata === undefined ? null : JSON.stringify(e.metadata) }).execute();
}
