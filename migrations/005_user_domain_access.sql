BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS all_domains boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS user_domain_access (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, domain_id)
);

CREATE INDEX IF NOT EXISTS user_domain_access_domain_idx
  ON user_domain_access(domain_id, user_id);

CREATE INDEX IF NOT EXISTS links_domain_created_idx
  ON links(domain_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS links_domain_clicks_idx
  ON links(domain_id, click_count DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS links_slug_search_idx
  ON links USING gin(slug gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS links_destination_search_idx
  ON links USING gin(destination gin_trgm_ops) WHERE deleted_at IS NULL;

COMMIT;
