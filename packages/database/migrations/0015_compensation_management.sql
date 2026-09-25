-- 0015: Compensation & Salary Management
--
-- Builds on the existing job architecture (grades, designations.default_grade_id = job-title → grade mapping),
-- versioned salary structures (employee_salary_structures = salary history), HR requests + generic workflow engine
-- (approval chains) and the immutable audit_logs table. New here:
--   salary_bands (effective-dated band history per grade; grades.min/mid/max stays as the current-band cache),
--   performance_rating_levels, merit_matrices (+cells), promotion_salary_rules, salary_compression_rules,
--   salary_changes (the compensation ledger — one row per salary change, never deleted),
--   promotion_requests, salary_reviews (+items; renamed from increment_cycles/increment_entries and extended),
--   compensation_budgets, compensation_scenarios (+items), compensation_approval_actions (immutable), salary_alerts.
-- Company policy values (bands, thresholds, percentages, rules, budgets) are data — see seed-compensation.ts.

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- non-overlapping effective-dated bands

-- ─── Grades: descriptive fields + soft delete ───────────────────────────────
ALTER TABLE grades
  ADD COLUMN description text,
  ADD COLUMN notes text,
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  ADD COLUMN deleted_at timestamptz;

-- ─── Salary bands (effective-dated) ─────────────────────────────────────────
CREATE TABLE salary_bands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_id        uuid NOT NULL REFERENCES grades(id),
  min_salary      numeric(14,2) NOT NULL,
  mid_salary      numeric(14,2) NOT NULL,
  max_salary      numeric(14,2) NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'AED',
  effective_from  date NOT NULL,
  effective_to    date,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  notes           text,
  created_by      uuid REFERENCES users(id),
  updated_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT salary_bands_order_chk CHECK (min_salary >= 0 AND min_salary <= mid_salary AND mid_salary <= max_salary AND max_salary > 0),
  CONSTRAINT salary_bands_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- at most one ACTIVE band per grade for any date
  CONSTRAINT salary_bands_no_overlap EXCLUDE USING gist (grade_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&) WHERE (status = 'ACTIVE' AND deleted_at IS NULL)
);
CREATE INDEX salary_bands_grade_idx ON salary_bands(grade_id, effective_from DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER salary_bands_updated_at BEFORE UPDATE ON salary_bands FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO salary_bands(grade_id, min_salary, mid_salary, max_salary, currency, effective_from, status, notes)
SELECT id, min_salary, coalesce(mid_salary, round((min_salary + max_salary) / 2, 2)), max_salary, currency, DATE '2000-01-01', 'ACTIVE', 'Migrated from grades (REQUIRES HR CONFIRMATION)'
FROM grades WHERE min_salary IS NOT NULL AND max_salary IS NOT NULL AND max_salary > 0 AND min_salary <= max_salary;

-- ─── Performance rating levels (numeric review score → named rating) ────────
CREATE TABLE performance_rating_levels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  label       text NOT NULL,
  min_score   numeric(5,2) NOT NULL,
  max_score   numeric(5,2) NOT NULL,
  sort_order  integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rating_levels_range_chk CHECK (max_score >= min_score)
);
CREATE TRIGGER performance_rating_levels_updated_at BEFORE UPDATE ON performance_rating_levels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Merit matrix ───────────────────────────────────────────────────────────
CREATE TABLE merit_matrices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  fiscal_year     integer,
  effective_from  date NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  is_default      boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX merit_matrices_one_default ON merit_matrices((true)) WHERE is_default AND deleted_at IS NULL;
