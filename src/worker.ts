import { randomUUID } from "node:crypto";
import { isbot } from "isbot";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import { closeConnections, db, getSetting, redis } from "./db.js";
import { encrypt, hmacIp } from "./crypto.js";
import { config } from "./config.js";
import { clampRetentionDays } from "./validation.js";

const group = "analytics";
const consumer = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

async function ensureGroup(): Promise<void> {
  if (redis.status === "wait") await redis.connect();
  try { await redis.xgroup("CREATE", "shortlinker:clicks", group, "$", "MKSTREAM"); }
  catch (error) { if (!String(error).includes("BUSYGROUP")) throw error; }
}

function fieldsToObject(fields: string[]): Record<string, string> {
  const value: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) value[fields[i]!] = fields[i + 1] ?? "";
  return value;
}

async function processEvent(id: string, event: Record<string, string>): Promise<void> {
  const ua = event.userAgent ?? "";
  const parser = new UAParser(ua);
  const parsed = parser.getResult();
  const robot = isbot(ua);
  const ip = (event.ip ?? "").replace(/^::ffff:/, "");
  const geo = geoip.lookup(ip);
  const timestamp = new Date(event.timestamp ?? Date.now());
  const day = timestamp.toISOString().slice(0, 10);
  const visitorHash = hmacIp(`${event.linkId}|${day}|${ip}`);
  const ipCiphertext = config.RAW_IP_RETENTION_DAYS > 0 ? encrypt(ip) : null;

  await db.query(
    `WITH inserted AS (
       INSERT INTO click_events
       (link_id, clicked_at, visitor_class, classification_reason, visitor_hash, ip_ciphertext,
        country_code, user_agent, browser, operating_system, device_type, referrer, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING link_id
     )
     UPDATE links SET click_count = click_count + $14 WHERE id = (SELECT link_id FROM inserted)`,
    [event.linkId, timestamp, robot ? "robot" : ua ? "human" : "unknown", robot ? "user-agent signature" : "no bot signature",
     visitorHash, ipCiphertext, geo?.country ?? null, ua.slice(0, 1024), parsed.browser.name ?? null,
     parsed.os.name ?? null, parsed.device.type ?? "desktop", (event.referrer ?? "").slice(0, 2048) || null, event.requestId || id,
     event.counted === "1" ? 0 : 1]
  );
}

async function cleanExpiredData(): Promise<void> {
  const privacy = await getSetting("privacy", { rawIpRetentionDays: config.RAW_IP_RETENTION_DAYS });
  const days = clampRetentionDays(privacy.rawIpRetentionDays);
  await db.query("UPDATE click_events SET ip_ciphertext = NULL WHERE ip_ciphertext IS NOT NULL AND clicked_at < now() - ($1 || ' days')::interval", [days]);
  await db.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'");
  await db.query("DELETE FROM login_challenges WHERE expires_at < now()");
  await db.query("DELETE FROM webauthn_challenges WHERE expires_at < now()");
}

async function main(): Promise<void> {
  await ensureGroup();
  let lastCleanup = 0;
  while (true) {
    if (Date.now() - lastCleanup > 3_600_000) { await cleanExpiredData(); lastCleanup = Date.now(); }
    const result = await redis.xreadgroup("GROUP", group, consumer, "COUNT", 100, "BLOCK", 5000, "STREAMS", "shortlinker:clicks", ">");
    if (!result) continue;
    for (const [, messages] of result as [string, [string, string[]][]][]) {
      for (const [id, fields] of messages) {
        try {
          await processEvent(id, fieldsToObject(fields));
          await redis.xack("shortlinker:clicks", group, id);
        } catch (error) { console.error("Click processing failed", { id, error }); }
      }
    }
  }
}

const shutdown = async () => { await closeConnections(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
main().catch(async (error) => { console.error(error); await closeConnections(); process.exit(1); });
