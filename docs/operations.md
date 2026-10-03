# Operations

## Services

- `caddy.service` — TLS and reverse proxy
- `shortlinker.service` — web, admin, redirects, API
- `shortlinker-worker.service` — analytics stream consumer and retention
- `postgresql.service` — durable application data
- `redis-server.service` — route cache, quotas, and click stream
- `shortlinker-backup.timer` — daily verified logical database dump

## Routine checks

```bash
systemctl status caddy shortlinker shortlinker-worker postgresql redis-server
curl --fail http://127.0.0.1:3000/health
journalctl -u shortlinker -u shortlinker-worker --since today
systemctl list-timers shortlinker-backup.timer
npm run smoke
npm run smoke:profile
```

## Deployment

Build with Node.js 24, replace `/opt/shortlinker` atomically, run migrations, then
restart the application and worker. Migrations are forward-only and execute before
the web process starts. Always retain the prior release until health checks pass.

## Restore test

```bash
createdb shortlinker_restore_test
pg_restore --dbname shortlinker_restore_test /var/backups/shortlinker/<backup>.dump
dropdb shortlinker_restore_test
```

Container-level PBS snapshots complement logical dumps. A backup is not considered
valid until `pg_restore --list` and a periodic full restore test both succeed.

## Incident actions

1. Suspend the affected link or API client.
2. Revoke sessions or tokens.
3. Preserve application and Caddy journals.
4. Review the audit timeline and affected link history.
5. Rotate credentials and encryption material when compromise is suspected.
6. Document scope, remediation, and follow-up controls.
