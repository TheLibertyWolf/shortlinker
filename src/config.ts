import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PUBLIC_ORIGIN: z.url().default("https://shurl.be"),
  PRIMARY_DOMAIN: z.string().default("shurl.be"),
  SECONDARY_DOMAINS: z.string().default("ctrdv.click"),
  ADMIN_ALLOWED_CIDRS: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(40),
  IP_HASH_KEY: z.string().min(40),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  RAW_IP_RETENTION_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  TRUST_PROXY: z.string().default("127.0.0.1"),
  WEBAUTHN_RP_ID: z.string().default("shurl.be"),
  WEBAUTHN_RP_NAME: z.string().default("Shortlinker"),
  LOG_LEVEL: z.string().default("info")
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const raw = parsed.data;

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return key;
}

export const config = {
  ...raw,
  appEncryptionKey: decodeKey(raw.APP_ENCRYPTION_KEY, "APP_ENCRYPTION_KEY"),
  ipHashKey: decodeKey(raw.IP_HASH_KEY, "IP_HASH_KEY"),
  adminAllowedCidrs: raw.ADMIN_ALLOWED_CIDRS.split(",").map((v) => v.trim()).filter(Boolean),
  secondaryDomains: raw.SECONDARY_DOMAINS.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
  isProduction: raw.NODE_ENV === "production"
};
