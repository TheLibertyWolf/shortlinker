import pg from "pg";
import { Redis } from "ioredis";
import { config } from "./config.js";

pg.types.setTypeParser(20, (value) => Number(value));

export const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "shortlinker"
});

db.on("error", (error) => console.error("Unexpected PostgreSQL pool error", error));

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: true
});

export async function closeConnections(): Promise<void> {
  await Promise.allSettled([db.end(), redis.quit()]);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const result = await db.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? fallback;
}

export async function setSetting(key: string, value: unknown, actorId?: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), actorId ?? null]
  );
}
