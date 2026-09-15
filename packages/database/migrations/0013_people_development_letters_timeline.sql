-- 0013: disciplinary, performance, training, letters, notes, timeline, lookups, delegation

-- Generic configurable code lists (bonus types, training categories, disciplinary categories, document categories…)
CREATE TABLE lookups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    text NOT NULL,                 -- BONUS_TYPE | DISCIPLINARY_CATEGORY | TRAINING_CATEGORY | DOCUMENT_CATEGORY | PERFORMANCE_RATING | LETTER_CATEGORY | EXIT_REASON | NOTE_CATEGORY
  code        text NOT NULL,
  name        text NOT NULL,
  name_ar     text,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order  integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (category, code)
);

ALTER TABLE employee_documents ADD COLUMN category text;   -- lookup DOCUMENT_CATEGORY (IDENTITY, LABOUR, CONTRACT, INSURANCE, EDUCATION, TRAINING, COMPANY, OTHER)

-- Disciplinary (highly restricted: disciplinary:read / disciplinary:write)
CREATE TABLE disciplinary_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no           text NOT NULL UNIQUE,
  employee_id       uuid NOT NULL REFERENCES employees(id),
  category          text NOT NULL,             -- VERBAL_WARNING | WRITTEN_WARNING | FINAL_WARNING | DISCIPLINARY_ACTION | INVESTIGATION | SUSPENSION | OTHER
  severity          text NOT NULL DEFAULT 'MEDIUM',
  incident_date     date NOT NULL,
  description       text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{objectKey, fileName}]
  action_taken      text,
  employee_response text,
  status            text NOT NULL DEFAULT 'OPEN',   -- OPEN | UNDER_INVESTIGATION | ACTION_TAKEN | CLOSED | WITHDRAWN
  is_confidential   boolean NOT NULL DEFAULT true,
  hr_request_id     uuid REFERENCES hr_requests(id),
  closed_at         timestamptz,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE disciplinary_case_no_seq START 1;
CREATE INDEX disciplinary_cases_emp_idx ON disciplinary_cases(employee_id);
CREATE TRIGGER disciplinary_cases_updated_at BEFORE UPDATE ON disciplinary_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Performance
CREATE TABLE performance_cycles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  cycle_year    integer NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  review_due    date,
  status        text NOT NULL DEFAULT 'DRAFT',    -- DRAFT | OPEN | CLOSED
  rating_scale  jsonb NOT NULL DEFAULT '[{"value":1,"label":"Needs improvement"},{"value":2,"label":"Developing"},{"value":3,"label":"Meets expectations"},{"value":4,"label":"Exceeds expectations"},{"value":5,"label":"Outstanding"}]'::jsonb,
  competencies  jsonb NOT NULL DEFAULT '["Technical","Leadership","Quality","Attendance","Teamwork","Safety"]'::jsonb,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE performance_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id            uuid NOT NULL REFERENCES performance_cycles(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES employees(id),
  reviewer_employee_id uuid REFERENCES employees(id),
  status              text NOT NULL DEFAULT 'DRAFT',   -- DRAFT | SELF_REVIEW | MANAGER_REVIEW | FINAL
  self_rating         numeric(4,2),
  manager_rating      numeric(4,2),
  final_rating        numeric(4,2),
  competency_scores   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"Technical":4,...}
  self_comments       text,
  manager_comments    text,
  development_plan    text,
  finalized_by        uuid REFERENCES users(id),
  finalized_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, employee_id)
);
CREATE TRIGGER performance_reviews_updated_at BEFORE UPDATE ON performance_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE performance_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
  title       text NOT NULL,
  kpi         text,
  weight      numeric(5,2) NOT NULL DEFAULT 0,
  target      text,
  achievement text,
  score       numeric(4,2),
  sort_order  integer NOT NULL DEFAULT 100
);