CREATE TRIGGER merit_matrices_updated_at BEFORE UPDATE ON merit_matrices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE merit_matrix_cells (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_id       uuid NOT NULL REFERENCES merit_matrices(id) ON DELETE CASCADE,
  rating_code     text NOT NULL REFERENCES performance_rating_levels(code) ON UPDATE CASCADE,
  min_compa       numeric(6,2),
  max_compa       numeric(6,2),
  recommended_pct numeric(6,3) NOT NULL CHECK (recommended_pct >= 0),
  max_pct         numeric(6,3) NOT NULL CHECK (max_pct >= 0),
  CONSTRAINT merit_cells_pct_chk CHECK (recommended_pct <= max_pct),
  CONSTRAINT merit_cells_compa_chk CHECK (min_compa IS NULL OR max_compa IS NULL OR max_compa > min_compa),
  CONSTRAINT merit_cells_unique UNIQUE NULLS NOT DISTINCT (matrix_id, rating_code, min_compa)
);

-- ─── Promotion salary rules ─────────────────────────────────────────────────
CREATE TABLE promotion_salary_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  from_grade_id     uuid REFERENCES grades(id),
  to_grade_id       uuid REFERENCES grades(id),
  method            text NOT NULL CHECK (method IN ('PERCENT_INCREASE', 'TO_MINIMUM', 'TO_MIDPOINT', 'PERCENT_OF_MIDPOINT', 'FIXED_AMOUNT', 'GREATER_OF_PERCENT_OR_MINIMUM')),
  value             numeric(14,3) NOT NULL DEFAULT 0,
  min_increase_pct  numeric(6,3),
  max_increase_pct  numeric(6,3),
  cap_at_max        boolean NOT NULL DEFAULT true,
  priority          integer NOT NULL DEFAULT 100,
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_rules_clamp_chk CHECK (min_increase_pct IS NULL OR max_increase_pct IS NULL OR min_increase_pct <= max_increase_pct)
);
CREATE TRIGGER promotion_salary_rules_updated_at BEFORE UPDATE ON promotion_salary_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Salary compression rules (job hierarchy) ───────────────────────────────
CREATE TABLE salary_compression_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  scope                 text NOT NULL CHECK (scope IN ('DESIGNATION_PAIR', 'GRADE_SEQUENCE', 'JOB_FUNCTION_LEVELS')),
  lower_designation_id  uuid REFERENCES designations(id),
  upper_designation_id  uuid REFERENCES designations(id),
  job_function_id       uuid REFERENCES job_functions(id),
  min_difference_amount numeric(14,2),
  min_difference_pct    numeric(6,3),
  compare               text NOT NULL DEFAULT 'AVERAGE' CHECK (compare IN ('AVERAGE', 'MEDIAN', 'MAX_LOWER_VS_MIN_UPPER')),
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compression_pair_chk CHECK (scope <> 'DESIGNATION_PAIR' OR (lower_designation_id IS NOT NULL AND upper_designation_id IS NOT NULL AND lower_designation_id <> upper_designation_id)),
  CONSTRAINT compression_threshold_chk CHECK (min_difference_amount IS NOT NULL OR min_difference_pct IS NOT NULL)
);

-- ─── Salary reviews (evolved from increment cycles) ─────────────────────────
ALTER TABLE increment_cycles RENAME TO salary_reviews;
ALTER TABLE increment_entries RENAME TO salary_review_items;
ALTER TRIGGER increment_cycles_updated_at ON salary_reviews RENAME TO salary_reviews_updated_at;
UPDATE salary_reviews SET status = CASE status WHEN 'IN_REVIEW' THEN 'UNDER_REVIEW' WHEN 'APPLIED' THEN 'COMPLETED' ELSE status END;
ALTER TABLE salary_reviews
  ADD COLUMN review_period_start date,
  ADD COLUMN review_period_end date,
  ADD COLUMN max_percentage numeric(6,3),
  ADD COLUMN budget_amount numeric(16,2) CHECK (budget_amount IS NULL OR budget_amount >= 0),
  ADD COLUMN currency char(3) NOT NULL DEFAULT 'AED',
  ADD COLUMN eligibility_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN merit_matrix_id uuid REFERENCES merit_matrices(id),
  ADD COLUMN performance_cycle_id uuid REFERENCES performance_cycles(id),
  ADD COLUMN recommendation_method text NOT NULL DEFAULT 'DEFAULT_PERCENT' CHECK (recommendation_method IN ('DEFAULT_PERCENT', 'MERIT_MATRIX')),
  ADD COLUMN default_ceiling_action text CHECK (default_ceiling_action IN ('CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE')),
  ADD COLUMN workflow_instance_id uuid REFERENCES workflow_instances(id),
  ADD COLUMN scenario_id uuid,
  ADD COLUMN submitted_by uuid REFERENCES users(id),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN decision_comment text,
  ADD COLUMN deleted_at timestamptz;
