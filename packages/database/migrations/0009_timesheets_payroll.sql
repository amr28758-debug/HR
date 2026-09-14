-- 0009: timesheets and payroll

CREATE TABLE timesheets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  period_year       integer NOT NULL,
  period_month      integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  status            timesheet_status NOT NULL DEFAULT 'GENERATED',
  site_id           uuid REFERENCES sites(id),
  project_id        uuid REFERENCES projects(id),
  department_id     uuid REFERENCES departments(id),
  cost_center_id    uuid REFERENCES cost_centers(id),
  calendar_days     integer NOT NULL,
  scheduled_days    integer NOT NULL DEFAULT 0,
  present_days      numeric(6,2) NOT NULL DEFAULT 0,
  absent_days       numeric(6,2) NOT NULL DEFAULT 0,
  paid_leave_days   numeric(6,2) NOT NULL DEFAULT 0,
  unpaid_leave_days numeric(6,2) NOT NULL DEFAULT 0,
  week_off_days     integer NOT NULL DEFAULT 0,
  holiday_days      integer NOT NULL DEFAULT 0,
  missing_punch_days integer NOT NULL DEFAULT 0,
  scheduled_minutes integer NOT NULL DEFAULT 0,
  worked_minutes    integer NOT NULL DEFAULT 0,
  normal_minutes    integer NOT NULL DEFAULT 0,
  overtime_minutes  integer NOT NULL DEFAULT 0,          -- approved only
  unapproved_overtime_minutes integer NOT NULL DEFAULT 0,
  weekend_ot_minutes integer NOT NULL DEFAULT 0,
  holiday_ot_minutes integer NOT NULL DEFAULT 0,
  late_minutes      integer NOT NULL DEFAULT 0,
  early_leave_minutes integer NOT NULL DEFAULT 0,
  late_count        integer NOT NULL DEFAULT 0,
  adjustments       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{code, minutes|days, note, by, at}]
  generated_at      timestamptz NOT NULL DEFAULT now(),
  submitted_by      uuid REFERENCES users(id),
  submitted_at      timestamptz,
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  locked_at         timestamptz,
  payroll_run_id    uuid,
  UNIQUE (employee_id, period_year, period_month)
);
CREATE INDEX timesheets_period_idx ON timesheets(period_year, period_month);

CREATE TABLE timesheet_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id      uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  attendance_date   date NOT NULL,
  attendance_daily_id uuid REFERENCES attendance_daily(id),
  status            day_status NOT NULL,
  scheduled_minutes integer NOT NULL DEFAULT 0,
  worked_minutes    integer NOT NULL DEFAULT 0,
  normal_minutes    integer NOT NULL DEFAULT 0,
  overtime_minutes  integer NOT NULL DEFAULT 0,
  late_minutes      integer NOT NULL DEFAULT 0,
  early_leave_minutes integer NOT NULL DEFAULT 0,
  day_kind          text NOT NULL DEFAULT 'NORMAL',       -- NORMAL | WEEK_OFF | PUBLIC_HOLIDAY
  leave_type_code   text,
  is_paid           boolean NOT NULL DEFAULT true,
  UNIQUE (timesheet_id, attendance_date)
);

CREATE TABLE payroll_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,                  -- PR-2026-09
  period_year       integer NOT NULL,
  period_month      integer NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  payment_date      date,
  status            payroll_run_status NOT NULL DEFAULT 'DRAFT',
  policy_id         uuid REFERENCES payroll_policies(id),
  currency          char(3) NOT NULL DEFAULT 'AED',
  employee_count    integer NOT NULL DEFAULT 0,
  total_gross       numeric(16,2) NOT NULL DEFAULT 0,
  total_earnings    numeric(16,2) NOT NULL DEFAULT 0,
  total_deductions  numeric(16,2) NOT NULL DEFAULT 0,
  total_net         numeric(16,2) NOT NULL DEFAULT 0,
  filters           jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {siteIds, departmentIds...}
  notes             text,
  created_by        uuid REFERENCES users(id),
  hr_reviewed_by    uuid REFERENCES users(id),
  hr_reviewed_at    timestamptz,
  finance_reviewed_by uuid REFERENCES users(id),
  finance_reviewed_at timestamptz,
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  locked_by         uuid REFERENCES users(id),
  locked_at         timestamptz,
  paid_at           timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_year, period_month)
);
CREATE TRIGGER payroll_runs_updated_at BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE timesheets ADD CONSTRAINT timesheets_payroll_run_fk FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id);

