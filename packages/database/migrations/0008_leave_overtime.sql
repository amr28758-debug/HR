-- 0008: leave & overtime

CREATE TABLE leave_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,               -- ANNUAL, SICK, UNPAID, EMERGENCY, MATERNITY, PATERNITY, COMPASSIONATE, OTHER
  name          text NOT NULL,
  name_ar       text,
  is_paid       boolean NOT NULL DEFAULT true,
  pay_percentage numeric(5,2) NOT NULL DEFAULT 100,  -- e.g. sick leave tiers → handled by leave_policies
  affects_attendance boolean NOT NULL DEFAULT true,
  requires_attachment boolean NOT NULL DEFAULT false,
  color         text,
  sort_order    integer NOT NULL DEFAULT 100,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leave_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_type_id     uuid NOT NULL REFERENCES leave_types(id),
  code              text NOT NULL UNIQUE,
  name              text NOT NULL,
  applies_to        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {employmentTypes:[], grades:[], siteIds:[]} empty = all
  annual_entitlement_days numeric(6,2) NOT NULL DEFAULT 0,
  accrual_method    text NOT NULL DEFAULT 'MONTHLY',       -- NONE | MONTHLY | DAILY | YEARLY_UPFRONT
  accrual_starts_after_days integer NOT NULL DEFAULT 0,
  max_carry_forward_days numeric(6,2) NOT NULL DEFAULT 0,
  carry_forward_expiry_months integer,
  max_balance_days  numeric(6,2),
  allow_negative_days numeric(6,2) NOT NULL DEFAULT 0,
  encashable        boolean NOT NULL DEFAULT false,
  min_notice_days   integer NOT NULL DEFAULT 0,
  count_week_offs   boolean NOT NULL DEFAULT false,        -- do week offs inside a leave period consume balance?
  count_holidays    boolean NOT NULL DEFAULT false,
  is_statutory      boolean NOT NULL DEFAULT false,        -- statutory minimum (legal) vs company policy
  effective_from    date NOT NULL DEFAULT CURRENT_DATE,
  effective_to      date,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leave_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id   uuid NOT NULL REFERENCES leave_types(id),
  period_year     integer NOT NULL,
  opening_days    numeric(7,2) NOT NULL DEFAULT 0,
  accrued_days    numeric(7,2) NOT NULL DEFAULT 0,
  used_days       numeric(7,2) NOT NULL DEFAULT 0,
  pending_days    numeric(7,2) NOT NULL DEFAULT 0,
  adjusted_days   numeric(7,2) NOT NULL DEFAULT 0,
  encashed_days   numeric(7,2) NOT NULL DEFAULT 0,
  balance_days    numeric(7,2) GENERATED ALWAYS AS (opening_days + accrued_days + adjusted_days - used_days - encashed_days) STORED,
  last_accrued_at date,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, leave_type_id, period_year)
);
CREATE TRIGGER leave_balances_updated_at BEFORE UPDATE ON leave_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE leave_balance_transactions (
  id            bigserial PRIMARY KEY,
  balance_id    uuid NOT NULL REFERENCES leave_balances(id) ON DELETE CASCADE,
  txn_type      text NOT NULL,                    -- ACCRUAL | USAGE | REVERSAL | ADJUSTMENT | CARRY_FORWARD | ENCASHMENT
  days          numeric(7,2) NOT NULL,
  reference_id  uuid,
  note          text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leave_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  leave_type_id   uuid NOT NULL REFERENCES leave_types(id),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  is_half_day     boolean NOT NULL DEFAULT false,
  half_day_part   text,                           -- AM | PM
  total_days      numeric(6,2) NOT NULL,          -- computed at submit per policy (week offs/holidays)
  reason          text,
  attachment_object_key text,
  status          leave_request_status NOT NULL DEFAULT 'PENDING',
  workflow_instance_id uuid,
  requested_by    uuid REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text,
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX leave_requests_emp_idx ON leave_requests(employee_id, start_date DESC);
CREATE INDEX leave_requests_status_idx ON leave_requests(status) WHERE status = 'PENDING';
CREATE INDEX leave_requests_range_idx ON leave_requests(start_date, end_date) WHERE status = 'APPROVED';
CREATE TRIGGER leave_requests_updated_at BEFORE UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_leave_fk FOREIGN KEY (leave_request_id) REFERENCES leave_requests(id);

CREATE TABLE overtime_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  day_kind        text NOT NULL,                  -- NORMAL | WEEK_OFF | PUBLIC_HOLIDAY
  multiplier      numeric(5,3) NOT NULL DEFAULT 1.25,
  scope           text NOT NULL DEFAULT 'GLOBAL', -- GLOBAL | SITE | PROJECT | EMPLOYEE
  scope_id        uuid,
  min_minutes     integer NOT NULL DEFAULT 30,
  max_minutes_per_day integer,
  max_minutes_per_month integer,
  rounding_minutes integer NOT NULL DEFAULT 15,
  requires_manager_approval boolean NOT NULL DEFAULT true,
  requires_hr_approval_over_minutes integer,      -- e.g. > 120 → HR approval too
  is_statutory    boolean NOT NULL DEFAULT false,
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,
  priority        integer NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE overtime_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  attendance_date   date NOT NULL,
  attendance_daily_id uuid REFERENCES attendance_daily(id),
  requested_minutes integer NOT NULL CHECK (requested_minutes > 0),
  approved_minutes  integer,
  day_kind          text NOT NULL DEFAULT 'NORMAL',
  overtime_rule_id  uuid REFERENCES overtime_rules(id),
  multiplier        numeric(5,3),
  reason            text,
  status            overtime_request_status NOT NULL DEFAULT 'PENDING',
  workflow_instance_id uuid,
  requested_by      uuid REFERENCES users(id),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, attendance_date)
);
CREATE INDEX overtime_requests_status_idx ON overtime_requests(status) WHERE status = 'PENDING';
CREATE TRIGGER overtime_requests_updated_at BEFORE UPDATE ON overtime_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
