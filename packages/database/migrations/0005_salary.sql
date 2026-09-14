-- 0005: salary components and employee salary structures (versioned)

CREATE TABLE salary_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,          -- BASIC, HOUSING, TRANSPORT, FOOD, COMMUNICATION, OTHER, OT, BONUS, UNPAID_LEAVE, ABSENCE, LATE, LOAN...
  name          text NOT NULL,
  name_ar       text,
  kind          salary_component_kind NOT NULL,
  calc_method   calc_method NOT NULL DEFAULT 'FIXED',
  formula       text,                           -- for FORMULA: expression over variables (see @burtplace/core formula engine)
  is_fixed_pay  boolean NOT NULL DEFAULT false, -- part of monthly gross (basic + allowances)
  is_taxable    boolean NOT NULL DEFAULT false,
  is_wps_reportable boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 100,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER salary_components_updated_at BEFORE UPDATE ON salary_components FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Header per version of an employee's salary. Old versions are never edited; new version supersedes.
CREATE TABLE employee_salary_structures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  currency        char(3) NOT NULL DEFAULT 'AED',
  basic_salary    numeric(14,2) NOT NULL CHECK (basic_salary >= 0),
  gross_salary    numeric(14,2) NOT NULL CHECK (gross_salary >= 0),
  reason          text,
  approved_by     uuid REFERENCES users(id),
  workflow_instance_id uuid,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, version)
);
CREATE INDEX ess_emp_effective_idx ON employee_salary_structures(employee_id, effective_from DESC);

CREATE TABLE employee_salary_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salary_structure_id uuid NOT NULL REFERENCES employee_salary_structures(id) ON DELETE CASCADE,
  component_id        uuid NOT NULL REFERENCES salary_components(id),
  amount              numeric(14,2) NOT NULL DEFAULT 0,
  percentage          numeric(7,4),
  UNIQUE (salary_structure_id, component_id)
);

-- Versioned, configurable payroll policy (formulas, divisors, multipliers). Never hard-coded.
CREATE TABLE payroll_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  version         integer NOT NULL,
  name            text NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  is_statutory    boolean NOT NULL DEFAULT false,    -- true = statutory requirement (reviewed by legal); false = company policy
  config          jsonb NOT NULL,                     -- { daysInMonthDivisor: 30, hoursPerDay: 8, otMultipliers: {...}, formulas: {...} }
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
