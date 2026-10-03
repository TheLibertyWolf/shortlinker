import { randomBytes } from "node:crypto";
import { closeConnections, db } from "../dist/db.js";
import { encrypt, hashPassword, sha256 } from "../dist/crypto.js";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const hostname = process.env.SMOKE_HOSTNAME ?? "shurl.be";
const allowedIp = process.env.SMOKE_ALLOWED_IP ?? "82.125.126.40";
const suffix = randomBytes(6).toString("hex");
const userToken = randomBytes(32).toString("base64url");
const adminToken = randomBytes(32).toString("base64url");
const userCsrf = randomBytes(24).toString("base64url");
const adminCsrf = randomBytes(24).toString("base64url");
let userId;
let adminId;
let apiClientId;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function headers(token, extra = {}) {
  return {
    cookie: `shurl_session=${token}`,
    host: hostname,
    "x-forwarded-for": allowedIp,
    "x-forwarded-host": hostname,
    "x-forwarded-proto": "https",
    ...extra
  };
}

async function request(path, token, options = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...options, headers: headers(token, options.headers) });
}

try {
  const passwordHash = await hashPassword(randomBytes(24).toString("base64url"));
  const created = await db.query(
    `INSERT INTO users(username,email,display_name,password_hash,require_password_change,locale)
     VALUES($1,$2,$3,$4,false,'en') RETURNING id`,
    [`profile-${suffix}`, `profile-${suffix}@example.test`, "Profile Smoke", passwordHash]
  );
  userId = created.rows[0].id;
  const admin = await db.query("SELECT id FROM users WHERE username='arnaud'");
  assert(admin.rowCount === 1, "administrator account is unavailable");
  adminId = admin.rows[0].id;
  const apiSecret = `smoke-wordpress-${suffix}`;
  const primaryDomain = await db.query("SELECT id FROM domains WHERE is_primary=true LIMIT 1");
  const apiClient = await db.query(
    `INSERT INTO api_clients(name,token_prefix,token_hash,token_ciphertext,scopes,allowed_cidrs,domain_ids,created_by)
     VALUES($1,$2,$3,$4,$5,$6::cidr[],$7::uuid[],$8) RETURNING id`,
    [`WordPress Smoke ${suffix}`, `wpsmoke${suffix.slice(0,4)}`, sha256(apiSecret), encrypt(apiSecret), ["links:read"], ["127.0.0.1/32"], [primaryDomain.rows[0].id], adminId]
  );
  apiClientId = apiClient.rows[0].id;

  await db.query(
    `INSERT INTO sessions(token_hash,user_id,csrf_token,mfa_verified,ip_hash,user_agent,expires_at)
     VALUES($1,$2,$3,true,'smoke-profile','Shortlinker profile smoke',now()+interval '10 minutes'),
           ($4,$5,$6,true,'smoke-admin','Shortlinker admin smoke',now()+interval '10 minutes')`,
    [sha256(userToken), userId, userCsrf, sha256(adminToken), adminId, adminCsrf]
  );

  const initial = await request("/admin/profile", userToken);
  const initialHtml = await initial.text();
  assert(initial.status === 200, `profile page returned ${initial.status}`);
  assert(initialHtml.includes('data-sidebar-toggle') && initialHtml.includes('/assets/favicon.svg'), "profile chrome is incomplete");

  const selfUpdate = await request("/admin/profile", userToken, {
    method: "POST",
    body: new URLSearchParams({
      csrf_token: userCsrf,
      display_name: "Profil Test",
      username: `profile-${suffix}`,
      email: `profil-${suffix}@example.test`,
      locale: "fr"
    })
  });
  assert(selfUpdate.status === 303, `self profile update returned ${selfUpdate.status}`);

  const french = await request("/admin/profile", userToken);
  const frenchHtml = await french.text();
  assert(french.status === 200 && frenchHtml.includes('<html lang="fr">'), "French preference was not applied");
  assert(frenchHtml.includes("Informations personnelles") && frenchHtml.includes(`profil-${suffix}@example.test`), "French profile content is incomplete");

  const managedEmail = `managed-${suffix}@example.test`;
  const managedUpdate = await request(`/admin/users/${userId}/account`, adminToken, {
    method: "POST",
    body: new URLSearchParams({
      csrf_token: adminCsrf,
      display_name: "Managed Profile",
      username: `profile-${suffix}`,
      email: managedEmail,
      locale: "en"
    })
  });
  assert(managedUpdate.status === 303, `managed account update returned ${managedUpdate.status}`);
  const managed = await db.query("SELECT email::text,locale FROM users WHERE id=$1", [userId]);
  assert(managed.rows[0]?.email === managedEmail && managed.rows[0]?.locale === "en", "managed email update was not persisted");

  const settings = await request("/admin/settings", adminToken);
  const settingsHtml = await settings.text();
  assert(settings.status === 200 && settingsHtml.includes('name="days"') && settingsHtml.includes('max="365"'), "365-day retention control is unavailable");

  const legacy = await request("/admin/security", adminToken);
  assert(legacy.status === 308 && legacy.headers.get("location") === "/admin/profile", "legacy security URL does not redirect to profile");

  const apiClients = await request("/admin/api-clients", adminToken);
  const apiClientsHtml = await apiClients.text();
  assert(apiClients.status === 200 && apiClientsHtml.includes(`/admin/api-clients/${apiClientId}/wordpress`), "WordPress configuration action is unavailable");
  const wordpressConfig = await request(`/admin/api-clients/${apiClientId}/wordpress`, adminToken);
  const wordpressHtml = await wordpressConfig.text();
  assert(wordpressConfig.status === 200 && wordpressHtml.includes(apiSecret) && wordpressHtml.includes('WordPress connection block'), "reusable WordPress configuration is incomplete");

  console.log(JSON.stringify({ ok: true, profile: 200, locale: "fr", managedEmail: true, retentionMax: 365, legacyRedirect: 308, wordpressConfig: true }));
} finally {
  if (userId) {
    await db.query("DELETE FROM audit_logs WHERE actor_user_id=$1 OR target_id=$1::text", [userId]);
    await db.query("DELETE FROM users WHERE id=$1", [userId]);
  }
  if (adminId) {
    await db.query("DELETE FROM sessions WHERE user_id=$1 AND user_agent='Shortlinker admin smoke'", [adminId]);
  }
  if (apiClientId) {
    await db.query("DELETE FROM audit_logs WHERE api_client_id=$1 OR (target_type='api_client' AND target_id=$1::text)", [apiClientId]);
    await db.query("DELETE FROM api_clients WHERE id=$1", [apiClientId]);
  }
  await closeConnections();
}
