import { resolveTxt } from "node:dns/promises";
import { db } from "./db.js";
import { normalizeHostname } from "./validation.js";

export async function verifyDomain(domainId: string): Promise<{ verified: boolean; message: string }> {
  const result = await db.query<{ hostname: string; verification_token: string }>(
    "SELECT hostname::text, verification_token FROM domains WHERE id = $1", [domainId]
  );
  const domain = result.rows[0];
  if (!domain) return { verified: false, message: "Domain not found" };
  const name = `_shurl.${domain.hostname}`;
  const expected = `shurl-verification=${domain.verification_token}`;
  try {
    const records = await resolveTxt(name);
    const found = records.map((parts) => parts.join("")).some((value) => value.trim() === expected);
    if (!found) throw new Error(`Expected TXT value was not found at ${name}`);
    await db.query("UPDATE domains SET status = 'active', verified_at = now(), last_verification_error = NULL, updated_at = now() WHERE id = $1", [domainId]);
    return { verified: true, message: "Domain ownership verified and activated" };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "DNS verification failed";
    await db.query("UPDATE domains SET last_verification_error = $2, updated_at = now() WHERE id = $1", [domainId, message]);
    return { verified: false, message };
  }
}

export async function isDomainAllowedForTls(raw: string): Promise<boolean> {
  try {
    const hostname = normalizeHostname(raw);
    const result = await db.query("SELECT 1 FROM domains WHERE hostname = $1 AND status = 'active' AND verified_at IS NOT NULL", [hostname]);
    return Boolean(result.rowCount);
  } catch { return false; }
}
