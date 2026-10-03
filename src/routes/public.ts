import type { FastifyPluginAsync } from "fastify";
import { db } from "../db.js";
import { queueClick } from "../clicks.js";
import { resolveLink } from "../links.js";
import { appendAllowedQuery, validateSlug } from "../validation.js";
import { escapeHtml, landingPage } from "../ui.js";
import { hmacIp } from "../crypto.js";
import { config } from "../config.js";
import { isDomainAllowedForTls } from "../domains.js";

export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (request, reply) => {
    if (!["127.0.0.1", "::1"].includes(request.ip)) return reply.code(404).send();
    await db.query("SELECT 1");
    return reply.send({ status: "ok" });
  });

  app.get("/internal/caddy/ask", async (request, reply) => {
    if (!["127.0.0.1", "::1"].includes(request.ip)) return reply.code(403).send();
    const domain = String((request.query as { domain?: string }).domain ?? "");
    return reply.code(await isDomainAllowedForTls(domain) ? 200 : 403).send();
  });

  app.get("/robots.txt", async (_request, reply) => reply.type("text/plain").send("User-agent: *\nDisallow: /admin\nDisallow: /auth\nDisallow: /api\n"));

  app.get("/", async (request, reply) => {
    const hostname = request.hostname.toLowerCase().replace(/:\d+$/, "");
    if (hostname === config.PRIMARY_DOMAIN || (!config.isProduction && ["localhost", "127.0.0.1"].includes(hostname))) {
      return reply.type("text/html").send(landingPage());
    }
    const result = await db.query<{ homepage_redirect: string | null }>("SELECT homepage_redirect FROM domains WHERE hostname = $1", [hostname]);
    const redirect = result.rows[0]?.homepage_redirect;
    if (redirect) return reply.redirect(redirect, 308);
    return reply.code(404).type("text/html").send(notFoundPage("Domain not configured"));
  });

  app.get("/report", async (_request, reply) => reply.type("text/html").send(reportPage()));
  app.post("/report", async (request, reply) => {
    const body = request.body as Record<string, string>;
    const linkUrl = String(body.link ?? "").trim();
    const reason = String(body.reason ?? "").trim().slice(0, 200);
    const details = String(body.details ?? "").trim().slice(0, 4000);
    const email = String(body.email ?? "").trim().slice(0, 320) || null;
    let linkId: string | null = null;
    try {
      const parsed = new URL(linkUrl);
      const slug = validateSlug(parsed.pathname.replace(/^\//, ""));
      const found = await db.query<{ id: string }>(
        "SELECT l.id FROM links l JOIN domains d ON d.id=l.domain_id WHERE d.hostname=$1 AND l.slug=$2", [parsed.hostname, slug]
      );
      linkId = found.rows[0]?.id ?? null;
    } catch { /* report can still be recorded without a matched link */ }
    if (!reason || !details) return reply.code(400).type("text/html").send(reportPage("Please provide a reason and details."));
    await db.query(
      "INSERT INTO abuse_reports (link_id, reporter_email, reason, details, ip_hash) VALUES ($1,$2,$3,$4,$5)",
      [linkId, email, reason, details, hmacIp(request.ip)]
    );
    return reply.type("text/html").send(reportPage(undefined, true));
  });

  app.get<{ Params: { slug: string } }>("/:slug", async (request, reply) => {
    const hostname = request.hostname.toLowerCase().replace(/:\d+$/, "");
    let slug: string;
    try { slug = validateSlug(request.params.slug); }
    catch { return reply.code(404).type("text/html").send(notFoundPage("Link not found")); }
    const link = await resolveLink(hostname, slug);
    if (!link) return reply.code(404).type("text/html").send(notFoundPage("Link not found"));
    const now = Date.now();
    if (link.status === "suspended") return reply.code(451).type("text/html").send(notFoundPage("This link has been suspended"));
    if (link.status !== "active") return reply.code(404).type("text/html").send(notFoundPage("Link unavailable"));
    if (link.activeFrom && new Date(link.activeFrom).getTime() > now) return reply.code(404).type("text/html").send(notFoundPage("Link not active yet"));
    if (link.expiresAt && new Date(link.expiresAt).getTime() <= now) return reply.code(410).type("text/html").send(notFoundPage("This link has expired"));

    let counted = false;
    if (link.maxClicks) {
      const reservation = await db.query(
        "UPDATE links SET click_count=click_count+1 WHERE id=$1 AND click_count < max_clicks RETURNING id", [link.id]
      );
      if (!reservation.rowCount) return reply.code(410).type("text/html").send(notFoundPage("This link has reached its click limit"));
      counted = true;
    }
    void queueClick(request, link.id, counted);
    const incoming = new URL(request.url, `https://${hostname}`).searchParams;
    const target = link.passQuery ? appendAllowedQuery(link.destination, incoming) : link.destination;
    return reply.header("cache-control", "no-store, private").header("referrer-policy", "no-referrer").redirect(target, link.redirectType);
  });
};

function notFoundPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(message)} · Shortlinker</title><link rel="stylesheet" href="/assets/vendor/bootstrap/bootstrap.min.css"><link rel="stylesheet" href="/assets/app.css"></head><body class="bg-dark text-light"><main class="min-vh-100 d-flex align-items-center"><div class="container text-center"><div class="display-1 fw-bold gradient-text">404</div><h1 class="h3">${escapeHtml(message)}</h1><p class="text-secondary">The address may be incorrect, expired, or no longer available.</p><a href="https://shurl.be/" class="btn btn-primary rounded-pill px-4">Back to shurl.be</a><a href="https://shurl.be/report" class="btn btn-link text-secondary">Report abuse</a></div></main></body></html>`;
}

function reportPage(error?: string, success = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Report abuse · Shortlinker</title><link rel="stylesheet" href="/assets/vendor/bootstrap/bootstrap.min.css"><link rel="stylesheet" href="/assets/app.css"></head><body class="bg-light"><main class="container py-5"><div class="row justify-content-center"><div class="col-lg-7"><a href="/" class="navbar-brand"><span class="brand-mark">S</span>Shortlinker</a><div class="card panel-card mt-4"><div class="card-body p-4 p-md-5"><h1 class="h2 fw-bold">Report an unsafe link</h1><p class="text-secondary">Tell us about phishing, malware, spam, or another abusive destination.</p>${error ? `<div class="alert alert-danger">${escapeHtml(error)}</div>` : ""}${success ? '<div class="alert alert-success">Report received. Our team will review it.</div>' : `<form method="post"><label class="form-label mt-3">Shortlink</label><input class="form-control" type="url" name="link" required placeholder="https://shurl.be/example"><label class="form-label mt-3">Reason</label><select class="form-select" name="reason" required><option value="">Select…</option><option>Phishing</option><option>Malware</option><option>Spam</option><option>Illegal content</option><option>Other</option></select><label class="form-label mt-3">Details</label><textarea class="form-control" name="details" rows="5" required></textarea><label class="form-label mt-3">Email (optional)</label><input class="form-control" type="email" name="email"><button class="btn btn-danger mt-4">Submit report</button></form>`}</div></div></div></div></main></body></html>`;
}
