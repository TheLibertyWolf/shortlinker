import type { FastifyRequest } from "fastify";
import { redis } from "./db.js";

export async function queueClick(request: FastifyRequest, linkId: string, counted = false): Promise<void> {
  try {
    if (redis.status === "wait") await redis.connect();
    await redis.xadd(
      "shortlinker:clicks", "MAXLEN", "~", "100000", "*",
      "linkId", linkId,
      "timestamp", new Date().toISOString(),
      "ip", request.ip,
      "userAgent", String(request.headers["user-agent"] ?? "").slice(0, 1024),
      "referrer", String(request.headers.referer ?? "").slice(0, 2048),
      "requestId", String(request.id)
      , "counted", counted ? "1" : "0"
    );
  } catch (error) {
    request.log.warn({ err: error, linkId }, "Unable to enqueue click analytics");
  }
}
