# Changelog

All notable changes are documented here. This project follows semantic versioning.

## [Unreleased]

## [0.3.5] - 2026-10-04

### Changed

- Link creation accepts safe compatibility aliases commonly used by integrations: `url`/`target`, `shortcode`/`code`, and snake-case option names.
- Numeric and boolean form values, comma-separated tags, and `null` optional fields are normalized before strict validation.
- API validation failures now return a concise field-level message and write a value-free audit entry for diagnosis.

## [0.3.4] - 2026-10-04

### Added

- WordPress plugin 1.3.0 with optional automatic shortlink generation on the first transition to the published status.
- Independent automatic-generation switches for posts, pages and every supported public custom post type.
- A one-click shortlink copy button in both WordPress editor widgets.
- Per-user domain allowlists, a domain-scoped statistics panel, and a dedicated statistics-only access path.
- Search, domain, status, sort and page-size filters on the administration link list.
- PostgreSQL indexes for domain-scoped lists and large destination/slug searches.

### Changed

- Automatic publication never replaces an existing shortlink and uses a stable idempotency key to prevent duplicates when a request is retried.
- Automatic-generation failures are retained and displayed in both the block editor and Classic Editor for manual retry.
- WordPress dashboard, statistics and article-list views no longer fetch API analytics or aggregate large post metadata sets during page rendering.
- Detailed WordPress analytics now open the authoritative domain-restricted view on shurl.be.

## [0.3.3] - 2026-10-04

### Changed

- IP allowlist failures now return the source IP observed by Shortlinker so NAT, IPv6 and outbound proxy mismatches can be diagnosed without weakening API restrictions.

## [0.3.2] - 2026-10-04

### Added

- WordPress plugin 1.2.0 with a compact statistics widget on the main WordPress dashboard.
- Live progress, per-item terminal logs, automatic request retries and a safe stop control for bulk shortlink generation.
- French translations for the complete WordPress interface, with English as the default language.

### Changed

- WordPress bulk generation now uses a cursor-based AJAX queue with no 1,000-item cap, suitable for libraries containing tens of thousands of posts.
- Dashboard summaries aggregate local WordPress metadata and do not generate API traffic when the dashboard loads.
- The WordPress statistics page refreshes up to 100 displayed links through one cached batch request instead of one request per link.
- Country, browser, device and referrer summaries now appear before the detailed performance table.

## [0.3.1] - 2026-10-04

### Added

- WordPress plugin 1.1.1 with a native Gutenberg Document sidebar panel for generating, displaying, and regenerating shortlinks.

### Changed

- The WordPress editor control now reacts immediately when a draft is published without requiring a page reload.
- The Classic Editor retains its dedicated side meta box.

## [0.3.0] - 2026-10-04

### Added

- WordPress plugin 1.1.0 with a top-level full-width analytics page, independent role/user access policies, a dedicated danger tab, looped bulk generation, and native update checks.
- Reusable encrypted WordPress connection blocks from the API client list.
- Explicit default-homepage or custom-URL selection when attaching domains.

### Changed

- WordPress settings preserve the active tab after every save.
- `fran.racing` now redirects its homepage to `https://franceracing.fr`.

### Security

- Reusable API client secrets are encrypted at rest and every WordPress configuration view is audited.
- Custom domain homepage redirects continue to require HTTPS and reject self-referential loops.

## [0.2.1] - 2026-10-04

### Changed

- Updated production and development dependency groups after isolated compatibility testing.
- Migrated TOTP generation and verification to the asynchronous otplib 13 API while preserving enrolled 10-byte otplib 12 secrets.

### Security

- Dependency audit now reports zero known vulnerabilities.

## [0.2.0] - 2026-10-04

### Added

- Self-service profiles, administrator account editing, and English/French UI preferences.
- Compact collapsible administration sidebar and a shared SVG favicon.
- Installable administration PWA with dedicated maskable icons and a static-assets-only service worker.
- WordPress plugin with connection block import, editor controls, content columns, delegated access, controlled batch generation, and analytics.
- MIT license, support and conduct policies, feature-request template, and tagged release automation.

### Changed

- Security settings now live in the profile page.
- Maximum encrypted raw-IP retention increased from 90 to 365 days.
- API clients now expose a one-time WordPress connection block and plugin download.
- Public landing page no longer links directly to the API.

### Fixed

- Reject custom-domain homepage redirects that point back to the same hostname.

## [0.1.0] - 2026-10-04

### Added

- Initial multi-domain shortlink service, administration, analytics, API, MFA,
  Turnstile configuration, abuse reporting, DNS ownership verification, and
  production deployment assets.
- Dark responsive landing page with a live URL-to-analytics/API flow diagram.