-- Training & certifications
CREATE TABLE training_catalog (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  title           text NOT NULL,
  title_ar        text,
  category        text NOT NULL DEFAULT 'GENERAL',   -- lookup TRAINING_CATEGORY
  provider        text,
  duration_hours  numeric(6,2),
  validity_months integer,                           -- certificate validity; null = no expiry
  is_mandatory    boolean NOT NULL DEFAULT false,
  description     text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE training_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id         uuid NOT NULL REFERENCES training_catalog(id),
  employee_id         uuid NOT NULL REFERENCES employees(id),
  status              text NOT NULL DEFAULT 'ASSIGNED',   -- REQUESTED | ASSIGNED | IN_PROGRESS | COMPLETED | FAILED | CANCELLED
  scheduled_date      date,
  completed_at        date,
  score               numeric(6,2),
  certificate_no      text,
  certificate_object_key text,
  certificate_expiry  date,
  cost                numeric(14,2),
  notes               text,
  hr_request_id       uuid REFERENCES hr_requests(id),
  assigned_by         uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_records_emp_idx ON training_records(employee_id);
CREATE INDEX training_records_expiry_idx ON training_records(certificate_expiry) WHERE certificate_expiry IS NOT NULL;
CREATE TRIGGER training_records_updated_at BEFORE UPDATE ON training_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Letters
CREATE TABLE letter_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL,               -- SALARY_CERTIFICATE, NOC, ...
  version           integer NOT NULL DEFAULT 1,
  name              text NOT NULL,
  name_ar           text,
  category          text NOT NULL DEFAULT 'CERTIFICATE',
  language          text NOT NULL DEFAULT 'en',  -- en | ar | bilingual
  subject           text,
  body_en           text,                        -- HTML with {{employee.name}} style placeholders
  body_ar           text,
  requires_approval boolean NOT NULL DEFAULT false,
  signatory_name    text,
  signatory_title   text,
  signatory_title_ar text,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE generated_letters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_no         text NOT NULL UNIQUE,        -- BP-LTR-2026-000123
  verification_code text NOT NULL UNIQUE,        -- for QR / public verification
  template_id       uuid NOT NULL REFERENCES letter_templates(id),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  language          text NOT NULL,
  variables         jsonb NOT NULL,              -- snapshot used for rendering (reproducible)
  rendered_html     text NOT NULL,
  addressee         text,
  purpose           text,
  status            text NOT NULL DEFAULT 'ISSUED',  -- DRAFT | PENDING_APPROVAL | ISSUED | REVOKED
  hr_request_id     uuid REFERENCES hr_requests(id),
  issued_by         uuid REFERENCES users(id),
  issued_at         timestamptz,
  revoked_at        timestamptz,
  revoke_reason     text,
  object_key        text,                        -- PDF in object storage when generated
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE letter_no_seq START 1;
CREATE INDEX generated_letters_emp_idx ON generated_letters(employee_id, created_at DESC);

-- Notes (internal HR notes; confidential flag restricts to HR roles)
CREATE TABLE employee_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  category        text NOT NULL DEFAULT 'GENERAL',
  note            text NOT NULL,
  is_confidential boolean NOT NULL DEFAULT false,
  pinned          boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_notes_emp_idx ON employee_notes(employee_id, created_at DESC);

-- Business-readable employee history (distinct from the technical audit log). Append-only.
CREATE TABLE employee_timeline_events (
  id            bigserial PRIMARY KEY,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_type    text NOT NULL,       -- JOINED | STATUS | PROMOTION | TRANSFER | SALARY | INCREMENT | BONUS | DEDUCTION | LOAN | ADVANCE | LEAVE | OVERTIME | ATTENDANCE_CORRECTION | DOCUMENT | LETTER | TRAINING | PERFORMANCE | DISCIPLINARY | ASSET | REQUEST | NOTE | PAYROLL
  title         text NOT NULL,
  description   text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  ref_type      text,
  ref_id        text,
  visibility    text NOT NULL DEFAULT 'HR',   -- EMPLOYEE (visible to the employee) | MANAGER | HR | RESTRICTED
  actor_user_id uuid REFERENCES users(id),
  metadata      jsonb
);
CREATE INDEX employee_timeline_emp_idx ON employee_timeline_events(employee_id, occurred_at DESC);
CREATE TRIGGER employee_timeline_immutable BEFORE UPDATE OR DELETE ON employee_timeline_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Approval delegation
CREATE TABLE workflow_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id  uuid NOT NULL REFERENCES users(id),
  to_user_id    uuid NOT NULL REFERENCES users(id),
  from_date     date NOT NULL,
  to_date       date NOT NULL,
  reason        text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);
CREATE INDEX workflow_delegations_to_idx ON workflow_delegations(to_user_id, from_date, to_date);

-- Public letter verification view (no personal data beyond what the letter states)
CREATE VIEW v_letter_verification AS
SELECT gl.verification_code, gl.letter_no, gl.status, gl.issued_at, lt.name AS letter_type, e.employee_no, e.full_name_en
FROM generated_letters gl JOIN letter_templates lt ON lt.id = gl.template_id JOIN employees e ON e.id = gl.employee_id;
