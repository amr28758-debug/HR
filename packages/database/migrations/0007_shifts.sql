-- 0007: shifts, rules, work patterns, assignments

CREATE TABLE shifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  name_ar             text,
  shift_type          shift_type NOT NULL DEFAULT 'FIXED',
  start_time          time NOT NULL,                  -- local site time
  end_time            time NOT NULL,                  -- if <= start_time → crosses midnight
  crosses_midnight    boolean GENERATED ALWAYS AS (end_time <= start_time) STORED,
  required_minutes    integer NOT NULL,               -- e.g. 480 (8h)
  break_minutes       integer NOT NULL DEFAULT 60,
  break_is_paid       boolean NOT NULL DEFAULT false,
  break_start_time    time,
  break_end_time      time,
  grace_in_minutes    integer NOT NULL DEFAULT 15,
  grace_out_minutes   integer NOT NULL DEFAULT 0,
  early_in_window_minutes integer NOT NULL DEFAULT 120,   -- punches this long before start still belong to this shift date
  late_out_window_minutes integer NOT NULL DEFAULT 360,   -- punches this long after end still belong to this shift date
  half_day_threshold_minutes integer,                     -- worked < this → HALF_DAY (null = disabled)
  absent_threshold_minutes integer NOT NULL DEFAULT 0,    -- worked <= this → ABSENT
  ot_enabled          boolean NOT NULL DEFAULT true,
  ot_after_minutes    integer,                            -- OT counts after this many worked minutes (default: required_minutes)
  ot_min_block_minutes integer NOT NULL DEFAULT 30,       -- OT below this is ignored
  ot_max_minutes_per_day integer,                         -- OT above this flagged EXCESSIVE_OT
  ot_rounding_minutes integer NOT NULL DEFAULT 15,        -- round OT down to multiple of this
  ot_requires_approval boolean NOT NULL DEFAULT true,
  count_early_in_as_ot boolean NOT NULL DEFAULT false,
  timezone            text NOT NULL DEFAULT 'Asia/Dubai',
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE TRIGGER shifts_updated_at BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Additional named rules layered on shifts/sites/employees (config, not code). Evaluated by rule engine in @burtplace/core.
CREATE TABLE shift_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL,                          -- SHIFT | SITE | EMPLOYEE | GLOBAL
  scope_id    uuid,
  rule_type   text NOT NULL,                          -- LATE_DEDUCTION | OT_MULTIPLIER | WEEKEND_OT | HOLIDAY_OT | ...
  config      jsonb NOT NULL,
  priority    integer NOT NULL DEFAULT 100,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shift_rules_scope_idx ON shift_rules(scope, scope_id);

-- Work pattern: which weekdays are working days + optional per-weekday shift. 7 entries in JSON: [{dow:0..6, working:true, shiftId}]
CREATE TABLE work_patterns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  week_offs   smallint[] NOT NULL DEFAULT '{5}',       -- ISO-ish: 0=Sun..6=Sat. Friday off = {5}; Sat+Sun off = {6,0}
  default_shift_id uuid REFERENCES shifts(id),
  weekday_shifts jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"0": "<shiftId>", ...} overrides per weekday
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER work_patterns_updated_at BEFORE UPDATE ON work_patterns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Assignments can target a site (default for everyone at the site), a project, or an individual employee (exception). Employee wins.
CREATE TABLE shift_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid REFERENCES employees(id) ON DELETE CASCADE,
  site_id         uuid REFERENCES sites(id),
  project_id      uuid REFERENCES projects(id),
  work_pattern_id uuid REFERENCES work_patterns(id),
  shift_id        uuid REFERENCES shifts(id),          -- direct shift override (single shift every working day)
  effective_from  date NOT NULL,
  effective_to    date,
  priority        integer NOT NULL DEFAULT 0,          -- higher wins among same scope
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(employee_id, site_id, project_id) = 1),
  CHECK (work_pattern_id IS NOT NULL OR shift_id IS NOT NULL)
);
CREATE INDEX shift_assignments_emp_idx ON shift_assignments(employee_id, effective_from DESC);
CREATE INDEX shift_assignments_site_idx ON shift_assignments(site_id, effective_from DESC);
CREATE INDEX shift_assignments_project_idx ON shift_assignments(project_id, effective_from DESC);

ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id);
