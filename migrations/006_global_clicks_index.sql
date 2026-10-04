BEGIN;

CREATE INDEX IF NOT EXISTS links_clicks_idx
  ON links(click_count DESC, created_at DESC) WHERE deleted_at IS NULL;

COMMIT;
