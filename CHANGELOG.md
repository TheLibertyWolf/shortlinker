# Changelog

All notable changes are documented here. This project follows semantic versioning.

## [Unreleased]

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
