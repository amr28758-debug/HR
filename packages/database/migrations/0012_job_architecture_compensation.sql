-- 0012: job architecture (families → functions → titles → grades → career levels), job descriptions,
--       HR requests (business actions with approval), deductions, bonuses, loan schedules, increment cycles

CREATE TABLE career_levels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,              -- L1..L10
  name        text NOT NULL,
  name_ar     text,
  rank        integer NOT NULL,                  -- ordering (1 = entry)
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  name_ar     text,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_functions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_family_id uuid NOT NULL REFERENCES job_families(id),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  name_ar       text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,          -- G1..G12
  name            text NOT NULL,
  career_level_id uuid REFERENCES career_levels(id),
  min_salary      numeric(14,2),
  mid_salary      numeric(14,2),
  max_salary      numeric(14,2),
  currency        char(3) NOT NULL DEFAULT 'AED',
  sort_order      integer NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER grades_updated_at BEFORE UPDATE ON grades FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Designations are the job titles; link them into the architecture.
ALTER TABLE designations
  ADD COLUMN job_family_id uuid REFERENCES job_families(id),
  ADD COLUMN job_function_id uuid REFERENCES job_functions(id),
  ADD COLUMN default_grade_id uuid REFERENCES grades(id),
  ADD COLUMN career_level_id uuid REFERENCES career_levels(id);

CREATE TABLE job_descriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text NOT NULL UNIQUE,   -- JD-CIV-SE
  designation_id          uuid NOT NULL REFERENCES designations(id),
  department_id           uuid REFERENCES departments(id),
  job_family_id           uuid REFERENCES job_families(id),
  job_function_id         uuid REFERENCES job_functions(id),
  grade_id                uuid REFERENCES grades(id),
  career_level_id         uuid REFERENCES career_levels(id),
  reports_to_designation_id uuid REFERENCES designations(id),
  location                text,
  status                  text NOT NULL DEFAULT 'DRAFT',   -- DRAFT | APPROVED | RETIRED
  current_version         integer NOT NULL DEFAULT 0,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER job_descriptions_updated_at BEFORE UPDATE ON job_descriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Versions are immutable once approved.
CREATE TABLE job_description_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_description_id      uuid NOT NULL REFERENCES job_descriptions(id) ON DELETE CASCADE,
  version                 integer NOT NULL,
  effective_from          date NOT NULL,
  purpose                 text,
  responsibilities        jsonb NOT NULL DEFAULT '[]'::jsonb,
  duties                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  qualifications          jsonb NOT NULL DEFAULT '[]'::jsonb,
  experience              text,
  skills                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  technical_competencies  jsonb NOT NULL DEFAULT '[]'::jsonb,
  behavioural_competencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  kpis                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_certifications jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                  text NOT NULL DEFAULT 'DRAFT',   -- DRAFT | APPROVED | SUPERSEDED
  approved_by             uuid REFERENCES users(id),
  approved_at             timestamptz,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_description_id, version)
);

ALTER TABLE employees
  ADD COLUMN job_family_id uuid REFERENCES job_families(id),
  ADD COLUMN job_function_id uuid REFERENCES job_functions(id),
  ADD COLUMN grade_id uuid REFERENCES grades(id),
  ADD COLUMN career_level_id uuid REFERENCES career_levels(id),
  ADD COLUMN job_description_version_id uuid REFERENCES job_description_versions(id),
  ADD COLUMN notice_period_days integer,
  ADD COLUMN resignation_date date,
  ADD COLUMN exit_reason text;

ALTER TABLE employment_history
  ADD COLUMN grade_id uuid REFERENCES grades(id),
  ADD COLUMN career_level_id uuid REFERENCES career_levels(id),
  ADD COLUMN hr_request_id uuid;

-- ═══════════════════════════════════════════════════════════════════════════
-- HR REQUESTS — every business action that needs approval (promotion, transfer, salary change, loan,
-- advance, bonus, deduction, letter, document, increment, resignation…). One request table, typed payload,
-- generic workflow, side-effects applied by the API on approval.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE hr_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no          text NOT NULL UNIQUE,                 -- HR-2026-000123
  request_type        text NOT NULL,                        -- PROMOTION | TRANSFER | SALARY_CHANGE | INCREMENT | LOAN | ADVANCE | BONUS | DEDUCTION | LETTER | DOCUMENT | TRAINING | RESIGNATION | TERMINATION | OTHER
  employee_id         uuid NOT NULL REFERENCES employees(id),
  title               text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- proposed changes (typed per request_type)
  before_snapshot     jsonb,                                -- values at request time (for "what changed")
  effective_date      date,
  reason              text,
  status              text NOT NULL DEFAULT 'PENDING',      -- PENDING | APPROVED | REJECTED | CANCELLED | APPLIED | FAILED
  workflow_instance_id uuid REFERENCES workflow_instances(id),
  requested_by        uuid REFERENCES users(id),
  decided_by          uuid REFERENCES users(id),
  decided_at          timestamptz,
  applied_at          timestamptz,
  apply_error         text,
  result              jsonb,                                -- ids created by application
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE hr_request_no_seq START 1;
CREATE INDEX hr_requests_emp_idx ON hr_requests(employee_id, created_at DESC);
CREATE INDEX hr_requests_status_idx ON hr_requests(status, request_type);
CREATE TRIGGER hr_requests_updated_at BEFORE UPDATE ON hr_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE employee_salary_structures ADD COLUMN hr_request_id uuid REFERENCES hr_requests(id), ADD COLUMN source text NOT NULL DEFAULT 'MANUAL';  -- MANUAL | PROMOTION | INCREMENT | SALARY_CHANGE | MIGRATION

