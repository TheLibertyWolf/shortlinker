# Security model

## Defense in depth

- Proxmox firewall exposes only 80/443 publicly; SSH is limited to the management
  IPSET.
- Caddy rejects administration traffic outside the five management addresses.
- The application independently repeats the source-IP authorization.
- MFA is required before access to the control plane.
- Sessions use opaque random tokens, strict secure cookies, server-side revocation,
  short expiry, and CSRF tokens.
- Turnstile, when enabled, is validated server-side and fails closed.
- Security actions are written to an application audit log.

## Secrets

Production environment files are mode `0600` and excluded from Git. Turnstile
secrets and raw visitor IPs are encrypted with AES-256-GCM. Passwords and recovery
codes use Argon2id. API and session tokens are hashed and cannot be recovered.

## Redirect safety

Only absolute HTTP(S) destinations are accepted. Embedded credentials, localhost,
private IPv4 destinations, reserved paths, and direct shortlink loops are rejected.
The application never fetches destinations on the redirect path.

## Privacy

Raw IP addresses are encrypted and removed after the configured retention window.
Visitor uniqueness uses an HMAC scoped to link and day. Country and aggregate data
remain after the encrypted IP is deleted. Access to raw IP data requires a distinct
permission and is not exposed by the current API.

## Response policy

Use the procedure in `SECURITY.md`. An administrator can suspend a reported link
immediately without deleting evidence or releasing its slug.
