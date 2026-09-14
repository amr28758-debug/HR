-- 0003: organization master data

CREATE TABLE cost_centers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  name_ar     text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE TRIGGER cost_centers_updated_at BEFORE UPDATE ON cost_centers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE departments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  name_ar       text,
  parent_id     uuid REFERENCES departments(id),
  manager_employee_id uuid,                        -- FK added after employees table exists
  cost_center_id uuid REFERENCES cost_centers(id),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE TRIGGER departments_updated_at BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE designations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  title       text NOT NULL,
  title_ar    text,
  grade       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE TRIGGER designations_updated_at BEFORE UPDATE ON designations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,          -- e.g. C31
  name            text NOT NULL,
  name_ar         text,
  client_name     text,
  status          text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ON_HOLD | COMPLETED | CANCELLED
  start_date      date,
  end_date        date,
  cost_center_id  uuid REFERENCES cost_centers(id),
  manager_employee_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  name_ar       text,
  site_type     text NOT NULL DEFAULT 'SITE',     -- OFFICE | SITE | CAMP | WAREHOUSE
  project_id    uuid REFERENCES projects(id),
  address       text,
  emirate       text,
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  geofence_radius_m integer,
  timezone      text NOT NULL DEFAULT 'Asia/Dubai',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX sites_project_idx ON sites(project_id);
CREATE TRIGGER sites_updated_at BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  name_ar     text,
  holiday_date date NOT NULL,
  end_date    date,                               -- multi-day holidays (Eid)
  is_paid     boolean NOT NULL DEFAULT true,
  applies_to_site_id uuid REFERENCES sites(id),   -- null = company-wide
  year        integer GENERATED ALWAYS AS (EXTRACT(YEAR FROM holiday_date)::int) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (holiday_date, applies_to_site_id)
);
CREATE INDEX holidays_date_idx ON holidays(holiday_date);
