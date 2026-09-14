import type { BiometricProvider, CapabilityMatrix, ExternalAttendanceEvent, SyncCursor } from './provider.js';
import { NotSupportedError } from './provider.js';

/**
 * Matrix COSEC VYOM adapter — "Option B" (ARGO FACE → VYOM → Burtplace).
 *
 * STATUS: SKELETON. REQUIRES VENDOR CONFIRMATION.
 * No VYOM endpoint is implemented here because none has been verified against official Matrix documentation.
 * Per project rule 51 (NO FAKE INTEGRATION) this adapter refuses to fabricate URLs. To activate it:
 *   1. Obtain the official COSEC VYOM / COSEC CENTRA API document (Matrix "Third-party integration" / "API Integration Guide").
 *   2. Fill `capabilities()` with the confirmed status for each operation.
 *   3. Implement `getAttendanceEvents` using the documented event-export call, mapping to ExternalAttendanceEvent.
 *   4. Keep the cursor (last event id / timestamp) in integration_connections.cursor.
 * Until then BIOMETRIC_PROVIDER=vyom will fail health checks and the sync job will record an integration_failure instead of guessing.
 */
export class VyomBiometricProvider implements BiometricProvider {
  readonly code = 'VYOM';
  constructor(private readonly cfg: { baseUrl?: string; username?: string; password?: string }) {}

  capabilities(): CapabilityMatrix {
    const unknown = { status: 'UNKNOWN' as const, note: 'REQUIRES VENDOR CONFIRMATION — check official Matrix COSEC VYOM API documentation' };
    return {
      createUser: unknown, updateUser: unknown, deleteUser: unknown, assignUser: unknown, getUser: unknown,
      getAttendanceEvents: unknown, subscribeToEvents: unknown, offlinePunchRetrieval: unknown, getDeviceStatus: unknown, configureDevice: unknown,
      biometricEnrollment: { status: 'NOT_SUPPORTED', note: 'Enrollment stays on device/VYOM by design' },
      templateTransfer: { status: 'NOT_SUPPORTED', note: 'Burtplace never stores templates' },
      backupRestore: unknown,
    };
  }

  async getAttendanceEvents(_cursor: SyncCursor | null): Promise<{ events: ExternalAttendanceEvent[]; nextCursor: SyncCursor }> {
    throw new NotSupportedError(this.code, 'getAttendanceEvents');
  }

  async healthCheck() {
    if (!this.cfg.baseUrl) return { ok: false, message: 'VYOM_BASE_URL not configured' };
    return { ok: false, message: 'VYOM adapter not activated: endpoint contract REQUIRES VENDOR CONFIRMATION' };
  }
}
