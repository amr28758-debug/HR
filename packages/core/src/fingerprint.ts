import { createHash } from 'node:crypto';

export interface FingerprintInput {
  externalUserId: string;
  punchedAt: Date | string;
  direction: string;
  deviceCode: string;
}

/**
 * Deterministic event fingerprint: SHA256(external_user_id|timestamp(ISO, ms, UTC)|direction|device_code).
 * The same physical punch reported twice (device push + VYOM sync) yields the same fingerprint → one raw event.
 */
export function eventFingerprint(input: FingerprintInput): string {
  const ts = input.punchedAt instanceof Date ? input.punchedAt.toISOString() : new Date(input.punchedAt).toISOString();
  const material = [input.externalUserId.trim(), ts, input.direction.toUpperCase().trim(), input.deviceCode.trim()].join('|');
  return createHash('sha256').update(material).digest('hex');
}
