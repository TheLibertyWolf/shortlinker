#!/usr/bin/env bash
set -euo pipefail

source /etc/shortlinker/shortlinker.env
db_password=${DATABASE_URL#postgresql://shortlinker:}
db_password=${db_password%@*}

if [[ ! "$db_password" =~ ^[A-Za-z0-9_-]{24,}$ ]]; then
  echo "Refusing an unexpected database password format" >&2
  exit 1
fi

if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='shortlinker'" | grep -q 1; then
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "ALTER ROLE shortlinker PASSWORD '${db_password}'" >/dev/null
else
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "CREATE ROLE shortlinker LOGIN PASSWORD '${db_password}'" >/dev/null
fi

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='shortlinker'" | grep -q 1; then
  runuser -u postgres -- createdb --owner=shortlinker shortlinker
fi

runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET max_connections='50'" \
  -c "ALTER SYSTEM SET shared_buffers='256MB'" \
  -c "ALTER SYSTEM SET effective_cache_size='1GB'" \
  -c "ALTER SYSTEM SET maintenance_work_mem='64MB'" >/dev/null

systemctl restart postgresql
runuser -u postgres -- psql -tAc "SELECT current_setting('max_connections'), current_setting('shared_buffers')"
