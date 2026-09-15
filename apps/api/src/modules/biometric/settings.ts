import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import { z } from 'zod';

/**
 * Face attendance configuration — versioned in app_settings (key `attendance.face`) with full history.
 * Threshold defaults follow the provider's documented recommendations (Human: similarity > 0.5 = match; antispoof and
 * liveness are binary classifiers with a 0.5 decision point). Everything else is company policy and MUST be reviewed:
 * duplicate window, GPS accuracy limit, retention — see docs/MOBILE-FACE-ATTENDANCE.md.
 */
export const faceSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  modes: z.object({ employeeMobile: z.boolean().default(true), supervisorMobile: z.boolean().default(true), siteKiosk: z.boolean().default(true) }).default({}),
  provider: z.enum(['HUMAN']).default('HUMAN'),
  thresholds: z.object({
    match: z.number().min(0).max(1).default(0.5),            // provider recommendation (Human docs)
    ambiguityMargin: z.number().min(0).max(0.5).default(0.05), // top-1 minus top-2 must exceed this, else AMBIGUOUS
    antispoof: z.number().min(0).max(1).default(0.5),        // Human antispoof classifier decision point
    liveness: z.number().min(0).max(1).default(0.5),         // Human liveness classifier decision point
    faceQuality: z.number().min(0).max(1).default(0.8),      // detector confidence required for enrollment/recognition
    minFaceSizePx: z.number().int().min(32).default(96),      // face box size in the submitted frame
    maxYawRad: z.number().min(0).max(1.5).default(0.45),      // ≈ 26°: reject strongly turned faces for recognition
    enrollMaxYawRad: z.number().min(0).max(1.5).default(0.6), // enrollment accepts slight left/right (≈ 34°)
  }).default({}),
  liveness: z.object({ required: z.boolean().default(true), activeChallenge: z.boolean().default(true), challengeTimeoutSeconds: z.number().int().min(3).max(60).default(12) }).default({}),
  gps: z.object({ required: z.boolean().default(true), geofenceRequired: z.boolean().default(true), accuracyLimitM: z.number().int().min(5).max(5000).default(100), maxFixAgeSeconds: z.number().int().min(5).max(600).default(90), kioskGpsRequired: z.boolean().default(false) }).default({}),
  duplicateWindowSeconds: z.number().int().min(5).max(3600).default(120),
  ticketTtlSeconds: z.number().int().min(15).max(300).default(90),
  behaviour: z.object({
    unknownFace: z.enum(['REJECT']).default('REJECT'),
    lowConfidence: z.enum(['REJECT', 'EXCEPTION']).default('REJECT'),
    suspiciousGps: z.enum(['REJECT', 'EXCEPTION']).default('EXCEPTION'),   // record punch + LOCATION_SUSPICIOUS exception for review
    outsideGeofence: z.enum(['REJECT', 'EXCEPTION']).default('REJECT'),
    lowAccuracy: z.enum(['REJECT', 'EXCEPTION']).default('EXCEPTION'),
  }).default({}),
  offline: z.object({ queueEnabled: z.boolean().default(false), maxQueueAgeHours: z.number().int().min(1).max(168).default(24) }).default({}),
  retention: z.object({
    disableOnExit: z.boolean().default(true),                       // TERMINATED/ARCHIVED → template DISABLED
    deleteAfterExitDays: z.number().int().min(0).max(3650).nullable().default(null), // null = keep until manual deletion (policy REQUIRES HR/LEGAL APPROVAL)
    recognitionEventRetentionDays: z.number().int().min(30).max(3650).default(365),
    policyApprovedBy: z.string().nullable().default(null),          // HR/Legal sign-off reference
  }).default({}),
  privacy: z.object({ consentNoticeVersion: z.string().default('DRAFT — REQUIRES HR/LEGAL APPROVAL'), showPhotoOnKiosk: z.boolean().default(false) }).default({}),
});
export type FaceSettings = z.infer<typeof faceSettingsSchema>;
export const FACE_SETTINGS_KEY = 'attendance.face';
export const DEFAULT_FACE_SETTINGS: FaceSettings = faceSettingsSchema.parse({});

let cache: { value: FaceSettings; version: number; at: number } | null = null;
export async function loadFaceSettings(db: Kysely<DB>, maxAgeMs = 10_000): Promise<{ value: FaceSettings; version: number }> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache;
  const row = await db.selectFrom('app_settings').select(['value', 'version']).where('key', '=', FACE_SETTINGS_KEY).executeTakeFirst();
  const parsed = faceSettingsSchema.safeParse(row?.value ?? {});
  cache = { value: parsed.success ? parsed.data : DEFAULT_FACE_SETTINGS, version: row?.version ?? 0, at: Date.now() };
  return cache;
}
export function invalidateFaceSettings(): void { cache = null; }

export async function saveFaceSettings(db: Kysely<DB>, value: FaceSettings, userId: string, reason?: string): Promise<{ version: number }> {
  const cur = await db.selectFrom('app_settings').select('version').where('key', '=', FACE_SETTINGS_KEY).executeTakeFirst();
  const version = (cur?.version ?? 0) + 1;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('app_settings').values({ key: FACE_SETTINGS_KEY, value: JSON.stringify(value), version, updated_by: userId }).onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), version, updated_by: userId, updated_at: new Date() })).execute();
    await trx.insertInto('app_settings_history').values({ key: FACE_SETTINGS_KEY, version, value: JSON.stringify(value), changed_by: userId, reason: reason ?? null }).execute();
  });
  invalidateFaceSettings();
  return { version };
}
