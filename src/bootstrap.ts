import { domainToASCII } from "node:url";
import { db, closeConnections } from "./db.js";
import { config } from "./config.js";
import { hashPassword, randomToken } from "./crypto.js";

async function main(): Promise<void> {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@shurl.be").trim().toLowerCase();
  const username = (process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error("BOOTSTRAP_ADMIN_USERNAME is invalid");
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password || password.length < 16) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must contain at least 16 characters");
  const displayName = process.env.BOOTSTRAP_ADMIN_NAME ?? "Administrator";
  const suppliedTokens = new Map(
    (process.env.DOMAIN_VERIFICATION_TOKENS ?? "").split(",").filter(Boolean).map((entry) => {
      const separator = entry.indexOf(":");
      return [entry.slice(0, separator).toLowerCase(), entry.slice(separator + 1)] as const;
    })
  );
  const passwordHash = await hashPassword(password);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (email, username, display_name, password_hash, require_password_change)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name
       RETURNING id`,
      [email, username, displayName, passwordHash]
    );
    const userId = userResult.rows[0]!.id;
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE name = 'Super Admin'
       ON CONFLICT DO NOTHING`, [userId]
    );

    const domains = [config.PRIMARY_DOMAIN, ...config.secondaryDomains];
    for (const rawDomain of domains) {
      const hostname = domainToASCII(rawDomain.toLowerCase());
      const token = suppliedTokens.get(hostname) || randomToken(24);
      await client.query(
        `INSERT INTO domains (hostname, status, is_primary, verification_token, homepage_redirect, created_by)
         VALUES ($1, 'pending', $2, $3, $4, $5)
         ON CONFLICT (hostname) DO NOTHING`,
        [hostname, hostname === config.PRIMARY_DOMAIN, token, hostname === config.PRIMARY_DOMAIN ? null : config.PUBLIC_ORIGIN, userId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const domains = await db.query("SELECT hostname, verification_token FROM domains ORDER BY is_primary DESC, hostname");
  console.log("Bootstrap complete. Required DNS records:");
  for (const domain of domains.rows) {
    console.log(`_shurl.${domain.hostname} TXT shurl-verification=${domain.verification_token}`);
  }
}

main().then(closeConnections).catch(async (error) => {
  console.error(error);
  await closeConnections();
  process.exit(1);
});