ALTER TABLE salary_reviews ADD CONSTRAINT salary_reviews_status_chk CHECK (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'));
ALTER TABLE salary_reviews ADD CONSTRAINT salary_reviews_pct_chk CHECK (default_percentage >= 0 AND (max_percentage IS NULL OR max_percentage >= default_percentage));
ALTER TABLE salary_reviews ADD CONSTRAINT salary_reviews_period_chk CHECK (review_period_end IS NULL OR review_period_start IS NULL OR review_period_end >= review_period_start);
CREATE UNIQUE INDEX salary_reviews_name_uq ON salary_reviews(lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX salary_reviews_status_idx ON salary_reviews(status, cycle_year);

UPDATE salary_review_items SET status = 'COMPLETED' WHERE status = 'APPLIED';
ALTER TABLE salary_review_items
  ADD COLUMN department_id uuid REFERENCES departments(id),
  ADD COLUMN site_id uuid REFERENCES sites(id),
  ADD COLUMN designation_id uuid REFERENCES designations(id),
  ADD COLUMN grade_id uuid REFERENCES grades(id),
  ADD COLUMN salary_basis text NOT NULL DEFAULT 'BASIC' CHECK (salary_basis IN ('BASIC', 'GROSS')),
  ADD COLUMN current_salary numeric(14,2),
  ADD COLUMN band_min numeric(14,2), ADD COLUMN band_mid numeric(14,2), ADD COLUMN band_max numeric(14,2),
  ADD COLUMN compa_ratio numeric(7,2),
  ADD COLUMN range_penetration numeric(8,2),
  ADD COLUMN rating_code text,
  ADD COLUMN eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN ineligibility_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN recommended_pct numeric(6,3),
  ADD COLUMN matrix_max_pct numeric(6,3),
  ADD COLUMN proposed_salary numeric(14,2),
  ADD COLUMN final_salary numeric(14,2),
  ADD COLUMN exceeds_max_by numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN ceiling_action text CHECK (ceiling_action IN ('CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE')),
  ADD COLUMN outcome text,
  ADD COLUMN requires_exception boolean NOT NULL DEFAULT false,
  ADD COLUMN override_justification text,
  ADD COLUMN overridden_by uuid REFERENCES users(id),
  ADD COLUMN alerts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN salary_change_id uuid,
  ADD COLUMN apply_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE salary_review_items ADD CONSTRAINT salary_review_items_status_chk CHECK (status IN ('PROPOSED', 'EXCLUDED', 'INELIGIBLE', 'APPROVED', 'COMPLETED', 'FAILED', 'CANCELLED'));
CREATE INDEX salary_review_items_review_idx ON salary_review_items(cycle_id, status);
CREATE INDEX salary_review_items_emp_idx ON salary_review_items(employee_id);
CREATE TRIGGER salary_review_items_updated_at BEFORE UPDATE ON salary_review_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Compensation budgets ───────────────────────────────────────────────────
CREATE TABLE compensation_budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  fiscal_year   integer NOT NULL,
  budget_type   text NOT NULL CHECK (budget_type IN ('ANNUAL', 'INCREMENT', 'PROMOTION', 'ADJUSTMENT')),
  scope_type    text NOT NULL DEFAULT 'COMPANY' CHECK (scope_type IN ('COMPANY', 'DEPARTMENT', 'GRADE', 'SITE')),
  scope_id      uuid,
  amount        numeric(16,2) NOT NULL CHECK (amount >= 0),
  currency      char(3) NOT NULL DEFAULT 'AED',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED')),
  notes         text,
  created_by    uuid REFERENCES users(id),
  updated_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT compensation_budgets_scope_chk CHECK ((scope_type = 'COMPANY') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX compensation_budgets_uq ON compensation_budgets(fiscal_year, budget_type, scope_type, scope_id) NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE TRIGGER compensation_budgets_updated_at BEFORE UPDATE ON compensation_budgets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Promotion requests ─────────────────────────────────────────────────────
CREATE SEQUENCE compensation_no_seq START 1;
CREATE TABLE promotion_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_no            text NOT NULL UNIQUE,
  employee_id             uuid NOT NULL REFERENCES employees(id),
  current_designation_id  uuid REFERENCES designations(id),
  current_grade_id        uuid REFERENCES grades(id),
  current_salary          numeric(14,2) NOT NULL CHECK (current_salary >= 0),
  new_designation_id      uuid REFERENCES designations(id),
  new_grade_id            uuid NOT NULL REFERENCES grades(id),
  new_department_id       uuid REFERENCES departments(id),
  recommended_salary      numeric(14,2),
  new_salary              numeric(14,2) NOT NULL CHECK (new_salary >= 0),
  salary_basis            text NOT NULL DEFAULT 'BASIC' CHECK (salary_basis IN ('BASIC', 'GROSS')),
  currency                char(3) NOT NULL DEFAULT 'AED',
  rule_id                 uuid REFERENCES promotion_salary_rules(id),
  rule_explanation        text,
  effective_date          date NOT NULL,
  promotion_reason        text NOT NULL,
  performance_rating_code text,
  performance_score       numeric(4,2),
  manager_recommendation  text,
  hr_comments             text,
  justification           text,
  status                  text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'FAILED')),
  alerts                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  salary_change_id        uuid,
  hr_request_id           uuid REFERENCES hr_requests(id),
  requested_by            uuid REFERENCES users(id),
  submitted_at            timestamptz,
  approved_by             uuid REFERENCES users(id),
  approved_at             timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promotion_requests_emp_idx ON promotion_requests(employee_id, created_at DESC);
CREATE INDEX promotion_requests_status_idx ON promotion_requests(status);
CREATE TRIGGER promotion_requests_updated_at BEFORE UPDATE ON promotion_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Salary changes: the compensation ledger ────────────────────────────────
CREATE TABLE salary_changes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_no               text NOT NULL UNIQUE,                       -- SC-2027-000001
  employee_id             uuid NOT NULL REFERENCES employees(id),
  change_type             text NOT NULL CHECK (change_type IN ('JOINING', 'ANNUAL_INCREMENT', 'PROMOTION', 'MARKET_ADJUSTMENT', 'SALARY_CORRECTION', 'MERIT_INCREASE', 'SPECIAL_ADJUSTMENT', 'DEMOTION_ADJUSTMENT', 'GRADE_CHANGE')),
  status                  text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED', 'FAILED')),
  source                  text NOT NULL DEFAULT 'COMPENSATION' CHECK (source IN ('COMPENSATION', 'REVIEW', 'PROMOTION', 'HR_REQUEST', 'DIRECT', 'MIGRATION')),
  salary_basis            text NOT NULL DEFAULT 'BASIC' CHECK (salary_basis IN ('BASIC', 'GROSS')),
  currency                char(3) NOT NULL DEFAULT 'AED',
  old_salary              numeric(14,2) NOT NULL CHECK (old_salary >= 0),
  increase_amount         numeric(14,2) NOT NULL,
  increase_pct            numeric(8,3) NOT NULL,
  new_salary              numeric(14,2) NOT NULL CHECK (new_salary >= 0),
  old_basic               numeric(14,2), new_basic numeric(14,2), old_gross numeric(14,2), new_gross numeric(14,2),
  annual_cost             numeric(16,2) NOT NULL DEFAULT 0,
  effective_date          date NOT NULL,
  effective_year          integer GENERATED ALWAYS AS (extract(year FROM effective_date)::int) STORED,
  reason                  text NOT NULL,
  comments                text,
  justification           text,
  old_grade_id            uuid REFERENCES grades(id), new_grade_id uuid REFERENCES grades(id),
  old_designation_id      uuid REFERENCES designations(id), new_designation_id uuid REFERENCES designations(id),
  band_id                 uuid REFERENCES salary_bands(id),
  band_min                numeric(14,2), band_mid numeric(14,2), band_max numeric(14,2),
  compa_before            numeric(7,2), compa_after numeric(7,2),
  exceeds_max_by          numeric(14,2) NOT NULL DEFAULT 0,
  ceiling_action          text CHECK (ceiling_action IN ('CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE')),
  requires_exception      boolean NOT NULL DEFAULT false,
  recommended_pct         numeric(6,3),
  is_override             boolean NOT NULL DEFAULT false,               -- recommendation / max % overridden with justification
  duplicate_override      boolean NOT NULL DEFAULT false,               -- authorised second annual increase in the same year
  budget_override         boolean NOT NULL DEFAULT false,
  outside_workflow        boolean NOT NULL DEFAULT false,               -- DIRECT salary edits (flagged on the dashboard)
  alerts                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_id               uuid REFERENCES salary_reviews(id),
  review_item_id          uuid REFERENCES salary_review_items(id),
  promotion_request_id    uuid REFERENCES promotion_requests(id),
  hr_request_id           uuid REFERENCES hr_requests(id),
  salary_structure_id     uuid REFERENCES employee_salary_structures(id),
  requested_by            uuid REFERENCES users(id),
  submitted_at            timestamptz,
  approved_by             uuid REFERENCES users(id),
  approved_at             timestamptz,
  completed_at            timestamptz,
  apply_error             text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salary_changes_justification_chk CHECK (NOT (is_override OR duplicate_override OR budget_override) OR coalesce(length(trim(justification)), 0) > 0)
);
-- Duplicate protection: one live ANNUAL_INCREMENT per employee and effective year (authorised overrides excepted)
CREATE UNIQUE INDEX salary_changes_one_annual_increment ON salary_changes(employee_id, effective_year)
  WHERE change_type = 'ANNUAL_INCREMENT' AND status NOT IN ('REJECTED', 'CANCELLED', 'FAILED') AND NOT duplicate_override;
