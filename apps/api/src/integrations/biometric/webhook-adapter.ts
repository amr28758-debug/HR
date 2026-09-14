import { z } from 'zod';
import type { BiometricProvider, CapabilityMatrix, ExternalAttendanceEvent } from './provider.js';

/**
 * WEBHOOK / GATEWAY adapter — vendor-neutral. A device gateway, Matrix middleware, or COSEC export job POSTs punches to
 * POST /api/v1/attendance/events using an API key. This is the guaranteed-working path today and the long-term "Option A"
 * once the Device Gateway talks to ARGO FACE terminals natively.
 *
 * Accepted payload (single object or array):
 *   { userId: "777", deviceCode: "ARGO-C31-01", timestamp: "2026-09-07T02:00:00Z", direction?: "IN"|"OUT", method?: "FACE", eventId?: "abc" }
 */
export const inboundEventSchema = z.object({
  userId: z.union([z.string(), z.number()]).transform(String),
  deviceCode: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  direction: z.enum(['IN', 'OUT', 'UNKNOWN']).optional(),
  method: z.enum(['FACE', 'FINGER', 'CARD', 'PIN', 'PALM', 'MANUAL', 'UNKNOWN']).optional(),
  eventId: z.string().optional(),
});
export const inboundBatchSchema = z.union([inboundEventSchema, z.array(inboundEventSchema).min(1).max(5000)]);

export class WebhookBiometricProvider implements BiometricProvider {
  readonly code = 'WEBHOOK';
  capabilities(): CapabilityMatrix {
    const na = { status: 'NOT_SUPPORTED' as const, note: 'Push-only adapter; user management happens on the device / vendor software' };
    return {
      createUser: na, updateUser: na, deleteUser: na, assignUser: na, getUser: na,
      getAttendanceEvents: { status: 'NOT_SUPPORTED', note: 'events are pushed, not pulled' },
      subscribeToEvents: { status: 'OFFICIALLY_DOCUMENTED', note: 'Burtplace-owned HTTP endpoint; documented in /docs' },
      offlinePunchRetrieval: { status: 'VENDOR_SUPPORTED', note: 'Gateway/middleware must replay buffered punches; fingerprints make replay idempotent' },
      getDeviceStatus: { status: 'VENDOR_SUPPORTED', note: 'derived from last event / heartbeat POST' },
      configureDevice: na, biometricEnrollment: na, templateTransfer: { status: 'NOT_SUPPORTED', note: 'Templates are never transferred to Burtplace by design' }, backupRestore: na,
    };
  }
  parseInboundEvents(payload: unknown): ExternalAttendanceEvent[] {
    const parsed = inboundBatchSchema.parse(payload);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((e) => ({ externalUserId: e.userId, deviceCode: e.deviceCode, punchedAt: new Date(e.timestamp), direction: e.direction ?? 'UNKNOWN', verificationMethod: e.method ?? 'UNKNOWN', vendorEventId: e.eventId, vendorPayload: e }));
  }
  async healthCheck() { return { ok: true }; }
}
