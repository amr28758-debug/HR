-- 0002: users, roles, permissions, service accounts, api keys, audit log

CREATE TABLE roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,            -- e.g. HR_ADMIN
  name          text NOT NULL,
  description   text,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,            -- e.g. employees:read, salary:read
  description   text
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext UNIQUE,                 -- null for site workers without email
  display_name      text NOT NULL,
  entra_object_id   text UNIQUE,                   -- Microsoft Entra ID object id (oid claim)
  entra_upn         citext,
  local_password_hash text,                        -- only for AUTH_MODE=local / break-glass accounts
  is_service_account boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  locale            text NOT NULL DEFAULT 'en',
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX users_entra_upn_idx ON users(entra_upn);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- API keys for service accounts (device gateway, integration middleware). Stored hashed.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  key_prefix    text NOT NULL,                  -- first 8 chars, for identification
  key_hash      text NOT NULL UNIQUE,           -- sha256(pepper + key)
  scopes        text[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_prefix_idx ON api_keys(key_prefix);

-- Immutable audit log: no UPDATE/DELETE allowed (enforced by trigger)
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  actor_label   text,                            -- denormalised display name / service name
  action        text NOT NULL,                   -- e.g. employee.salary.update
  entity_type   text NOT NULL,                   -- e.g. employee
  entity_id     text,
  old_value     jsonb,
  new_value     jsonb,
  reason        text,
  ip_address    inet,
  user_agent    text,
  source        text NOT NULL DEFAULT 'api',     -- api | worker | integration | migration
  approval_ref  text,                            -- workflow instance id if approval-backed
  request_id    text,
  metadata      jsonb
);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_user_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs(action, occurred_at DESC);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (table %)', TG_OP, TG_TABLE_NAME;
END $$;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
