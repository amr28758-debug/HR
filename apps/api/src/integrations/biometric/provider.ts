/**
 * BiometricProvider — the ONLY seam between Burtplace Workforce and any biometric vendor (Matrix ARGO FACE, COSEC VYOM, others).
 * Core modules (attendance, payroll) never import vendor code. Adapters implement this interface based ONLY on
 * officially documented vendor functionality. Anything unconfirmed is reported through `capabilities()` as UNKNOWN/NOT_SUPPORTED.
 */
export type CapabilityStatus = 'OFFICIALLY_DOCUMENTED' | 'VENDOR_SUPPORTED' | 'UNKNOWN' | 'NOT_SUPPORTED';

export type CapabilityName =
  | 'createUser' | 'updateUser' | 'deleteUser' | 'assignUser' | 'getUser'
  | 'getAttendanceEvents' | 'subscribeToEvents' | 'offlinePunchRetrieval'
  | 'getDeviceStatus' | 'configureDevice' | 'biometricEnrollment' | 'templateTransfer' | 'backupRestore';

export type CapabilityMatrix = { [K in CapabilityName]: { status: CapabilityStatus; note?: string } };

export interface ExternalUser { externalUserId: string; name: string; isActive: boolean; deviceIds?: string[] }

export interface ExternalAttendanceEvent {
  externalUserId: string;
  deviceCode: string;
  punchedAt: Date;
  direction: 'IN' | 'OUT' | 'UNKNOWN';
  verificationMethod: 'FACE' | 'FINGER' | 'CARD' | 'PIN' | 'PALM' | 'MANUAL' | 'UNKNOWN';
  vendorEventId?: string;
  vendorPayload?: unknown;
}

export interface DeviceStatusInfo { deviceCode: string; online: boolean; lastSeenAt?: Date; firmware?: string; enrolledUserCount?: number; error?: string }

export interface SyncCursor { [key: string]: unknown }

export interface BiometricProvider {
  readonly code: string;
  capabilities(): CapabilityMatrix;
  createUser?(user: ExternalUser): Promise<void>;
  updateUser?(user: ExternalUser): Promise<void>;
  disableUser?(externalUserId: string): Promise<void>;
  deleteUser?(externalUserId: string): Promise<void>;
  assignUser?(externalUserId: string, deviceCodes: string[]): Promise<void>;
  getUser?(externalUserId: string): Promise<ExternalUser | null>;
  /** Pull events since cursor (polling adapters). */
  getAttendanceEvents?(cursor: SyncCursor | null): Promise<{ events: ExternalAttendanceEvent[]; nextCursor: SyncCursor }>;
  /** Push adapters: parse an inbound payload into normalised events. */
  parseInboundEvents?(payload: unknown): ExternalAttendanceEvent[];
  getDeviceStatus?(deviceCodes: string[]): Promise<DeviceStatusInfo[]>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

export class NotSupportedError extends Error {
  constructor(provider: string, capability: CapabilityName) {
    super(`${provider} does not support ${capability} (REQUIRES VENDOR CONFIRMATION)`);
  }
}
