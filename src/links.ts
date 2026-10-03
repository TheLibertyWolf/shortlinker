import { db, redis } from "./db.js";

export type ResolvedLink = {
  id: string;
  destination: string;
  redirectType: 301 | 302 | 307 | 308;
  passQuery: boolean;
  status: string;
  activeFrom: string | null;
  expiresAt: string | null;
  maxClicks: number | null;
  clickCount: number;
};

export async function resolveLink(hostname: string, slug: string): Promise<ResolvedLink | null> {
  const key = `shortlinker:link:${hostname}:${slug}`;
  try {
    if (redis.status === "wait") await redis.connect();
    const cached = await redis.get(key);
    if (cached === "-") return null;
    if (cached) return JSON.parse(cached) as ResolvedLink;
  } catch { /* PostgreSQL remains the source of truth. */ }

  const result = await db.query<{
    id: string; destination: string; redirect_type: 301 | 302 | 307 | 308; pass_query: boolean;
    status: string; active_from: Date | null; expires_at: Date | null; max_clicks: number | null; click_count: number;
  }>(
    `SELECT l.id, l.destination, l.redirect_type, l.pass_query, l.status, l.active_from,
            l.expires_at, l.max_clicks, l.click_count
     FROM links l JOIN domains d ON d.id = l.domain_id
     WHERE d.hostname = $1 AND d.status = 'active' AND l.slug = $2 AND l.deleted_at IS NULL`,
    [hostname, slug]
  );
  const row = result.rows[0];
  if (!row) {
    try { await redis.set(key, "-", "EX", 15); } catch { /* no-op */ }
    return null;
  }
  const link: ResolvedLink = {
    id: row.id, destination: row.destination, redirectType: row.redirect_type, passQuery: row.pass_query,
    status: row.status, activeFrom: row.active_from?.toISOString() ?? null, expiresAt: row.expires_at?.toISOString() ?? null,
    maxClicks: row.max_clicks, clickCount: row.click_count
  };
  try { await redis.set(key, JSON.stringify(link), "EX", 300); } catch { /* no-op */ }
  return link;
}

export async function invalidateLink(hostname: string, slug: string): Promise<void> {
  try {
    if (redis.status === "wait") await redis.connect();
    await redis.del(`shortlinker:link:${hostname}:${slug}`);
  } catch { /* cache expiry is the fallback */ }
}
