# Architecture

## Request path

Caddy terminates TLS and rejects `/admin` and `/auth` outside the management
allowlist. Fastify repeats that network check before authentication. Public link
lookups use `(domain, slug)` as the identity and cache only resolved routing data.

Redirect analytics are appended to a Redis stream. The redirect response does not
wait for PostgreSQL analytics writes. A separate worker classifies the visitor,
derives geography from a local database, encrypts the raw IP for short retention,
and persists the event.

## Domain lifecycle

1. An administrator attaches a hostname.
2. Shortlinker generates a random ownership token.
3. The owner publishes `_shurl.<hostname> TXT shurl-verification=<token>`.
4. The administrator runs DNS verification.
5. The domain becomes active only after an exact TXT match.
6. Caddy's On-Demand TLS `ask` endpoint authorizes certificates only for active,
   verified domains.

The primary domain follows the same proof process as additional domains.

## Data model

Core tables are `domains`, `links`, `click_events`, `users`, `roles`,
`api_clients`, `sessions`, `audit_logs`, and `abuse_reports`. Deleted links keep
their slug reserved. API tokens and session tokens are stored as SHA-256 hashes;
passwords and recovery codes use Argon2id.

## Failure behavior

- PostgreSQL unavailable: readiness and requests fail closed.
- Redis unavailable: database-backed administration remains available; link
  lookup falls back to PostgreSQL and click analytics may be skipped.
- Turnstile enabled but unreachable: login fails closed.
- DNS verification unavailable: the domain remains pending.
- Analytics worker unavailable: redirect events remain in the Redis stream.
