# Shortlinker

[![Version](https://img.shields.io/badge/version-0.3.2-7457ff)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-19d3da)](LICENSE)
[![CI](https://github.com/TheLibertyWolf/shortlinker/actions/workflows/ci.yml/badge.svg)](https://github.com/TheLibertyWolf/shortlinker/actions/workflows/ci.yml)

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
- English/French user preferences and self-service profile management
- Installable administration PWA with sensitive pages excluded from offline caches
- Versioned bearer API with scopes, IP allowlists, quotas, and idempotency
- Downloadable WordPress integration with editor tools and aggregate analytics
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

## WordPress integration

Download `shortlinker-wordpress.zip` from the administration under **API clients**.
Create a dedicated client restricted to the WordPress server IP and required
domain, then paste the one-time JSON connection block into **Settings →
Shortlinker**. The plugin supports posts, pages, public custom post types,
delegated users, list columns, controlled bulk generation, and click analytics.

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

The Shortlinker platform is released under the [MIT License](LICENSE). The
WordPress plugin is distributed under GPL-2.0-or-later as declared in its plugin
header and package readme.
