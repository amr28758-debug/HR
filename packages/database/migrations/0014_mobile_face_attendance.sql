-- ═══════════════════════════════════════════════════════════════════════════
-- MOBILE FACE RECOGNITION ATTENDANCE
-- A mobile/tablet browser acts as a face-recognition terminal. Recognised punches enter the EXISTING immutable raw
-- punch ledger (attendance_raw_events) with source MOBILE_FACE and are processed by the EXISTING attendance engine.
-- Biometric templates are isolated from employee data, encrypted at rest, and never joined into directory/search/exports.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Normalised attendance source (the engine is source-agnostic: DEVICE_PUSH | VYOM_SYNC | GATEWAY | MANUAL | IMPORT | API | MOBILE_FACE)
ALTER TYPE event_source ADD VALUE IF NOT EXISTS 'MOBILE_FACE';

-- 2. Face templates (biometric data — RESTRICTED). One ACTIVE template per employee per provider.
CREATE TABLE biometric_face_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  provider        text NOT NULL,                      -- e.g. HUMAN (see integrations/face)
  model_version   text NOT NULL,                      -- provider model/version used to compute the embedding
  embedding_dim   integer NOT NULL,
  embedding_enc   bytea NOT NULL,                     -- AES-256-GCM(iv || tag || ciphertext) of the float32 embedding
  sample_count    integer NOT NULL DEFAULT 1,         -- frames averaged into the template
  quality         jsonb NOT NULL DEFAULT '{}'::jsonb, -- per-sample quality metrics (no images)
  status          text NOT NULL DEFAULT 'ACTIVE',     -- ACTIVE | DISABLED | DELETED
  consent_note    text,                               -- how consent/notice was recorded (policy: REQUIRES HR/LEGAL APPROVAL)
  enrolled_by     uuid REFERENCES users(id),
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  disabled_reason text,
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX bft_active_idx ON biometric_face_templates(employee_id, provider) WHERE status = 'ACTIVE';
CREATE INDEX bft_employee_idx ON biometric_face_templates(employee_id);
CREATE TRIGGER biometric_face_templates_updated_at BEFORE UPDATE ON biometric_face_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Attendance terminals (kiosk identity). A terminal IS a device (vendor MOBILE_FACE) plus a pairing secret.
CREATE TABLE attendance_terminals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         uuid NOT NULL UNIQUE REFERENCES devices(id),
  terminal_type     text NOT NULL DEFAULT 'MOBILE_KIOSK',   -- MOBILE_KIOSK | TABLET_KIOSK | SUPERVISOR_MOBILE
  token_hash        text UNIQUE,                            -- sha256(pepper + token); token issued once at pairing
  pairing_code      text,                                    -- one-time code shown to the admin; consumed at pairing
  pairing_expires_at timestamptz,
  paired_at         timestamptz,
  paired_user_agent text,
  status            text NOT NULL DEFAULT 'PENDING',         -- PENDING | ACTIVE | REVOKED
  last_seen_at      timestamptz,
  last_ip           inet,
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES users(id),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 4. Additional geofences per site (sites.latitude/longitude/geofence_radius_m remains the primary fence).
CREATE TABLE site_geofences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id),
  name        text NOT NULL,
  latitude    numeric(9,6) NOT NULL,
  longitude   numeric(9,6) NOT NULL,
  radius_m    integer NOT NULL CHECK (radius_m > 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_geofences_site_idx ON site_geofences(site_id) WHERE is_active;

-- 5. Recognition events — immutable audit of every attempt (no embeddings, no images).
CREATE TABLE face_recognition_events (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  attendance_mode text NOT NULL,                      -- EMPLOYEE_MOBILE | SUPERVISOR_MOBILE | SITE_KIOSK
  terminal_id     uuid REFERENCES attendance_terminals(id),
  device_code     text,
  site_id         uuid REFERENCES sites(id),
  outcome         text NOT NULL,                      -- MATCHED | NO_FACE | MULTIPLE_FACES | QUALITY_FAILED | LIVENESS_FAILED | NO_MATCH | LOW_CONFIDENCE | AMBIGUOUS | PUNCHED | REJECTED
  reason          text,
  employee_id     uuid REFERENCES employees(id),
  top_score       numeric(6,4),
  second_score    numeric(6,4),
  antispoof_score numeric(6,4),
  liveness_score  numeric(6,4),
  quality         jsonb,
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  gps_accuracy_m  numeric(9,2),
  geofence_result text,                               -- INSIDE | OUTSIDE | NO_GPS | LOW_ACCURACY | SUSPICIOUS | NOT_REQUIRED
  distance_m      numeric(10,2),
  direction       punch_direction,
  raw_event_id    uuid REFERENCES attendance_raw_events(id),
  provider        text,
  model_version   text,
  actor_user_id   uuid REFERENCES users(id),
  ip_address      inet,
  user_agent      text,
  duration_ms     integer
);
CREATE INDEX fre_employee_time_idx ON face_recognition_events(employee_id, occurred_at DESC);
CREATE INDEX fre_time_idx ON face_recognition_events(occurred_at DESC);
CREATE TRIGGER face_recognition_events_immutable BEFORE UPDATE OR DELETE ON face_recognition_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 6. Versioned application settings (face attendance configuration lives under key 'attendance.face').
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_settings_history (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL,
  version     integer NOT NULL,
  value       jsonb NOT NULL,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  reason      text
);
CREATE INDEX app_settings_history_key_idx ON app_settings_history(key, version DESC);