CREATE INDEX salary_changes_emp_idx ON salary_changes(employee_id, effective_date DESC);
CREATE INDEX salary_changes_status_idx ON salary_changes(status, change_type);
CREATE INDEX salary_changes_year_idx ON salary_changes(effective_year, change_type);
CREATE INDEX salary_changes_review_idx ON salary_changes(review_id) WHERE review_id IS NOT NULL;
CREATE INDEX salary_changes_request_idx ON salary_changes(hr_request_id) WHERE hr_request_id IS NOT NULL;
CREATE TRIGGER salary_changes_updated_at BEFORE UPDATE ON salary_changes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Historical salary records are never deleted; completed changes are frozen.
CREATE OR REPLACE FUNCTION salary_changes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'salary_changes rows are never deleted (cancel instead)'; END IF;
  IF OLD.status IN ('COMPLETED', 'REJECTED', 'CANCELLED') AND (
       NEW.status IS DISTINCT FROM OLD.status OR NEW.old_salary IS DISTINCT FROM OLD.old_salary OR NEW.new_salary IS DISTINCT FROM OLD.new_salary
       OR NEW.effective_date IS DISTINCT FROM OLD.effective_date OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.change_type IS DISTINCT FROM OLD.change_type) THEN
    RAISE EXCEPTION 'salary change % is % and can no longer be modified', OLD.change_no, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER salary_changes_guard BEFORE UPDATE OR DELETE ON salary_changes FOR EACH ROW EXECUTE FUNCTION salary_changes_guard();
