import type { FastifyReply, FastifyRequest } from "fastify";
import ipaddr from "ipaddr.js";
import { db, getSetting } from "./db.js";
import { config } from "./config.js";
import { hmacIp, randomToken, sha256, decrypt } from "./crypto.js";
import type { TurnstileSettings, UserSession } from "./types.js";

function normalizeIp(value: string): string {
  const raw = value.split(",")[0]!.trim();
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
}

export function isSecurityRoute(url: string): boolean {
  const path = url.split("?", 1)[0]!;
  return path === "/admin/profile" || path.startsWith("/admin/profile/") ||
    path === "/admin/security" || path.startsWith("/admin/security/");
}

export function ipMatchesCidrs(ipValue: string, cidrs: string[]): boolean {
  try {
    const ip = ipaddr.parse(normalizeIp(ipValue));
    return cidrs.some((cidr) => {
      const [range, bits] = ipaddr.parseCIDR(cidr);
      let candidate: ipaddr.IPv4 | ipaddr.IPv6 = ip;
      if (ip.kind() === "ipv6") {
        const ipv6 = ip as ipaddr.IPv6;
        if (ipv6.isIPv4MappedAddress()) candidate = ipv6.toIPv4Address();
      }
      return candidate.kind() === range.kind() && candidate.match(range, bits);
    });
  } catch { return false; }
}

export function isAdminIp(request: FastifyRequest): boolean {
  return ipMatchesCidrs(request.ip, config.adminAllowedCidrs);
}

export async function createSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  mfaVerified: boolean
): Promise<void> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, mfa_verified, ip_hash, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,now() + ($7 || ' hours')::interval)`,
    [sha256(token), userId, csrfToken, mfaVerified, hmacIp(request.ip), String(request.headers["user-agent"] ?? "").slice(0, 512), config.SESSION_TTL_HOURS]
  );
  reply.setCookie("shurl_session", token, {
    path: "/", httpOnly: true, secure: config.isProduction, sameSite: "strict",
    maxAge: config.SESSION_TTL_HOURS * 3600
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies.shurl_session;
  if (token) await db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [sha256(token)]);
  reply.clearCookie("shurl_session", { path: "/" });
}

export async function loadSession(request: FastifyRequest): Promise<UserSession | null> {
  const token = request.cookies.shurl_session;
  if (!token) return null;
  const result = await db.query<{
    session_id: string; user_id: string; username: string; email: string; display_name: string; locale: "en" | "fr";
    csrf_token: string; mfa_verified: boolean; require_password_change: boolean; permissions: string[];
    all_domains: boolean; domain_ids: string[];
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.username::text, u.email::text, u.display_name, u.locale, u.require_password_change,
            s.csrf_token, s.mfa_verified, u.all_domains,
            ARRAY(SELECT uda.domain_id::text FROM user_domain_access uda WHERE uda.user_id=u.id) AS domain_ids,
            ARRAY(
              SELECT DISTINCT rp.permission_code
              FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
              WHERE ur.user_id = u.id
                AND NOT EXISTS (
                  SELECT 1 FROM user_permission_overrides o
                  WHERE o.user_id = u.id AND o.permission_code = rp.permission_code AND o.allowed = false
                )
              UNION
              SELECT o.permission_code FROM user_permission_overrides o WHERE o.user_id = u.id AND o.allowed = true
            ) AS permissions
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)]
  );
  const row = result.rows[0];
  if (!row) return null;
  void db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'", [row.session_id]);
  return {
    sessionId: row.session_id, userId: row.user_id, username: row.username, email: row.email, displayName: row.display_name, locale: row.locale,
    permissions: row.permissions ?? [], allDomains: row.all_domains, domainIds: row.domain_ids ?? [],
    mfaVerified: row.mfa_verified, requirePasswordChange: row.require_password_change, csrfToken: row.csrf_token
  };
}

export async function requireSession(request: FastifyRequest, reply: FastifyReply, permission?: string): Promise<UserSession | null> {
  if (!isAdminIp(request)) {
    await reply.code(403).type("text/plain").send("Administration is not available from this network.");
    return null;
  }
  const session = await loadSession(request);
  if (!session) {
    await reply.redirect("/auth/login", 303);
    return null;
  }
  const securityRoute = isSecurityRoute(request.url);
  if (session.requirePasswordChange && !securityRoute) {
    await reply.redirect("/admin/profile", 303);
    return null;
  }
  const security = await getSetting("security", { requireMfa: true });
  if (security.requireMfa && !session.mfaVerified && !securityRoute) {
    await reply.redirect("/admin/profile", 303);
    return null;
  }
  if (permission && !session.permissions.includes(permission)) {
    await reply.code(403).type("text/plain").send("Insufficient permission.");
    return null;
  }
  return session;
}

export function verifyCsrf(request: FastifyRequest, session: UserSession): boolean {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const header = request.headers["x-csrf-token"];
  return body.csrf_token === session.csrfToken || header === session.csrfToken;
}

export async function turnstilePublicSettings(): Promise<{ enabled: boolean; siteKey: string }> {
  const settings = await getSetting<TurnstileSettings>("turnstile", { enabled: false, siteKey: "", secretEncrypted: "" });
  return { enabled: settings.enabled && Boolean(settings.siteKey && settings.secretEncrypted), siteKey: settings.siteKey };
}

export async function verifyTurnstile(request: FastifyRequest, token: string | undefined): Promise<boolean> {
  const settings = await getSetting<TurnstileSettings>("turnstile", { enabled: false, siteKey: "", secretEncrypted: "" });
  if (!settings.enabled) return true;
  if (!token || token.length > 2048 || !settings.secretEncrypted) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: decrypt(settings.secretEncrypted), response: token, remoteip: normalizeIp(request.ip), idempotency_key: crypto.randomUUID() }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
    const allowedHosts = [config.PRIMARY_DOMAIN, ...config.secondaryDomains];
    return result.success === true && (!result.hostname || allowedHosts.includes(result.hostname.toLowerCase())) && (!result.action || result.action === "login");
  } catch { return false; }
}
