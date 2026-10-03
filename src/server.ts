import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { db, redis, closeConnections } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { apiRoutes } from "./routes/api.js";
import { publicRoutes } from "./routes/public.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
  bodyLimit: 64 * 1024,
  requestIdHeader: "x-request-id",
  disableRequestLogging: config.NODE_ENV === "test"
});

await app.register(cookie);
await app.register(formbody);
await app.register(helmet, {
  global: true,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://challenges.cloudflare.com"],
      frameSrc: ["https://challenges.cloudflare.com"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  hsts: { maxAge: 31_536_000, includeSubDomains: false, preload: false },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
});
await app.register(fastifyStatic, {
  root: join(root, "public", "assets"),
  prefix: "/assets/",
  maxAge: config.isProduction ? "1h" : 0,
  immutable: false,
  setHeaders: (response, pathName) => {
    if (pathName.endsWith("sw.js")) {
      response.header("Service-Worker-Allowed", "/");
      response.header("Cache-Control", "no-cache");
    }
  }
});

app.get("/sw.js", async (_request, reply) => {
  return reply.header("Service-Worker-Allowed", "/").header("Cache-Control", "no-cache").type("application/javascript").sendFile("sw.js");
});

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/auth/") || request.url.startsWith("/admin")) {
    reply.header("Cache-Control", "no-store");
  }
  if (!config.isProduction) return;
  if (["127.0.0.1", "::1"].includes(request.ip) && (request.url === "/health" || request.url.startsWith("/internal/caddy/ask"))) return;
  const proto = request.headers["x-forwarded-proto"];
  if (proto !== "https") {
    const hostname = request.hostname.replace(/:\d+$/, "");
    return reply.redirect(`https://${hostname}${request.url}`, 308);
  }
});

await app.register(authRoutes);
await app.register(adminRoutes);
await app.register(apiRoutes);
await app.register(publicRoutes);

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error, requestId: request.id }, "Request failed");
  const candidateStatus = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
  const statusCode = candidateStatus >= 400 && candidateStatus < 500 ? candidateStatus : 500;
  const message = error instanceof Error ? error.message : "Request could not be completed";
  if (request.url.startsWith("/api/")) {
    return reply.code(statusCode).send({
      error: { code: statusCode < 500 ? "request_error" : "internal_error", message: statusCode < 500 ? message : "Request could not be completed", requestId: request.id }
    });
  }
  return reply.code(statusCode).type("text/plain").send("Request could not be completed.");
});

async function start(): Promise<void> {
  await db.query("SELECT 1");
  try { if (redis.status === "wait") await redis.connect(); } catch (error) { app.log.warn({ err: error }, "Redis unavailable at startup; cache will reconnect lazily"); }
  await app.listen({ host: config.HOST, port: config.PORT });
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await closeConnections();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start().catch(async (error) => {
  app.log.fatal(error);
  await closeConnections();
  process.exit(1);
});