CREATE TRIGGER employee_salary_structures_no_delete BEFORE DELETE ON employee_salary_structures FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE salary_review_items ADD CONSTRAINT salary_review_items_change_fk FOREIGN KEY (salary_change_id) REFERENCES salary_changes(id);
ALTER TABLE promotion_requests ADD CONSTRAINT promotion_requests_change_fk FOREIGN KEY (salary_change_id) REFERENCES salary_changes(id);

-- ─── Scenario planning (never touches salaries) ─────────────────────────────
CREATE TABLE compensation_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  description     text,
  fiscal_year     integer NOT NULL,
  method          text NOT NULL CHECK (method IN ('FLAT_PERCENT', 'MERIT_MATRIX', 'PROMOTION_PLUS_INCREMENT', 'BUDGET_LIMITED')),
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CALCULATED', 'CONVERTED', 'ARCHIVED')),
  summary         jsonb,
  calculated_at   timestamptz,
  review_id       uuid REFERENCES salary_reviews(id),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE TRIGGER compensation_scenarios_updated_at BEFORE UPDATE ON compensation_scenarios FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE salary_reviews ADD CONSTRAINT salary_reviews_scenario_fk FOREIGN KEY (scenario_id) REFERENCES compensation_scenarios(id);

CREATE TABLE compensation_scenario_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id         uuid NOT NULL REFERENCES compensation_scenarios(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES employees(id),
  current_salary      numeric(14,2) NOT NULL,
  current_gross       numeric(14,2) NOT NULL,
  increase_pct        numeric(8,3) NOT NULL,
  proposed_salary     numeric(14,2) NOT NULL,
  final_salary        numeric(14,2) NOT NULL,
  increase            numeric(14,2) NOT NULL,
  exceeds_max_by      numeric(14,2) NOT NULL DEFAULT 0,
  requires_exception  boolean NOT NULL DEFAULT false,
  capped              boolean NOT NULL DEFAULT false,
  promoted            boolean NOT NULL DEFAULT false,
  included            boolean NOT NULL DEFAULT true,
  UNIQUE (scenario_id, employee_id)
);