-- Deductions center: every non-attendance deduction feeding payroll
CREATE TABLE employee_deductions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  component_id    uuid NOT NULL REFERENCES salary_components(id),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  reason          text NOT NULL,
  deduction_date  date NOT NULL DEFAULT CURRENT_DATE,
  period_year     integer NOT NULL,
  period_month    integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  source          text NOT NULL DEFAULT 'MANUAL',      -- MANUAL | ASSET_DAMAGE | LOAN | ADVANCE | DISCIPLINARY | OTHER
  status          text NOT NULL DEFAULT 'PENDING',     -- PENDING | APPROVED | APPLIED | REJECTED | CANCELLED
  hr_request_id   uuid REFERENCES hr_requests(id),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  payroll_run_id  uuid REFERENCES payroll_runs(id),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_deductions_period_idx ON employee_deductions(period_year, period_month, status);
CREATE INDEX employee_deductions_emp_idx ON employee_deductions(employee_id);

CREATE TABLE employee_bonuses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  bonus_type      text NOT NULL,                        -- lookup BONUS_TYPE code
  component_id    uuid NOT NULL REFERENCES salary_components(id),
  amount          numeric(14,2),
  percentage      numeric(7,4),                         -- of basic when amount is null
  reason          text NOT NULL,
  period_year     integer NOT NULL,
  period_month    integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  is_recurring    boolean NOT NULL DEFAULT false,
  recurring_months integer,
  status          text NOT NULL DEFAULT 'PENDING',      -- PENDING | APPROVED | APPLIED | REJECTED | CANCELLED
  hr_request_id   uuid REFERENCES hr_requests(id),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  payroll_run_id  uuid REFERENCES payroll_runs(id),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_bonuses_period_idx ON employee_bonuses(period_year, period_month, status);
CREATE INDEX employee_bonuses_emp_idx ON employee_bonuses(employee_id);

ALTER TABLE employee_loans
  ADD COLUMN end_period date,
  ADD COLUMN reason text,
  ADD COLUMN hr_request_id uuid REFERENCES hr_requests(id),
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz;

CREATE TABLE loan_installments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
  period_year     integer NOT NULL,
  period_month    integer NOT NULL,
  amount          numeric(14,2) NOT NULL,
  status          text NOT NULL DEFAULT 'SCHEDULED',    -- SCHEDULED | DEDUCTED | SKIPPED | WAIVED
  payroll_run_id  uuid REFERENCES payroll_runs(id),
  UNIQUE (loan_id, period_year, period_month)
);

CREATE TABLE increment_cycles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  cycle_year      integer NOT NULL,
  effective_date  date NOT NULL,
  default_percentage numeric(6,3) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'DRAFT',        -- DRAFT | IN_REVIEW | APPROVED | APPLIED | CANCELLED
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes           text,
  created_by      uuid REFERENCES users(id),
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  applied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER increment_cycles_updated_at BEFORE UPDATE ON increment_cycles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE increment_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id            uuid NOT NULL REFERENCES increment_cycles(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES employees(id),
  current_basic       numeric(14,2) NOT NULL,
  current_gross       numeric(14,2) NOT NULL,
  performance_rating  numeric(4,2),
  grade_code          text,
  proposed_percentage numeric(6,3) NOT NULL DEFAULT 0,
  proposed_amount     numeric(14,2) NOT NULL DEFAULT 0,
  new_basic           numeric(14,2) NOT NULL,
  new_gross           numeric(14,2) NOT NULL,
  status              text NOT NULL DEFAULT 'PROPOSED',  -- PROPOSED | EXCLUDED | APPROVED | APPLIED
  note                text,
  hr_request_id       uuid REFERENCES hr_requests(id),
  applied_salary_structure_id uuid REFERENCES employee_salary_structures(id),
  UNIQUE (cycle_id, employee_id)
);
