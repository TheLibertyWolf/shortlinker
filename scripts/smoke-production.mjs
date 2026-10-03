import { randomBytes } from "node:crypto";
import { db, closeConnections } from "../dist/db.js";
import { sha256 } from "../dist/crypto.js";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const hostname = process.env.SMOKE_HOSTNAME ?? "shurl.be";
const allowedIp = process.env.SMOKE_ALLOWED_IP ?? "82.125.126.40";
const token = `shurl_smoke_${randomBytes(24).toString("base64url")}`;
const slug = `smoke-${Date.now().toString(36)}`;
const idempotencyKey = `smoke-${randomBytes(12).toString("hex")}`;
let clientId;
let linkId;

const apiHeaders = {
  authorization: `Bearer ${token}`,
  host: hostname,
  "x-forwarded-host": hostname,
  "x-forwarded-for": allowedIp,
  "x-forwarded-proto": "https"
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...options,
    headers: { ...apiHeaders, ...options.headers }
  });
}

try {
  const inserted = await db.query(
    `INSERT INTO api_clients
       (name, token_prefix, token_hash, scopes, allowed_cidrs, rate_limit_per_minute)
     VALUES ($1,$2,$3,$4,$5::cidr[],120) RETURNING id`,
    ["Production smoke test", "smoke", sha256(token), ["links:read", "links:write", "links:delete", "stats:read", "domains:read"], [`${allowedIp}/32`]]
  );
  clientId = inserted.rows[0].id;

  const domainsResponse = await api("/api/v1/domains");
  assert(domainsResponse.status === 200, `domain list returned ${domainsResponse.status}`);
  const domains = await domainsResponse.json();
  assert(domains.data.some((domain) => domain.hostname === hostname), "primary domain is unavailable to API client");

  const payload = { domain: hostname, destination: "https://example.com/shortlinker-smoke", slug, tags: ["smoke-test"] };
  const createResponse = await api("/api/v1/links", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(payload)
  });
  assert(createResponse.status === 201, `link creation returned ${createResponse.status}`);
  const created = await createResponse.json();
  linkId = created.data.id;

  const repeatResponse = await api("/api/v1/links", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(payload)
  });
  const repeated = await repeatResponse.json();
  assert(repeatResponse.status === 201 && repeated.data.id === linkId, "idempotency replay did not return the original resource");

  const redirectResponse = await fetch(`${baseUrl}/${slug}`, {
    redirect: "manual",
    headers: {
      host: hostname,
      "x-forwarded-host": hostname,
      "user-agent": "Mozilla/5.0 ShortlinkerSmoke/1.0",
      "x-forwarded-for": "8.8.8.8",
      "x-forwarded-proto": "https"
    }
  });
  assert(redirectResponse.status === 302, `redirect returned ${redirectResponse.status}`);
  assert(redirectResponse.headers.get("location") === "https://example.com/shortlinker-smoke", "redirect destination differs");

  let stats;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const statsResponse = await api(`/api/v1/links/${linkId}/stats`);
    assert(statsResponse.status === 200, `stats returned ${statsResponse.status}`);
    stats = await statsResponse.json();
    if (Number(stats.data.clicks) >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(Number(stats?.data.clicks) >= 1, "analytics worker did not persist the click in time");

  const deleteResponse = await api(`/api/v1/links/${linkId}`, { method: "DELETE" });
  assert(deleteResponse.status === 204, `link deletion returned ${deleteResponse.status}`);

  console.log(JSON.stringify({ ok: true, domains: domains.data.length, redirect: redirectResponse.status, clicks: Number(stats.data.clicks) }));
} finally {
  if (linkId) await db.query("DELETE FROM links WHERE id=$1", [linkId]);
  if (clientId) {
    await db.query("DELETE FROM audit_logs WHERE api_client_id=$1", [clientId]);
    await db.query("DELETE FROM api_clients WHERE id=$1", [clientId]);
  }
  await closeConnections();
}