-- ─── Approval actions (immutable, richer than workflow_tasks: role + status transition) ──
CREATE TABLE compensation_approval_actions (
  id                bigserial PRIMARY KEY,
  entity_type       text NOT NULL CHECK (entity_type IN ('salary_change', 'promotion_request', 'salary_review')),
  entity_id         uuid NOT NULL,
  user_id           uuid REFERENCES users(id),
  user_name         text,
  role_code         text,
  action            text NOT NULL,                  -- CREATE | SUBMIT | APPROVE | REJECT | CANCEL | COMPLETE | FAIL | OVERRIDE
  step_key          text,
  comment           text,
  previous_status   text,
  new_status        text NOT NULL,
  workflow_task_id  uuid REFERENCES workflow_tasks(id),
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compensation_approval_actions_entity_idx ON compensation_approval_actions(entity_type, entity_id, occurred_at);
CREATE TRIGGER compensation_approval_actions_immutable BEFORE UPDATE OR DELETE ON compensation_approval_actions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ─── Salary alerts (persisted for acknowledgement / trend; rebuilt by the scan job) ──
CREATE TABLE salary_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type        text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('CRITICAL', 'WARNING', 'INFO')),
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  employee_id       uuid REFERENCES employees(id),
  grade_id          uuid REFERENCES grades(id),
  designation_id    uuid REFERENCES designations(id),
  message           text NOT NULL,
  details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint       text NOT NULL,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at  timestamptz NOT NULL DEFAULT now(),
  acknowledged_by   uuid REFERENCES users(id),
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  resolution_note   text
);
CREATE UNIQUE INDEX salary_alerts_live_uq ON salary_alerts(fingerprint) WHERE status <> 'RESOLVED';
CREATE INDEX salary_alerts_type_idx ON salary_alerts(alert_type, status);
CREATE INDEX salary_alerts_emp_idx ON salary_alerts(employee_id) WHERE employee_id IS NOT NULL;
