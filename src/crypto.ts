import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { config } from "./config.js";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacIp(value: string): string {
  return createHmac("sha256", config.ipHashKey).update(value).digest("hex");
}

export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.appEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decrypt(payload: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = payload.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", config.appEncryptionKey, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
}

export async function hashPassword(value: string): Promise<string> {
  return argon2.hash(value, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
}

export async function verifyPassword(hash: string, value: string): Promise<boolean> {
  try { return await argon2.verify(hash, value); } catch { return false; }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
