BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';

ALTER TABLE users
  ADD CONSTRAINT users_locale_supported CHECK (locale IN ('en', 'fr'));

COMMIT;
