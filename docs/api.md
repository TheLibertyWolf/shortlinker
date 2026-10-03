# API v1

Base URL: `https://shurl.be/api/v1`

Send the generated token as `Authorization: Bearer <token>`. Tokens are displayed
once and cannot be recovered. Every client has explicit scopes, an IP/CIDR
allowlist, allowed domains, an expiry, and a per-minute quota.

## Create a link

```http
POST /api/v1/links
Authorization: Bearer shurl_live_...
Idempotency-Key: your-stable-request-id
Content-Type: application/json

{
  "domain": "shurl.be",
  "destination": "https://example.com/a/long/path",
  "slug": "campaign-1",
  "redirectType": 302,
  "tags": ["campaign"]
}
```

Omit `slug` to generate a random Base62 code. Reusing an idempotency key with the
same body returns the original response; using it with another body returns 409.

## Endpoints

- `GET /domains` — domains available to the client
- `GET /links` — paginated links
- `POST /links` — create a link
- `GET /links/{id}/stats` — summary and countries
- `DELETE /links/{id}` — soft-delete and reserve the slug
- `GET /openapi.json` — machine-readable service description

Rate-limit responses use status `429` with `Retry-After`. Error bodies always use
an `error.code` and `error.message` object.
