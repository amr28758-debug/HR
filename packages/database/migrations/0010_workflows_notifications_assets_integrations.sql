-- 0010: workflow engine, notifications, assets, onboarding/clearance, integrations, migration framework

CREATE TABLE workflow_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,                      -- OVERTIME_APPROVAL, SALARY_CHANGE, RESIGNATION, LEAVE_APPROVAL...
  version       integer NOT NULL DEFAULT 1,
  name          text NOT NULL,
  entity_type   text NOT NULL,                      -- overtime_request | leave_request | employee | payroll_run ...
  trigger       jsonb NOT NULL,                     -- { event: 'overtime_request.created' }
  conditions    jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ field:'requested_minutes', op:'gt', value:120 }]
  steps         jsonb NOT NULL,                     -- [{ key:'manager', approverType:'MANAGER'|'ROLE'|'USER', roleCode, userId, condition }]
  actions       jsonb NOT NULL DEFAULT '[]'::jsonb, -- on completion: [{ type:'set_status', value:'APPROVED' }]
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE workflow_instances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id   uuid NOT NULL REFERENCES workflow_definitions(id),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  status          workflow_instance_status NOT NULL DEFAULT 'PENDING',
  current_step    integer NOT NULL DEFAULT 0,
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  initiated_by    uuid REFERENCES users(id),
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_instances_entity_idx ON workflow_instances(entity_type, entity_id);
CREATE INDEX workflow_instances_status_idx ON workflow_instances(status);
CREATE TRIGGER workflow_instances_updated_at BEFORE UPDATE ON workflow_instances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workflow_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id     uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_index      integer NOT NULL,
  step_key        text NOT NULL,
  assignee_user_id uuid REFERENCES users(id),
  assignee_role_code text,
  status          workflow_task_status NOT NULL DEFAULT 'PENDING',
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  comment         text,
  due_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_tasks_assignee_idx ON workflow_tasks(assignee_user_id, status);
CREATE INDEX workflow_tasks_role_idx ON workflow_tasks(assignee_role_code, status);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel       notification_channel NOT NULL DEFAULT 'IN_APP',
  type          text NOT NULL,                  -- approval.pending, document.expiring, payroll.ready ...
  title         text NOT NULL,
  body          text,
  link          text,
  payload       jsonb,
  read_at       timestamptz,
  sent_at       timestamptz,
  send_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_tag     text NOT NULL UNIQUE,
  category      text NOT NULL,                  -- LAPTOP | PHONE | SIM | VEHICLE | ID_CARD | TOOL | OTHER
  name          text NOT NULL,
  serial_number text,
  status        text NOT NULL DEFAULT 'AVAILABLE',  -- AVAILABLE | ASSIGNED | MAINTENANCE | RETIRED
  site_id       uuid REFERENCES sites(id),
  purchase_date date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE TRIGGER assets_updated_at BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL REFERENCES assets(id),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  assigned_at   date NOT NULL DEFAULT CURRENT_DATE,
  returned_at   date,
  condition_out text,
  condition_in  text,
  assigned_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_assets_emp_idx ON employee_assets(employee_id) WHERE returned_at IS NULL;

-- Checklist templates + instances (onboarding, clearance)
CREATE TABLE checklist_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,               -- ONBOARDING, CLEARANCE
  name        text NOT NULL,
  items       jsonb NOT NULL,                     -- [{ key, title, ownerRole:'HR_ADMIN'|'IT_ADMIN'..., group:'HR'|'IT'|'FINANCE'|'ADMIN', required:true }]
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checklist_instances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES checklist_templates(id),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  status        text NOT NULL DEFAULT 'OPEN',     -- OPEN | COMPLETED | CANCELLED
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE TABLE checklist_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id   uuid NOT NULL REFERENCES checklist_instances(id) ON DELETE CASCADE,
  item_key      text NOT NULL,
  title         text NOT NULL,
  group_name    text NOT NULL,
  owner_role_code text,
  owner_user_id uuid REFERENCES users(id),
  is_required   boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'PENDING',  -- PENDING | DONE | NOT_APPLICABLE
  completed_by  uuid REFERENCES users(id),
  completed_at  timestamptz,
  note          text,
  due_at        timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checklist_tasks_owner_idx ON checklist_tasks(owner_role_code, status);

-- Integration layer (device gateway, VYOM, legacy Zoho). Zoho is REMOVABLE: nothing in core references it.
CREATE TABLE integration_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,             -- MATRIX_VYOM, MATRIX_DEVICE_GATEWAY, ZOHO_PEOPLE (legacy)
  provider      text NOT NULL,
  status        integration_status NOT NULL DEFAULT 'DISABLED',
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret config only. Secrets come from environment.
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error    text,
  cursor        jsonb,                            -- provider sync cursor (last event id / timestamp)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER integration_connections_updated_at BEFORE UPDATE ON integration_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE integration_logs (
  id            bigserial PRIMARY KEY,
  connection_id uuid REFERENCES integration_connections(id) ON DELETE SET NULL,
  operation     text NOT NULL,
  direction     text NOT NULL DEFAULT 'INBOUND',  -- INBOUND | OUTBOUND
  status        text NOT NULL,                    -- SUCCESS | FAILURE
  request_summary jsonb,
  response_summary jsonb,
  duration_ms   integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_logs_conn_idx ON integration_logs(connection_id, created_at DESC);

CREATE TABLE integration_failures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES integration_connections(id) ON DELETE SET NULL,
  operation     text NOT NULL,
  payload       jsonb,
  error         text NOT NULL,
  attempts      integer NOT NULL DEFAULT 1,
  next_retry_at timestamptz,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_failures_open_idx ON integration_failures(next_retry_at) WHERE resolved_at IS NULL;

-- Legacy data migration framework (Zoho/Excel/VYOM exports → Burtplace). Source-agnostic.
CREATE TABLE migration_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL,                    -- ZOHO_PEOPLE | EXCEL | VYOM_EXPORT
  entity_type   text NOT NULL,                    -- employees | departments | salary_structures | leave_balances | attendance
  file_name     text,
  status        text NOT NULL DEFAULT 'PENDING',  -- PENDING | VALIDATED | APPLIED | FAILED
  total_rows    integer NOT NULL DEFAULT 0,
  valid_rows    integer NOT NULL DEFAULT 0,
  applied_rows  integer NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz
);

CREATE TABLE migration_rows (
  id            bigserial PRIMARY KEY,
  batch_id      uuid NOT NULL REFERENCES migration_batches(id) ON DELETE CASCADE,
  row_number    integer NOT NULL,
  source_id     text,
  raw           jsonb NOT NULL,
  normalized    jsonb,
  status        text NOT NULL DEFAULT 'PENDING',  -- PENDING | VALID | INVALID | APPLIED | SKIPPED
  error         text,
  target_id     uuid
);
CREATE INDEX migration_rows_batch_idx ON migration_rows(batch_id, status);

-- Reconciliation snapshots
CREATE TABLE reconciliation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'COMPLETED',
  summary       jsonb NOT NULL,                   -- { rawUnprocessed, unmappedUsers, employeesMissingDaily, timesheetMismatches, payrollMismatches }
  findings      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
