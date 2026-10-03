# Shortlinker

Shortlinker powers `shurl.be` and verified custom domains with fast redirects,
asynchronous privacy-aware analytics, granular administration, and a scoped API.

## Highlights

- Seven-character cryptographically random Base62 slugs and custom aliases
- PostgreSQL source of truth with Redis caching and event streaming
- Human/robot classification, country, browser, OS, device, referrer, and uniques
- Multi-domain ownership verification via `_shurl.<domain>` TXT records
- Automatic HTTPS through Caddy On-Demand TLS, gated by verified domains
- Network-restricted Bootstrap administration with TOTP MFA and recovery codes
- Optional Cloudflare Turnstile login protection with encrypted secret storage
- Role permissions, per-user overrides, audit logs, and session revocation
- Versioned bearer API with scopes, IP allowlists, quotas, and idempotency
- Abuse reporting and immediate link suspension

## Architecture

```text
Internet → Proxmox firewall → Caddy :443 → Node.js/Fastify :3000
                                         ├── PostgreSQL 17
                                         └── Redis 8 → analytics worker
```

HTTP is used only for ACME and permanent HTTPS redirects. PostgreSQL, Redis, and
the application port bind locally and are never exposed by the LXC firewall.

See [architecture](docs/architecture.md), [API](docs/api.md),
[operations](docs/operations.md), and [security](docs/security.md).

## Development

Requirements: Node.js 24 LTS, PostgreSQL 17, and Redis 8.

```bash
cp .env.example .env
npm install
npm run build
npm run migrate
BOOTSTRAP_ADMIN_USERNAME='admin' BOOTSTRAP_ADMIN_PASSWORD='a-long-development-password' npm run bootstrap
npm run dev
```

Run the analytics worker separately with `npm run dev:worker`.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## License

Copyright © 2026 [Jessy System](https://jessysystem.com/). No license has been
granted yet; all rights are reserved until the repository owner selects one
explicitly.