CREATE TABLE payroll_employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id      uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES employees(id),
  timesheet_id        uuid REFERENCES timesheets(id),
  salary_structure_id uuid REFERENCES employee_salary_structures(id),
  -- snapshot for audit/reporting (payroll must be reproducible even if master data changes later)
  employee_no         text NOT NULL,
  employee_name       text NOT NULL,
  department_id       uuid REFERENCES departments(id),
  site_id             uuid REFERENCES sites(id),
  project_id          uuid REFERENCES projects(id),
  cost_center_id      uuid REFERENCES cost_centers(id),
  basic_salary        numeric(14,2) NOT NULL,
  gross_salary        numeric(14,2) NOT NULL,
  daily_rate          numeric(14,4) NOT NULL,
  hourly_rate         numeric(14,4) NOT NULL,
  worked_days         numeric(6,2) NOT NULL DEFAULT 0,
  paid_days           numeric(6,2) NOT NULL DEFAULT 0,
  unpaid_leave_days   numeric(6,2) NOT NULL DEFAULT 0,
  absent_days         numeric(6,2) NOT NULL DEFAULT 0,
  overtime_minutes    integer NOT NULL DEFAULT 0,
  total_earnings      numeric(14,2) NOT NULL DEFAULT 0,
  total_deductions    numeric(14,2) NOT NULL DEFAULT 0,
  net_salary          numeric(14,2) NOT NULL DEFAULT 0,
  bank_iban           text,
  calculation_trace   jsonb,                                 -- every formula input/output for auditability
  has_exceptions      boolean NOT NULL DEFAULT false,
  exceptions          jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id)
);
CREATE INDEX payroll_employees_emp_idx ON payroll_employees(employee_id);

CREATE TABLE payroll_earnings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_employee_id uuid NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  component_id        uuid NOT NULL REFERENCES salary_components(id),
  component_code      text NOT NULL,
  description         text,
  quantity            numeric(12,4),                         -- hours/days when applicable
  rate                numeric(14,4),
  amount              numeric(14,2) NOT NULL,
  is_adjustment       boolean NOT NULL DEFAULT false,
  adjustment_id       uuid
);
CREATE INDEX payroll_earnings_pe_idx ON payroll_earnings(payroll_employee_id);

CREATE TABLE payroll_deductions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_employee_id uuid NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  component_id        uuid NOT NULL REFERENCES salary_components(id),
  component_code      text NOT NULL,
  description         text,
  quantity            numeric(12,4),
  rate                numeric(14,4),
  amount              numeric(14,2) NOT NULL,
  is_adjustment       boolean NOT NULL DEFAULT false,
  adjustment_id       uuid
);
CREATE INDEX payroll_deductions_pe_idx ON payroll_deductions(payroll_employee_id);

-- After a run is LOCKED, changes only via adjustment requests applied to a later run.
CREATE TABLE payroll_adjustments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  component_id      uuid NOT NULL REFERENCES salary_components(id),
  origin_run_id     uuid REFERENCES payroll_runs(id),         -- the locked run this corrects
  target_run_id     uuid REFERENCES payroll_runs(id),         -- run in which it is applied
  amount            numeric(14,2) NOT NULL,
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING',          -- PENDING | APPROVED | REJECTED | APPLIED
  workflow_instance_id uuid,
  requested_by      uuid REFERENCES users(id),
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  applied_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_adjustments_status_idx ON payroll_adjustments(status);

CREATE TABLE payslips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_employee_id uuid NOT NULL UNIQUE REFERENCES payroll_employees(id) ON DELETE CASCADE,
  payslip_no          text NOT NULL UNIQUE,
  object_key          text,                                    -- PDF in object storage
  locale              text NOT NULL DEFAULT 'en',
  generated_at        timestamptz NOT NULL DEFAULT now(),
  published_at        timestamptz,
  viewed_at           timestamptz
);

-- Loans / advances feeding deductions
CREATE TABLE employee_loans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  loan_type       text NOT NULL DEFAULT 'LOAN',             -- LOAN | ADVANCE
  principal       numeric(14,2) NOT NULL,
  installment     numeric(14,2) NOT NULL,
  outstanding     numeric(14,2) NOT NULL,
  start_period    date NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE',           -- ACTIVE | PAUSED | CLOSED
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER employee_loans_updated_at BEFORE UPDATE ON employee_loans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
