import type { FastifyRequest } from "fastify";
import { db } from "./db.js";
import { hmacIp } from "./crypto.js";

export async function audit(
  request: FastifyRequest | null,
  action: string,
  options: {
    actorUserId?: string;
    apiClientId?: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
    outcome?: "success" | "failure";
  } = {}
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs
       (actor_user_id, api_client_id, action, target_type, target_id, ip_hash, metadata, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [options.actorUserId ?? null, options.apiClientId ?? null, action, options.targetType ?? null,
       options.targetId ?? null, request ? hmacIp(request.ip) : null,
       JSON.stringify(options.metadata ?? {}), options.outcome ?? "success"]
    );
  } catch (error) {
    console.error("Audit write failed", error);
  }
}
