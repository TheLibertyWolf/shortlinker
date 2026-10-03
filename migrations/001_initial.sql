BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  require_password_change boolean NOT NULL DEFAULT true,
  totp_secret_encrypted text,
  totp_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name citext NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_permission_overrides (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_code text NOT NULL,
  allowed boolean NOT NULL,
  PRIMARY KEY (user_id, permission_code)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  ip_hash text NOT NULL,
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id, expires_at DESC);

CREATE TABLE login_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webauthn_credentials (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_type text,
  backed_up boolean,
  name text NOT NULL DEFAULT 'Passkey',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname citext NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  is_primary boolean NOT NULL DEFAULT false,
  verification_token text NOT NULL,
  verified_at timestamptz,
  last_verification_error text,
  homepage_redirect text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX domains_single_primary_idx ON domains(is_primary) WHERE is_primary;

CREATE TABLE links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES domains(id),
  slug text NOT NULL,
  destination text NOT NULL,
  redirect_type smallint NOT NULL DEFAULT 302 CHECK (redirect_type IN (301, 302, 307, 308)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'suspended', 'deleted')),
  active_from timestamptz,
  expires_at timestamptz,
  max_clicks bigint CHECK (max_clicks IS NULL OR max_clicks > 0),
  click_count bigint NOT NULL DEFAULT 0,
  pass_query boolean NOT NULL DEFAULT false,
  tags text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(domain_id, slug)
);
CREATE INDEX links_lookup_idx ON links(domain_id, slug) INCLUDE (destination, redirect_type, status, expires_at);
CREATE INDEX links_owner_idx ON links(created_by, created_at DESC);

CREATE TABLE link_history (
  id bigserial PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE click_events (
  id bigserial PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  visitor_class text NOT NULL CHECK (visitor_class IN ('human', 'robot', 'unknown')),
  classification_reason text,
  visitor_hash text NOT NULL,
  ip_ciphertext text,
  country_code char(2),
  user_agent text,
  browser text,
  operating_system text,
  device_type text,
  referrer text,
  request_id text
);
CREATE INDEX click_events_link_time_idx ON click_events(link_id, clicked_at DESC);
CREATE INDEX click_events_time_idx ON click_events(clicked_at DESC);
CREATE INDEX click_events_visitor_idx ON click_events(link_id, visitor_hash, clicked_at DESC);

CREATE TABLE api_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_prefix text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  allowed_cidrs cidr[] NOT NULL DEFAULT '{}',
  domain_ids uuid[] NOT NULL DEFAULT '{}',
  rate_limit_per_minute integer NOT NULL DEFAULT 120 CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz,
  last_used_at timestamptz,
  last_ip inet,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_idempotency (
  api_client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_client_id, idempotency_key)
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  api_client_id uuid REFERENCES api_clients(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  ip_hash text,
  metadata jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'success',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_time_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_user_id, created_at DESC);

CREATE TABLE abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid REFERENCES links(id) ON DELETE SET NULL,
  reporter_email citext,
  reason text NOT NULL,
  details text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'rejected')),
  ip_hash text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

INSERT INTO roles (name, description, is_system) VALUES
  ('Super Admin', 'Unrestricted platform administration', true),
  ('Manager', 'Manage links, domains, analytics and API clients', true),
  ('Analyst', 'Read-only links and analytics access', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM roles r
CROSS JOIN (VALUES
  ('links.read'), ('links.write'), ('links.delete'), ('stats.read'), ('stats.export'), ('stats.ip.read'),
  ('domains.read'), ('domains.write'), ('users.read'), ('users.write'), ('api.read'), ('api.write'),
  ('settings.read'), ('settings.write'), ('audit.read'), ('abuse.manage')
) AS p(code)
WHERE r.name = 'Super Admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN (VALUES
  ('links.read'), ('links.write'), ('links.delete'), ('stats.read'), ('stats.export'),
  ('domains.read'), ('domains.write'), ('api.read'), ('api.write'), ('abuse.manage')
) AS p(code) WHERE r.name = 'Manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN (VALUES
  ('links.read'), ('stats.read'), ('stats.export')
) AS p(code) WHERE r.name = 'Analyst'
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('turnstile', '{"enabled":false,"siteKey":"","secretEncrypted":""}'),
  ('security', '{"requireMfa":true,"sessionHours":12}'),
  ('privacy', '{"rawIpRetentionDays":7}'),
  ('branding', '{"productName":"Shortlinker","supportEmail":"abuse@shurl.be"}')
ON CONFLICT (key) DO NOTHING;

COMMIT;
