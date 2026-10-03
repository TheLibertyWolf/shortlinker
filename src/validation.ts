import { randomInt } from "node:crypto";
import { domainToASCII } from "node:url";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const reservedSlugs = new Set([
  "admin", "api", "auth", "assets", "health", "metrics", "robots.txt", "favicon.ico",
  "privacy", "terms", "report", "abuse", ".well-known"
]);

export function generateSlug(length = 7): string {
  let value = "";
  for (let i = 0; i < length; i += 1) value += alphabet[randomInt(0, alphabet.length)];
  return value;
}

export function validateSlug(raw: string): string {
  const slug = raw.trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(slug)) throw new Error("Slug must contain 3–64 letters, numbers, underscores or hyphens");
  if (reservedSlugs.has(slug.toLowerCase())) throw new Error("This slug is reserved");
  return slug;
}

export function normalizeHostname(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  const hostname = domainToASCII(value);
  if (!hostname || hostname.length > 253 || !hostname.includes(".")) throw new Error("Invalid domain name");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error("Invalid domain name");
  }
  return hostname;
}

export function validateHomepageRedirect(raw: string, attachedHostname: string): string {
  const value = raw.trim();
  if (!value) return "";
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Homepage redirect must be a valid absolute URL"); }
  if (url.protocol !== "https:") throw new Error("Homepage redirect must use HTTPS");
  if (url.username || url.password) throw new Error("Homepage redirect cannot contain credentials");
  if (url.hostname.toLowerCase() === normalizeHostname(attachedHostname)) {
    throw new Error("Homepage redirect cannot point to the attached domain itself");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateDestination(raw: string, platformDomains: string[] = []): string {
  const value = raw.trim();
  if (value.length > 4096) throw new Error("Destination is too long");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Destination must be a valid absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS destinations are accepted");
  if (url.username || url.password) throw new Error("URLs containing embedded credentials are not accepted");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("Local destinations are not accepted");
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i.test(host)) throw new Error("Private destinations are not accepted");
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error("Private destinations are not accepted");
  if (platformDomains.includes(host) && /^\/[A-Za-z0-9_-]{3,64}$/.test(url.pathname)) throw new Error("Shortlink loops are not accepted");
  return url.toString();
}

export function appendAllowedQuery(destination: string, incoming: URLSearchParams): string {
  const target = new URL(destination);
  for (const [key, value] of incoming) {
    if (!["url", "redirect", "destination"].includes(key.toLowerCase())) target.searchParams.append(key, value);
  }
  return target.toString();
}

export function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

export function clampRetentionDays(value: unknown): number {
  const days = Number(value);
  if (!Number.isFinite(days)) return 0;
  return Math.max(0, Math.min(365, Math.trunc(days)));
}
