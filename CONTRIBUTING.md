# Contributing

1. Create a focused branch from `main`.
2. Keep secrets and production visitor data out of commits and fixtures.
3. Run `npm run typecheck`, `npm test`, and `npm run build`.
4. Document schema, API, security, or operational changes.
5. Open a pull request using the repository template.

All database changes require an additive, numbered migration. Changes to redirect
behavior require tests for status codes, caching, disabled links, and expiry.
