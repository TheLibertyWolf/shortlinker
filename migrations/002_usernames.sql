BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS username citext;

UPDATE users
SET username = 'user-' || left(replace(id::text, '-', ''), 12)
WHERE username IS NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);

ALTER TABLE users
  ADD CONSTRAINT users_username_format
  CHECK (username::text = lower(username::text) AND username::text ~ '^[a-z0-9][a-z0-9._-]{2,31}$');

COMMIT;
