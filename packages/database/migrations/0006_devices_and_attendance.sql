-- 0006: devices, biometric mappings, raw attendance ledger (immutable), processed events, daily attendance, exceptions

CREATE TABLE devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code       text NOT NULL UNIQUE,         -- vendor device id / serial as reported
  name              text NOT NULL,
  vendor            text NOT NULL DEFAULT 'MATRIX',
  model             text,                          -- e.g. ARGO FACE
  firmware_version  text,
  ip_address        inet,
  mac_address       text,
  site_id           uuid REFERENCES sites(id),
  status            device_status NOT NULL DEFAULT 'UNKNOWN',
  last_seen_at      timestamptz,
  last_sync_at      timestamptz,
  last_punch_at     timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  enrolled_user_count integer,
  timezone          text NOT NULL DEFAULT 'Asia/Dubai',
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX devices_site_idx ON devices(site_id);
CREATE TRIGGER devices_updated_at BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A device may serve several sites over time; history kept for reporting.
CREATE TABLE device_sites (
  id          bigserial PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  site_id     uuid NOT NULL REFERENCES sites(id),
  from_date   date NOT NULL DEFAULT CURRENT_DATE,
  to_date     date,
  UNIQUE (device_id, from_date)
);

-- Which external (device/vendor) identities map to which employee. No biometric templates stored here.
CREATE TABLE biometric_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'MATRIX',    -- MATRIX | OTHER
  external_user_id text NOT NULL,                     -- matrix user id
  enrolled_devices uuid[] NOT NULL DEFAULT '{}',
  enrolled_at     timestamptz,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_user_id)
);
CREATE INDEX biometric_mappings_emp_idx ON biometric_mappings(employee_id);
CREATE TRIGGER biometric_mappings_updated_at BEFORE UPDATE ON biometric_mappings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- RAW PUNCH LEDGER — IMMUTABLE. Never updated, never deleted. Corrections live elsewhere.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE attendance_raw_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_fingerprint   text NOT NULL UNIQUE,        -- sha256(external_user_id|timestamp|direction|device_code)
  external_user_id    text NOT NULL,               -- matrix user id as reported by device
  employee_id         uuid REFERENCES employees(id),  -- resolved at ingest if mapping exists (may be null → UNMAPPED_USER exception)
  device_id           uuid REFERENCES devices(id),
  device_code         text NOT NULL,
  site_id             uuid REFERENCES sites(id),
  punched_at          timestamptz NOT NULL,        -- device event time (UTC)
  direction           punch_direction NOT NULL DEFAULT 'UNKNOWN',
  verification_method verification_method NOT NULL DEFAULT 'UNKNOWN',
  source              event_source NOT NULL,
  vendor_event_id     text,
  vendor_payload      jsonb,                       -- exact payload as received
  received_at         timestamptz NOT NULL DEFAULT now(),
  ingest_batch_id     uuid,
  processed_at        timestamptz,                 -- the ONLY column the processor may set (via mark_raw_events_processed)
  processing_error    text
);
CREATE INDEX are_employee_time_idx ON attendance_raw_events(employee_id, punched_at);
CREATE INDEX are_external_time_idx ON attendance_raw_events(external_user_id, punched_at);
CREATE INDEX are_device_time_idx ON attendance_raw_events(device_id, punched_at DESC);
CREATE INDEX are_unprocessed_idx ON attendance_raw_events(received_at) WHERE processed_at IS NULL;
CREATE INDEX are_punched_at_idx ON attendance_raw_events(punched_at);

-- Only processed_at / processing_error / employee_id (late mapping) may change; everything else is frozen.
CREATE OR REPLACE FUNCTION attendance_raw_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance_raw_events is an immutable ledger: DELETE forbidden';
  END IF;
  IF NEW.event_fingerprint IS DISTINCT FROM OLD.event_fingerprint
     OR NEW.external_user_id IS DISTINCT FROM OLD.external_user_id
     OR NEW.device_code IS DISTINCT FROM OLD.device_code
     OR NEW.punched_at IS DISTINCT FROM OLD.punched_at
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.verification_method IS DISTINCT FROM OLD.verification_method
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.vendor_payload IS DISTINCT FROM OLD.vendor_payload
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.vendor_event_id IS DISTINCT FROM OLD.vendor_event_id THEN
    RAISE EXCEPTION 'attendance_raw_events is an immutable ledger: raw punch fields cannot be modified';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_raw_events_immutable BEFORE UPDATE OR DELETE ON attendance_raw_events FOR EACH ROW EXECUTE FUNCTION attendance_raw_events_guard();

