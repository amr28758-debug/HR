-- 0004: employee master

CREATE SEQUENCE employee_no_seq START 1000;

CREATE TABLE employees (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_no           text NOT NULL UNIQUE,                 -- BP-26-777 (business key, never reused)
  matrix_user_id        text UNIQUE,                          -- biometric device user id (external identifier, NOT primary key)
  zoho_record_id        text UNIQUE,                          -- LEGACY ONLY. Migration source identifier. Removable.
  user_id               uuid UNIQUE REFERENCES users(id),     -- login identity (nullable: site workers without accounts)

  -- personal
  first_name            text NOT NULL,
  middle_name           text,
  last_name             text NOT NULL,
  full_name_en          text GENERATED ALWAYS AS (trim(first_name || ' ' || coalesce(middle_name || ' ', '') || last_name)) STORED,
  full_name_ar          text,
  photo_object_key      text,
  gender                gender NOT NULL DEFAULT 'UNSPECIFIED',
  date_of_birth         date,
  nationality           text,                                 -- ISO 3166-1 alpha-2
  marital_status        marital_status NOT NULL DEFAULT 'UNSPECIFIED',
  mobile                text,
  work_email            citext,
  personal_email        citext,
  emergency_contact_name  text,
  emergency_contact_phone text,
  emergency_contact_relation text,

  -- employment (current snapshot; history in employment_history)
  status                employee_status NOT NULL DEFAULT 'CANDIDATE',
  employment_type       employment_type NOT NULL DEFAULT 'FULL_TIME',
  joining_date          date,
  probation_status      probation_status NOT NULL DEFAULT 'NOT_APPLICABLE',
  probation_end_date    date,
  confirmation_date     date,
  contract_start_date   date,
  contract_end_date     date,
  last_working_date     date,
  department_id         uuid REFERENCES departments(id),
  designation_id        uuid REFERENCES designations(id),
  site_id               uuid REFERENCES sites(id),
  project_id            uuid REFERENCES projects(id),
  cost_center_id        uuid REFERENCES cost_centers(id),
  manager_employee_id   uuid REFERENCES employees(id),
  grade                 text,
  is_office_staff       boolean NOT NULL DEFAULT false,

  -- banking (restricted permission: banking:read)
  bank_name             text,
  bank_account_name     text,
  bank_account_number   text,
  bank_iban             text,
  bank_swift            text,
  wps_person_id         text,                                 -- REQUIRES VENDOR/MOHRE CONFIRMATION: WPS person identifier

  search_vector         tsvector,
  created_by            uuid REFERENCES users(id),
  updated_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE INDEX employees_status_idx ON employees(status) WHERE deleted_at IS NULL;
CREATE INDEX employees_department_idx ON employees(department_id);
CREATE INDEX employees_site_idx ON employees(site_id);
CREATE INDEX employees_project_idx ON employees(project_id);
CREATE INDEX employees_manager_idx ON employees(manager_employee_id);
CREATE INDEX employees_name_trgm_idx ON employees USING gin (full_name_en gin_trgm_ops);
CREATE INDEX employees_no_trgm_idx ON employees USING gin (employee_no gin_trgm_ops);
CREATE INDEX employees_search_idx ON employees USING gin (search_vector);
CREATE TRIGGER employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION employees_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.employee_no, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.middle_name, '') || ' ' || coalesce(NEW.last_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.full_name_ar, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.work_email::text, '') || ' ' || coalesce(NEW.mobile, '') || ' ' || coalesce(NEW.matrix_user_id, '')), 'B');
  RETURN NEW;
END $$;
CREATE TRIGGER employees_search_vector BEFORE INSERT OR UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION employees_search_vector_update();

ALTER TABLE departments ADD CONSTRAINT departments_manager_fk FOREIGN KEY (manager_employee_id) REFERENCES employees(id);
ALTER TABLE projects ADD CONSTRAINT projects_manager_fk FOREIGN KEY (manager_employee_id) REFERENCES employees(id);

-- Lifecycle transitions (append-only)
CREATE TABLE employee_status_history (
  id            bigserial PRIMARY KEY,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  from_status   employee_status,
  to_status     employee_status NOT NULL,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  reason        text,
  changed_by    uuid REFERENCES users(id),
  workflow_instance_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_status_history_emp_idx ON employee_status_history(employee_id, created_at DESC);

-- Employment history: every change of department/designation/site/project/manager/grade
CREATE TABLE employment_history (
  id              bigserial PRIMARY KEY,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_from  date NOT NULL,
  effective_to    date,
  change_type     text NOT NULL,                  -- JOIN | TRANSFER | PROMOTION | MANAGER_CHANGE | SITE_CHANGE | OTHER
  department_id   uuid REFERENCES departments(id),
  designation_id  uuid REFERENCES designations(id),
  site_id         uuid REFERENCES sites(id),
  project_id      uuid REFERENCES projects(id),
  cost_center_id  uuid REFERENCES cost_centers(id),
  manager_employee_id uuid REFERENCES employees(id),
  grade           text,
  employment_type employment_type,
  reason          text,
  changed_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employment_history_emp_idx ON employment_history(employee_id, effective_from DESC);

CREATE TABLE employee_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_no     text,
  contract_type   text NOT NULL DEFAULT 'LIMITED',   -- LIMITED | UNLIMITED (UAE) — legal semantics REQUIRE HR/LEGAL CONFIRMATION
  start_date      date NOT NULL,
  end_date        date,
  probation_months integer,
  notice_period_days integer,
  weekly_hours    numeric(5,2),
  document_object_key text,
  is_current      boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_contracts_emp_idx ON employee_contracts(employee_id);
CREATE TRIGGER employee_contracts_updated_at BEFORE UPDATE ON employee_contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type   document_type NOT NULL,
  document_number text,
  issue_date      date,
  expiry_date     date,
  issuing_authority text,
  object_key      text,                            -- S3 object key
  file_name       text,
  mime_type       text,
  file_size_bytes bigint,
  status          document_status NOT NULL DEFAULT 'PENDING',
  reminder_days_before integer NOT NULL DEFAULT 30,
  last_reminded_at timestamptz,
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX employee_documents_emp_idx ON employee_documents(employee_id);
CREATE INDEX employee_documents_expiry_idx ON employee_documents(expiry_date) WHERE deleted_at IS NULL;
CREATE TRIGGER employee_documents_updated_at BEFORE UPDATE ON employee_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
