import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, redis } from "../db.js";
import { ipMatchesCidrs } from "../auth.js";
import { audit } from "../audit.js";
import { generateSlug, parseTags, validateDestination, validateSlug } from "../validation.js";
import { invalidateLink } from "../links.js";
import { sha256 } from "../crypto.js";

type ApiClient = {
  id: string; scopes: string[]; allowed_cidrs: string[]; domain_ids: string[];
  rate_limit_per_minute: number;
};

async function authenticate(request: FastifyRequest, reply: FastifyReply, scope: string): Promise<ApiClient | null> {
  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    await reply.code(401).send({ error: { code: "unauthorized", message: "Bearer token required" } });
    return null;
  }
  const token = authorization.slice(7);
  const result = await db.query<ApiClient>(
    `SELECT id, scopes, allowed_cidrs::text[], domain_ids, rate_limit_per_minute
     FROM api_clients WHERE token_hash=$1 AND status='active' AND (expires_at IS NULL OR expires_at>now())`, [sha256(token)]
  );
  const client = result.rows[0];
  if (!client || !client.scopes.includes(scope)) {
    await audit(request, "api.auth.denied", { apiClientId: client?.id, outcome: "failure", metadata: { scope } });
    await reply.code(403).send({ error: { code: "forbidden", message: "Invalid token or missing scope" } });
    return null;
  }
  if (client.allowed_cidrs.length && !ipMatchesCidrs(request.ip, client.allowed_cidrs)) {
    await audit(request, "api.ip.denied", { apiClientId: client.id, outcome: "failure" });
    await reply.code(403).send({
      error: { code: "ip_not_allowed", message: `Source IP is not allowed (observed: ${request.ip})`, observedIp: request.ip }
    });
    return null;
  }
  try {
    if (redis.status === "wait") await redis.connect();
    const minute = Math.floor(Date.now() / 60_000);
    const key = `shortlinker:api-rate:${client.id}:${minute}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120);
    reply.header("x-ratelimit-limit", client.rate_limit_per_minute).header("x-ratelimit-remaining", Math.max(0, client.rate_limit_per_minute - count));
    if (count > client.rate_limit_per_minute) {
      await reply.code(429).header("retry-after", 60).send({ error: { code: "rate_limited", message: "Rate limit exceeded" } });
      return null;
    }
  } catch { /* database authorization remains enforced if Redis is unavailable */ }
  void db.query("UPDATE api_clients SET last_used_at=now(), last_ip=$2 WHERE id=$1", [client.id, request.ip]);
  return client;
}

function normalizeCreatePayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    ...input,
    domain: input.domain ?? input.hostname,
    destination: input.destination ?? input.url ?? input.target,
    slug: input.slug ?? input.shortcode ?? input.code,
    redirectType: input.redirectType ?? input.redirect_type,
    expiresAt: input.expiresAt ?? input.expires_at,
    maxClicks: input.maxClicks ?? input.max_clicks,
    passQuery: input.passQuery ?? input.pass_query,
  };
  if (normalized.slug === null || normalized.slug === "") delete normalized.slug;
  if (normalized.redirectType === null || normalized.redirectType === "") delete normalized.redirectType;
  if (normalized.expiresAt === null || normalized.expiresAt === "") delete normalized.expiresAt;
  if (normalized.maxClicks === null || normalized.maxClicks === "") delete normalized.maxClicks;
  if (normalized.passQuery === null || normalized.passQuery === "") delete normalized.passQuery;
  if (normalized.tags === null || normalized.tags === "") delete normalized.tags;
  if (typeof normalized.redirectType === "string" && /^\d+$/.test(normalized.redirectType)) normalized.redirectType = Number(normalized.redirectType);
  if (typeof normalized.maxClicks === "string" && /^\d+$/.test(normalized.maxClicks)) normalized.maxClicks = Number(normalized.maxClicks);
  if (typeof normalized.passQuery === "string") normalized.passQuery = ["1", "true", "yes", "on"].includes(normalized.passQuery.toLowerCase());
  if (typeof normalized.tags === "string") normalized.tags = normalized.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  return normalized;
}

const createObjectSchema = z.object({
  domain: z.string().min(3).max(253),
  destination: z.url().max(4096),
  slug: z.string().optional(),
  redirectType: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).default(302),
  expiresAt: z.iso.datetime().optional(),
  maxClicks: z.number().int().positive().max(2_147_483_647).optional(),
  passQuery: z.boolean().default(false),
  tags: z.array(z.string().max(50)).max(20).default([])
});

const createSchema = z.preprocess(normalizeCreatePayload, createObjectSchema);

const statsBatchSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(100)
});

const createBatchSchema = z.object({
  links: z.array(z.preprocess(normalizeCreatePayload, createObjectSchema.extend({ reference: z.string().min(1).max(64) }))).min(1).max(50)
});

function validationError(error: z.ZodError) {
  const message = error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
  return { error: { code: "validation_error", message: message || "Request validation failed", details: error.flatten() } };
}

export const apiRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/v1", async (_request, reply) => reply.send({ name: "Shortlinker API", version: "v1", documentation: "https://shurl.be/api/v1/openapi.json" }));

  app.get("/api/v1/domains", async (request, reply) => {
    const client = await authenticate(request, reply, "domains:read");
    if (!client) return;
    const result = await db.query(
      "SELECT id, hostname::text, status, is_primary, verified_at FROM domains WHERE status='active' AND ($1::uuid[]='{}' OR id=ANY($1)) ORDER BY hostname", [client.domain_ids]
    );
    return reply.send({ data: result.rows });
  });

  app.get("/api/v1/links", async (request, reply) => {
    const client = await authenticate(request, reply, "links:read");
    if (!client) return;
    const query = request.query as { page?: string; limit?: string; domain?: string };
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const result = await db.query(
      `SELECT l.id, d.hostname::text AS domain, l.slug, l.destination, l.redirect_type AS "redirectType",
              l.status, l.click_count AS "clickCount", l.created_at AS "createdAt", l.expires_at AS "expiresAt", l.tags
       FROM links l JOIN domains d ON d.id=l.domain_id
       WHERE l.deleted_at IS NULL AND ($1::uuid[]='{}' OR d.id=ANY($1)) AND ($2::text IS NULL OR d.hostname=$2)
       ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`, [client.domain_ids, query.domain ?? null, limit, (page - 1) * limit]
    );
    return reply.send({ data: result.rows, pagination: { page, limit, hasNext: result.rows.length === limit } });
  });

  app.post("/api/v1/links", async (request, reply) => {
    const client = await authenticate(request, reply, "links:write");
    if (!client) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      await audit(request, "api.validation.denied", {
        apiClientId: client.id, outcome: "failure",
        metadata: { endpoint: "links.create", fields: parsed.error.issues.map((issue) => issue.path.join(".") || "request") }
      });
      return reply.code(422).send(validationError(parsed.error));
    }
    const input = parsed.data;
    const requestHash = sha256(JSON.stringify(input));
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").slice(0, 128);
    if (idempotencyKey) {
      const existing = await db.query<{ request_hash: string; status_code: number; response: unknown }>(
        "SELECT request_hash,status_code,response FROM api_idempotency WHERE api_client_id=$1 AND idempotency_key=$2", [client.id, idempotencyKey]
      );
      const cached = existing.rows[0];
      if (cached) {
        if (cached.request_hash !== requestHash) return reply.code(409).send({ error: { code: "idempotency_conflict", message: "Key was used with a different request" } });
        return reply.code(cached.status_code).send(cached.response);
      }
    }
    const domain = await db.query<{ id: string; hostname: string }>(
      "SELECT id,hostname::text FROM domains WHERE hostname=$1 AND status='active' AND ($2::uuid[]='{}' OR id=ANY($2))", [input.domain.toLowerCase(), client.domain_ids]
    );
    if (!domain.rows[0]) return reply.code(403).send({ error: { code: "domain_not_allowed", message: "Domain unavailable for this API client" } });
    const allDomains = await db.query<{ hostname: string }>("SELECT hostname::text FROM domains");
    let slug = input.slug ? validateSlug(input.slug) : generateSlug();
    const destination = validateDestination(input.destination, allDomains.rows.map((row) => row.hostname));
    let created: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const result = await db.query(
          `INSERT INTO links (domain_id,slug,destination,redirect_type,expires_at,max_clicks,pass_query,tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,slug,destination,status,created_at AS "createdAt"`,
          [domain.rows[0].id, slug, destination, input.redirectType, input.expiresAt ?? null, input.maxClicks ?? null, input.passQuery, input.tags]
        );
        created = { ...result.rows[0], domain: domain.rows[0].hostname, shortUrl: `https://${domain.rows[0].hostname}/${slug}` };
        break;
      } catch (error) {
        if (String(error).includes("links_domain_id_slug_key") && !input.slug) { slug = generateSlug(); continue; }
        if (String(error).includes("links_domain_id_slug_key")) return reply.code(409).send({ error: { code: "slug_exists", message: "Slug already exists" } });
        throw error;
      }
    }
    if (!created) return reply.code(503).send({ error: { code: "slug_generation_failed", message: "Unable to allocate a unique slug" } });
    const response = { data: created };
    if (idempotencyKey) await db.query(
      "INSERT INTO api_idempotency (api_client_id,idempotency_key,request_hash,status_code,response) VALUES ($1,$2,$3,201,$4::jsonb)",
      [client.id, idempotencyKey, requestHash, JSON.stringify(response)]
    );
    await audit(request, "api.link.created", { apiClientId: client.id, targetType: "link", targetId: String(created.id) });
    return reply.code(201).send(response);
  });

  app.post("/api/v1/links/batch", async (request, reply) => {
    const client = await authenticate(request, reply, "links:write");
    if (!client) return;
    const parsed = createBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      await audit(request, "api.validation.denied", {
        apiClientId: client.id, outcome: "failure",
        metadata: { endpoint: "links.batch", fields: parsed.error.issues.map((issue) => issue.path.join(".") || "request") }
      });
      return reply.code(422).send(validationError(parsed.error));
    }
    const requestHash = sha256(JSON.stringify(parsed.data));
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").slice(0, 128);
    if (idempotencyKey) {
      const existing = await db.query<{ request_hash: string; status_code: number; response: unknown }>(
        "SELECT request_hash,status_code,response FROM api_idempotency WHERE api_client_id=$1 AND idempotency_key=$2", [client.id, idempotencyKey]
      );
      const cached = existing.rows[0];
      if (cached) {
        if (cached.request_hash !== requestHash) return reply.code(409).send({ error: { code: "idempotency_conflict", message: "Key was used with a different request" } });
        return reply.code(cached.status_code).send(cached.response);
      }
    }
    const requestedDomains = [...new Set(parsed.data.links.map((item) => item.domain.toLowerCase()))];
    const domainRows = await db.query<{ id: string; hostname: string }>(
      "SELECT id,hostname::text FROM domains WHERE hostname=ANY($1::text[]) AND status='active' AND ($2::uuid[]='{}' OR id=ANY($2))",
      [requestedDomains, client.domain_ids]
    );
    const domainByHostname = new Map(domainRows.rows.map((row) => [row.hostname, row]));
    const allDomains = await db.query<{ hostname: string }>("SELECT hostname::text FROM domains");
    const knownHostnames = allDomains.rows.map((row) => row.hostname);
    const items: Array<Record<string, unknown>> = [];
    for (const input of parsed.data.links) {
      try {
        const domain = domainByHostname.get(input.domain.toLowerCase());
        if (!domain) { items.push({ reference: input.reference, status: "error", message: "Domain unavailable for this API client" }); continue; }
        const destination = validateDestination(input.destination, knownHostnames);
        let slug = input.slug ? validateSlug(input.slug) : generateSlug();
        let created: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            const result = await db.query(
              `INSERT INTO links (domain_id,slug,destination,redirect_type,expires_at,max_clicks,pass_query,tags)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,slug,destination,status,created_at AS "createdAt"`,
              [domain.id, slug, destination, input.redirectType, input.expiresAt ?? null, input.maxClicks ?? null, input.passQuery, input.tags]
            );
            created = { ...result.rows[0], domain: domain.hostname, shortUrl: `https://${domain.hostname}/${slug}` };
            break;
          } catch (error) {
            if (String(error).includes("links_domain_id_slug_key") && !input.slug) { slug = generateSlug(); continue; }
            throw error;
          }
        }
        if (!created) throw new Error("Unable to allocate a unique slug");
        items.push({ reference: input.reference, status: "success", data: created });
        await audit(request, "api.link.created", { apiClientId: client.id, targetType: "link", targetId: String(created.id), metadata: { batch: true } });
      } catch (error) {
        items.push({ reference: input.reference, status: "error", message: error instanceof Error ? error.message : "Creation failed" });
      }
    }
    const response = { data: { items } };
    if (idempotencyKey) await db.query(
      "INSERT INTO api_idempotency (api_client_id,idempotency_key,request_hash,status_code,response) VALUES ($1,$2,$3,200,$4::jsonb)",
      [client.id, idempotencyKey, requestHash, JSON.stringify(response)]
    );
    return reply.send(response);
  });

  app.get<{ Params: { id: string } }>("/api/v1/links/:id/stats", async (request, reply) => {
    const client = await authenticate(request, reply, "stats:read");
    if (!client) return;
    const allowed = await db.query("SELECT 1 FROM links WHERE id=$1 AND ($2::uuid[]='{}' OR domain_id=ANY($2))", [request.params.id, client.domain_ids]);
    if (!allowed.rowCount) return reply.code(404).send({ error: { code: "not_found", message: "Link not found" } });
    const result = await db.query(
      `SELECT count(*)::bigint AS clicks, count(DISTINCT visitor_hash)::bigint AS unique_visitors,
              count(*) FILTER (WHERE visitor_class='human')::bigint AS humans,
              count(*) FILTER (WHERE visitor_class='robot')::bigint AS robots
       FROM click_events WHERE link_id=$1`, [request.params.id]
    );
    const countries = await db.query(
      "SELECT country_code, count(*)::bigint AS clicks FROM click_events WHERE link_id=$1 GROUP BY country_code ORDER BY clicks DESC LIMIT 20", [request.params.id]
    );
    const timeline = await db.query(
      "SELECT to_char(date_trunc('day',clicked_at),'YYYY-MM-DD') AS day,count(*)::bigint AS clicks FROM click_events WHERE link_id=$1 AND clicked_at>=now()-interval '29 days' GROUP BY 1 ORDER BY 1", [request.params.id]
    );
    const browsers = await db.query(
      "SELECT coalesce(nullif(browser,''),'Unknown') AS name,count(*)::bigint AS clicks FROM click_events WHERE link_id=$1 GROUP BY 1 ORDER BY clicks DESC LIMIT 10", [request.params.id]
    );
    const devices = await db.query(
      "SELECT coalesce(nullif(device_type,''),'Unknown') AS name,count(*)::bigint AS clicks FROM click_events WHERE link_id=$1 GROUP BY 1 ORDER BY clicks DESC LIMIT 10", [request.params.id]
    );
    const referrers = await db.query(
      "SELECT coalesce(nullif(referrer,''),'Direct') AS name,count(*)::bigint AS clicks FROM click_events WHERE link_id=$1 GROUP BY 1 ORDER BY clicks DESC LIMIT 10", [request.params.id]
    );
    return reply.send({ data: { ...result.rows[0], countries: countries.rows, timeline: timeline.rows, browsers: browsers.rows, devices: devices.rows, referrers: referrers.rows } });
  });

  app.post("/api/v1/stats/batch", async (request, reply) => {
    const client = await authenticate(request, reply, "stats:read");
    if (!client) return;
    const parsed = statsBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: "validation_error", details: parsed.error.flatten() } });
    const allowed = await db.query<{ id: string }>(
      `SELECT id FROM links WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL
       AND ($2::uuid[]='{}' OR domain_id=ANY($2))`, [parsed.data.ids, client.domain_ids]
    );
    const ids = allowed.rows.map((row) => row.id);
    if (!ids.length) return reply.send({ data: { links: [], countries: [], timeline: [], browsers: [], devices: [], referrers: [] } });
    const [links, countries, timeline, browsers, devices, referrers] = await Promise.all([
      db.query(
        `SELECT l.id, count(e.link_id)::bigint AS clicks,
                count(DISTINCT e.visitor_hash)::bigint AS unique_visitors,
                count(e.link_id) FILTER (WHERE e.visitor_class='human')::bigint AS humans,
                count(e.link_id) FILTER (WHERE e.visitor_class='robot')::bigint AS robots
         FROM links l LEFT JOIN click_events e ON e.link_id=l.id
         WHERE l.id=ANY($1::uuid[]) GROUP BY l.id`, [ids]
      ),
      db.query(
        "SELECT country_code,count(*)::bigint AS clicks FROM click_events WHERE link_id=ANY($1::uuid[]) GROUP BY country_code ORDER BY clicks DESC LIMIT 20", [ids]
      ),
      db.query(
        "SELECT to_char(date_trunc('day',clicked_at),'YYYY-MM-DD') AS day,count(*)::bigint AS clicks FROM click_events WHERE link_id=ANY($1::uuid[]) AND clicked_at>=now()-interval '29 days' GROUP BY 1 ORDER BY 1", [ids]
      ),
      db.query(
        "SELECT coalesce(nullif(browser,''),'Unknown') AS name,count(*)::bigint AS clicks FROM click_events WHERE link_id=ANY($1::uuid[]) GROUP BY 1 ORDER BY clicks DESC LIMIT 10", [ids]
      ),
      db.query(
        "SELECT coalesce(nullif(device_type,''),'Unknown') AS name,count(*)::bigint AS clicks FROM click_events WHERE link_id=ANY($1::uuid[]) GROUP BY 1 ORDER BY clicks DESC LIMIT 10", [ids]
      ),
      db.query(
        "SELECT coalesce(nullif(referrer,''),'Direct') AS name,count(*)::bigint AS clicks FROM click_events WHERE link_id=ANY($1::uuid[]) GROUP BY 1 ORDER BY clicks DESC LIMIT 10", [ids]
      )
    ]);
    return reply.send({ data: {
      links: links.rows, countries: countries.rows, timeline: timeline.rows,
      browsers: browsers.rows, devices: devices.rows, referrers: referrers.rows
    } });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/links/:id", async (request, reply) => {
    const client = await authenticate(request, reply, "links:delete");
    if (!client) return;
    const result = await db.query<{ hostname: string; slug: string }>(
      `UPDATE links l SET status='deleted',deleted_at=now(),updated_at=now()
       FROM domains d WHERE l.id=$1 AND d.id=l.domain_id AND ($2::uuid[]='{}' OR d.id=ANY($2))
       RETURNING d.hostname::text,l.slug`, [request.params.id, client.domain_ids]
    );
    const link = result.rows[0];
    if (!link) return reply.code(404).send({ error: { code: "not_found", message: "Link not found" } });
    await invalidateLink(link.hostname, link.slug);
    await audit(request, "api.link.deleted", { apiClientId: client.id, targetType: "link", targetId: request.params.id });
    return reply.code(204).send();
  });

  app.get("/api/v1/openapi.json", async (_request, reply) => reply.send({
    openapi: "3.1.0", info: { title: "Shortlinker API", version: "1.0.0" },
    servers: [{ url: "https://shurl.be/api/v1" }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } }, security: [{ bearerAuth: [] }],
    paths: {
      "/links": { get: { summary: "List links" }, post: { summary: "Create a shortlink" } },
      "/links/batch": { post: { summary: "Create up to 50 shortlinks in one request" } },
      "/links/{id}/stats": { get: { summary: "Read link analytics" } },
      "/stats/batch": { post: { summary: "Read analytics for up to 100 links in one request" } },
      "/links/{id}": { delete: { summary: "Delete a link" } },
      "/domains": { get: { summary: "List available domains" } }
    }
  }));
};