-- Manual corrections/additions by HR: separate table, approval-backed, references raw event when correcting one.
CREATE TABLE attendance_corrections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  attendance_date   date NOT NULL,
  raw_event_id      uuid REFERENCES attendance_raw_events(id),   -- null when adding a missing punch
  correction_type   text NOT NULL,                  -- ADD_PUNCH | IGNORE_PUNCH | CHANGE_DIRECTION | OVERRIDE_DAY
  punched_at        timestamptz,
  direction         punch_direction,
  override_status   day_status,
  override_worked_minutes integer,
  reason            text NOT NULL,
  requested_by      uuid NOT NULL REFERENCES users(id),
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  workflow_instance_id uuid,
  status            text NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | REJECTED
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attendance_corrections_emp_date_idx ON attendance_corrections(employee_id, attendance_date);
CREATE TRIGGER attendance_corrections_updated_at BEFORE UPDATE ON attendance_corrections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Processed (deduplicated, mapped, direction-resolved) events. Rebuildable from raw + corrections.
CREATE TABLE attendance_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  raw_event_id      uuid REFERENCES attendance_raw_events(id),
  correction_id     uuid REFERENCES attendance_corrections(id),
  attendance_date   date NOT NULL,                   -- the shift/business date this punch belongs to (may differ from calendar date for overnight shifts)
  punched_at        timestamptz NOT NULL,
  direction         punch_direction NOT NULL,        -- resolved (never UNKNOWN here)
  device_id         uuid REFERENCES devices(id),
  site_id           uuid REFERENCES sites(id),
  is_ignored        boolean NOT NULL DEFAULT false,
  ignore_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (raw_event_id IS NOT NULL OR correction_id IS NOT NULL)
);
CREATE UNIQUE INDEX attendance_events_raw_uidx ON attendance_events(raw_event_id) WHERE raw_event_id IS NOT NULL;
CREATE INDEX attendance_events_emp_date_idx ON attendance_events(employee_id, attendance_date);

-- One row per employee per day. Output of the attendance engine. Rebuildable.
CREATE TABLE attendance_daily (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         uuid NOT NULL REFERENCES employees(id),
  attendance_date     date NOT NULL,
  shift_id            uuid,                          -- FK added in 0007
  site_id             uuid REFERENCES sites(id),
  project_id          uuid REFERENCES projects(id),
  status              day_status NOT NULL,
  first_in_at         timestamptz,
  last_out_at         timestamptz,
  scheduled_start_at  timestamptz,
  scheduled_end_at    timestamptz,
  scheduled_minutes   integer NOT NULL DEFAULT 0,
  worked_minutes      integer NOT NULL DEFAULT 0,    -- gross presence (first in → last out) minus unpaid break
  break_minutes       integer NOT NULL DEFAULT 0,
  net_worked_minutes  integer NOT NULL DEFAULT 0,    -- counted toward normal hours (capped at scheduled)
  late_minutes        integer NOT NULL DEFAULT 0,
  early_leave_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes    integer NOT NULL DEFAULT 0,    -- computed by rules (pre-approval)
  approved_overtime_minutes integer NOT NULL DEFAULT 0,
  holiday_minutes     integer NOT NULL DEFAULT 0,
  weekend_minutes     integer NOT NULL DEFAULT 0,
  leave_request_id    uuid,                          -- FK added in 0008
  leave_type_code     text,
  is_paid_day         boolean NOT NULL DEFAULT true,
  punch_count         integer NOT NULL DEFAULT 0,
  is_manual_override  boolean NOT NULL DEFAULT false,
  override_correction_id uuid REFERENCES attendance_corrections(id),
  calculation_version integer NOT NULL DEFAULT 1,
  calculated_at       timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,                   -- set when the timesheet containing this day is locked
  UNIQUE (employee_id, attendance_date)
);
CREATE INDEX attendance_daily_date_idx ON attendance_daily(attendance_date);
CREATE INDEX attendance_daily_site_date_idx ON attendance_daily(site_id, attendance_date);
CREATE INDEX attendance_daily_status_date_idx ON attendance_daily(status, attendance_date);

CREATE TABLE attendance_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid REFERENCES employees(id),
  attendance_date date NOT NULL,
  exception_type  attendance_exception_type NOT NULL,
  status          exception_status NOT NULL DEFAULT 'OPEN',
  severity        text NOT NULL DEFAULT 'MEDIUM',     -- LOW | MEDIUM | HIGH
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_event_id    uuid REFERENCES attendance_raw_events(id),
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, attendance_date, exception_type, raw_event_id)
);
CREATE INDEX attendance_exceptions_open_idx ON attendance_exceptions(status, attendance_date DESC) WHERE status IN ('OPEN','IN_REVIEW');
CREATE INDEX attendance_exceptions_emp_idx ON attendance_exceptions(employee_id, attendance_date DESC);
CREATE TRIGGER attendance_exceptions_updated_at BEFORE UPDATE ON attendance_exceptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ingestion batches (for reconciliation: what arrived vs what got processed)
CREATE TABLE attendance_ingest_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          event_source NOT NULL,
  device_id       uuid REFERENCES devices(id),
  received_count  integer NOT NULL DEFAULT 0,
  inserted_count  integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  rejected_count  integer NOT NULL DEFAULT 0,
  actor_user_id   uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
