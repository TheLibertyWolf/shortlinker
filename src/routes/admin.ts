import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { db, getSetting, setSetting } from "../db.js";
import { requireSession, verifyCsrf } from "../auth.js";
import { audit } from "../audit.js";
import { decrypt, encrypt, hashPassword, randomToken, sha256, verifyPassword } from "../crypto.js";
import { verifyDomain } from "../domains.js";
import { invalidateLink } from "../links.js";
import { config } from "../config.js";
import { clampRetentionDays, generateSlug, normalizeHostname, parseTags, validateDestination, validateHomepageRedirect, validateSlug } from "../validation.js";
import { adminLayout, alert, csrfField, escapeHtml, pagination, statusBadge } from "../ui.js";
import { permissions, type TurnstileSettings, type UserSession } from "../types.js";
import { localeTag } from "../i18n.js";
import { createTotpSecret, createTotpUri, verifyTotpToken } from "../totp.js";

function queryMessage(request: FastifyRequest): { message?: string; kind: "success" | "danger" } {
  const query = request.query as { ok?: string; error?: string };
  return query.error ? { message: query.error, kind: "danger" } : { message: query.ok, kind: "success" };
}

async function sessionFor(request: FastifyRequest, reply: FastifyReply, permission?: string): Promise<UserSession | null> {
  return requireSession(request, reply, permission);
}

function domainScope(session: UserSession): string[] | null {
  return session.allDomains ? null : session.domainIds;
}

function canAccessDomain(session: UserSession, domainId: string): boolean {
  return session.allDomains || session.domainIds.includes(domainId);
}

async function sessionForAny(request: FastifyRequest, reply: FastifyReply, required: string[]): Promise<UserSession | null> {
  const session = await requireSession(request, reply);
  if (!session) return null;
  if (!required.some((permission) => session.permissions.includes(permission))) {
    await reply.code(403).type("text/plain").send("Insufficient permission.");
    return null;
  }
  return session;
}

function requireCsrfOrReply(request: FastifyRequest, reply: FastifyReply, session: UserSession): boolean {
  if (verifyCsrf(request, session)) return true;
  void reply.code(403).type("text/plain").send("Invalid CSRF token");
  return false;
}

function normalizeUsername(value: string | undefined): string {
  const username = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error("Username must contain 3–32 lowercase letters, numbers, dots, dashes, or underscores");
  }
  return username;
}

function normalizeAccount(body: Record<string, string | string[]>): { username: string; email: string; displayName: string; locale: "en" | "fr" } {
  const username = normalizeUsername(String(body.username ?? ""));
  const email = String(body.email ?? "").trim().toLowerCase();
  const displayName = String(body.display_name ?? "").trim();
  const locale = body.locale === "fr" ? "fr" : "en";
  if (!displayName || displayName.length > 100) throw new Error("Display name must contain 1–100 characters");
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
  return { username, email, displayName, locale };
}

type AnalyticsBucket = { name: string; clicks: number };
type AnalyticsTimeline = { day: string; clicks: number };

function numberFor(value: unknown, session: UserSession): string {
  return Number(value ?? 0).toLocaleString(localeTag(session.locale));
}

function countryFlag(code: string): string {
  const normalized = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return "🌐";
  return String.fromCodePoint(...[...normalized].map((letter) => 127397 + letter.charCodeAt(0)));
}

function countryName(code: string, session: UserSession): string {
  if (!/^[A-Z]{2}$/i.test(code)) return session.locale === "fr" ? "Inconnu" : "Unknown";
  try { return new Intl.DisplayNames([localeTag(session.locale)], { type: "region" }).of(code.toUpperCase()) ?? code; }
  catch { return code; }
}

function referrerName(value: string): string {
  if (!value || value === "Direct") return "Direct";
  try { return new URL(value).hostname || value; }
  catch { return value; }
}

function rankBars(items: AnalyticsBucket[], session: UserSession, kind: "country" | "referrer" | "default" = "default"): string {
  if (!items.length) return '<div class="stats-empty"><i class="bi bi-bar-chart"></i><span>No data for this period.</span></div>';
  const maximum = Math.max(1, ...items.map((item) => Number(item.clicks)));
  return items.map((item, index) => {
    const percent = Math.max(5, Math.min(100, Math.round((Number(item.clicks) / maximum) * 20) * 5));
    const rawName = String(item.name ?? "Unknown");
    const display = kind === "country" ? `${countryFlag(rawName)} ${countryName(rawName, session)}` : kind === "referrer" ? referrerName(rawName) : rawName;
    return `<div class="stats-rank-row stats-color-${index % 4}"><div><span title="${escapeHtml(rawName)}">${escapeHtml(display)}</span><strong>${numberFor(item.clicks, session)}</strong></div><i><b class="stats-w-${percent}"></b></i></div>`;
  }).join("");
}

function timelineChart(items: AnalyticsTimeline[], session: UserSession): string {
  if (!items.length) return '<div class="stats-empty stats-empty-chart"><i class="bi bi-graph-up"></i><span>No traffic for this period.</span></div>';
  const width = 920; const height = 280; const left = 52; const right = 18; const top = 18; const bottom = 34;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...items.map((item) => Number(item.clicks)));
  const x = (index: number) => left + (items.length === 1 ? 0 : index / (items.length - 1) * plotWidth);
  const y = (value: number) => top + plotHeight - value / maximum * plotHeight;
  const points = items.map((item, index) => `${x(index).toFixed(1)},${y(Number(item.clicks)).toFixed(1)}`).join(" ");
  const grids = Array.from({ length: 5 }, (_, index) => {
    const gridY = top + index / 4 * plotHeight;
    const label = Math.round(maximum * (1 - index / 4));
    return `<line x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}" class="stats-chart-grid"/><text x="${left - 10}" y="${gridY + 4}" text-anchor="end" class="stats-chart-label">${numberFor(label, session)}</text>`;
  }).join("");
  const pointStep = Math.max(1, Math.ceil(items.length / 30));
  const dots = items.map((item, index) => index % pointStep === 0 || index === items.length - 1 ? `<circle cx="${x(index).toFixed(1)}" cy="${y(Number(item.clicks)).toFixed(1)}" r="3"><title>${escapeHtml(item.day)} · ${numberFor(item.clicks, session)} ${session.locale === "fr" ? "clics" : "clicks"}</title></circle>` : "").join("");
  const dateLabel = (item: AnalyticsTimeline) => new Date(`${item.day}T00:00:00Z`).toLocaleDateString(localeTag(session.locale), { day: "numeric", month: "short", timeZone: "UTC" });
  const middle = items[Math.floor((items.length - 1) / 2)]!;
  return `<div class="stats-line-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Click timeline"><defs><linearGradient id="statsArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7457ff" stop-opacity=".38"/><stop offset="1" stop-color="#19d3da" stop-opacity=".03"/></linearGradient></defs>${grids}<polygon points="${left},${top + plotHeight} ${points} ${width - right},${top + plotHeight}" class="stats-chart-area"/><polyline points="${points}" class="stats-chart-line"/>${dots}</svg><div class="stats-chart-dates"><span>${dateLabel(items[0]!)}</span><span>${dateLabel(middle)}</span><span>${dateLabel(items[items.length - 1]!)}</span></div></div>`;
}

function audienceDonut(humans: number, robots: number, session: UserSession): string {
  const classified = humans + robots;
  const percentage = classified ? Math.round(humans / classified * 100) : 0;
  const circumference = 339.292;
  const humanArc = circumference * percentage / 100;
  return `<div class="stats-donut"><svg viewBox="0 0 140 140" role="img" aria-label="Human and robot traffic"><circle class="stats-donut-track" cx="70" cy="70" r="54"/><circle class="stats-donut-value" cx="70" cy="70" r="54" stroke-dasharray="${humanArc.toFixed(2)} ${circumference.toFixed(2)}"/><text x="70" y="67" text-anchor="middle" class="stats-donut-number">${percentage}%</text><text x="70" y="84" text-anchor="middle" class="stats-donut-label">${session.locale === "fr" ? "HUMAIN" : "HUMAN"}</text></svg><div class="stats-donut-legend"><span><i class="is-human"></i>Humans <strong>${numberFor(humans, session)}</strong></span><span><i class="is-robot"></i>Robots <strong>${numberFor(robots, session)}</strong></span></div></div>`;
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/admin", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const scope = domainScope(session);
    const totals = await db.query<{
      links: number; clicks: number; humans: number; robots: number; clicks_today: number;
    }>(`WITH allowed_links AS (
      SELECT id,status FROM links WHERE deleted_at IS NULL AND ($1::uuid[] IS NULL OR domain_id=ANY($1))
    ) SELECT
      (SELECT count(*) FROM allowed_links WHERE status='active')::int AS links,
      count(e.id)::int AS clicks,
      count(e.id) FILTER (WHERE e.visitor_class='human')::int AS humans,
      count(e.id) FILTER (WHERE e.visitor_class='robot')::int AS robots,
      count(e.id) FILTER (WHERE e.clicked_at >= date_trunc('day',now()))::int AS clicks_today
    FROM click_events e JOIN allowed_links l ON l.id=e.link_id`, [scope]);
    const top = await db.query(
      `SELECT l.id,d.hostname::text,l.slug,l.destination,l.click_count FROM links l JOIN domains d ON d.id=l.domain_id
       WHERE l.deleted_at IS NULL AND ($1::uuid[] IS NULL OR l.domain_id=ANY($1)) ORDER BY l.click_count DESC LIMIT 8`, [scope]
    );
    const row = totals.rows[0]!;
    const cards = [
      ["Links online", row.links, "link-45deg", "primary"], ["Clicks today", row.clicks_today, "activity", "success"],
      ["Total events", row.clicks, "bar-chart", "info"], ["Bot traffic", row.robots, "robot", "warning"]
    ].map(([label, value, glyph, color]) => `<div class="col-sm-6 col-xl-3"><div class="card metric-card h-100"><div class="card-body"><div class="d-flex justify-content-between"><span class="text-secondary fw-semibold">${label}</span><i class="bi bi-${glyph} text-${color}"></i></div><div class="metric-value mt-3">${value}</div></div></div></div>`).join("");
    const topRows = top.rows.map((link) => `<tr><td><a class="fw-semibold text-decoration-none" href="/admin/links/${link.id}">${escapeHtml(link.hostname)}/${escapeHtml(link.slug)}</a></td><td class="text-truncate" style="max-width:360px">${escapeHtml(link.destination)}</td><td class="text-end fw-semibold">${Number(link.click_count).toLocaleString()}</td></tr>`).join("") || '<tr><td colspan="3" class="text-center text-secondary py-5">No links yet.</td></tr>';
    const detailHref = session.permissions.includes("stats.read") ? "/admin/stats" : "/admin/links";
    const content = `<div class="row g-4 mb-4">${cards}</div><div class="card panel-card"><div class="card-header bg-white border-0 p-4 d-flex justify-content-between"><h2 class="h5 fw-bold mb-0">Top-performing links</h2><a href="${detailHref}" class="btn btn-sm btn-outline-primary">View analytics</a></div><div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Shortlink</th><th>Destination</th><th class="text-end">Clicks</th></tr></thead><tbody>${topRows}</tbody></table></div></div>`;
    return reply.type("text/html").send(adminLayout("Overview", "/admin", session, content));
  });

  app.get("/admin/stats", async (request, reply) => {
    const session = await sessionFor(request, reply, "stats.read"); if (!session) return;
    const query = request.query as Record<string, string | undefined>;
    const scope = domainScope(session);
    const domains = await db.query<{id:string;hostname:string}>("SELECT id,hostname::text FROM domains WHERE status='active' AND ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY is_primary DESC,hostname", [scope]);
    const allowedIds = new Set(domains.rows.map((domain) => domain.id));
    const domainId = allowedIds.has(String(query.domain)) ? String(query.domain) : "";
    const requestedDays = Number(query.days) || 30;
    const days = [7, 30, 90, 365].includes(requestedDays) ? requestedDays : 30;
    type StatsDashboard = {
      active_links:number; total_clicks:number; period_clicks:number; uniques:number; humans:number; robots:number;
      timeline:AnalyticsTimeline[]; countries:AnalyticsBucket[]; browsers:AnalyticsBucket[]; operatingSystems:AnalyticsBucket[];
      devices:AnalyticsBucket[]; referrers:AnalyticsBucket[]; domains:AnalyticsBucket[];
      topLinks:Array<{id:string;domain:string;slug:string;destination:string;clicks:number}>;
      recent:Array<{clickedAt:string;visitorClass:string;country:string;userAgent:string;browser:string;operatingSystem:string;deviceType:string;referrer:string;linkId:string;domain:string;slug:string}>;
    };
    const dashboardResult = await db.query<StatsDashboard>(
      `WITH allowed_links AS MATERIALIZED (
         SELECT l.id,l.domain_id,l.slug,l.destination,l.status,l.click_count,d.hostname::text AS domain
         FROM links l JOIN domains d ON d.id=l.domain_id
         WHERE l.deleted_at IS NULL AND ($1::uuid[] IS NULL OR l.domain_id=ANY($1))
           AND ($2::text='' OR l.domain_id::text=$2)
       ), period_events AS MATERIALIZED (
         SELECT e.clicked_at,e.visitor_hash,e.visitor_class,e.country_code,e.user_agent,e.browser,e.operating_system,e.device_type,e.referrer,
                l.id AS link_id,l.domain,l.slug,l.destination
         FROM click_events e JOIN allowed_links l ON l.id=e.link_id
         WHERE e.clicked_at >= current_date - ($3::int - 1) * interval '1 day'
       ), daily AS (
         SELECT clicked_at::date AS day,count(*)::int AS clicks FROM period_events GROUP BY clicked_at::date
       ) SELECT
         (SELECT count(*) FROM allowed_links WHERE status='active')::int AS active_links,
         (SELECT coalesce(sum(click_count),0) FROM allowed_links)::bigint AS total_clicks,
         (SELECT count(*) FROM period_events)::int AS period_clicks,
         (SELECT count(DISTINCT visitor_hash) FROM period_events)::int AS uniques,
         (SELECT count(*) FROM period_events WHERE visitor_class='human')::int AS humans,
         (SELECT count(*) FROM period_events WHERE visitor_class='robot')::int AS robots,
         coalesce((SELECT jsonb_agg(jsonb_build_object('day',to_char(series.day,'YYYY-MM-DD'),'clicks',coalesce(daily.clicks,0)) ORDER BY series.day)
           FROM generate_series(current_date-($3::int-1),current_date,interval '1 day') series(day) LEFT JOIN daily ON daily.day=series.day::date),'[]') AS timeline,
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item.clicks DESC) FROM (SELECT coalesce(country_code::text,'--') AS name,count(*)::int AS clicks FROM period_events GROUP BY 1 ORDER BY clicks DESC LIMIT 12) item),'[]') AS countries,
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item.clicks DESC) FROM (SELECT coalesce(nullif(browser,''),'Unknown') AS name,count(*)::int AS clicks FROM period_events GROUP BY 1 ORDER BY clicks DESC LIMIT 8) item),'[]') AS browsers,
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item.clicks DESC) FROM (SELECT coalesce(nullif(operating_system,''),'Unknown') AS name,count(*)::int AS clicks FROM period_events GROUP BY 1 ORDER BY clicks DESC LIMIT 8) item),'[]') AS "operatingSystems",
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item.clicks DESC) FROM (SELECT coalesce(nullif(device_type,''),'Unknown') AS name,count(*)::int AS clicks FROM period_events GROUP BY 1 ORDER BY clicks DESC LIMIT 8) item),'[]') AS devices,
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item.clicks DESC) FROM (SELECT coalesce(nullif(referrer,''),'Direct') AS name,count(*)::int AS clicks FROM period_events GROUP BY 1 ORDER BY clicks DESC LIMIT 10) item),'[]') AS referrers,
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item.clicks DESC) FROM (SELECT domain AS name,count(*)::int AS clicks FROM period_events GROUP BY 1 ORDER BY clicks DESC LIMIT 12) item),'[]') AS domains,
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item.clicks DESC) FROM (SELECT link_id AS id,domain,slug,destination,count(*)::int AS clicks FROM period_events GROUP BY link_id,domain,slug,destination ORDER BY clicks DESC LIMIT 5) item),'[]') AS "topLinks",
         coalesce((SELECT jsonb_agg(row_to_json(item) ORDER BY item."clickedAt" DESC) FROM (SELECT clicked_at AS "clickedAt",visitor_class AS "visitorClass",coalesce(country_code::text,'--') AS country,coalesce(user_agent,'') AS "userAgent",coalesce(browser,'Unknown') AS browser,coalesce(operating_system,'Unknown') AS "operatingSystem",coalesce(device_type,'Unknown') AS "deviceType",coalesce(referrer,'Direct') AS referrer,link_id AS "linkId",domain,slug FROM period_events ORDER BY clicked_at DESC LIMIT 50) item),'[]') AS recent`,
      [scope, domainId, days]
    );
    const stat = dashboardResult.rows[0] ?? { active_links:0,total_clicks:0,period_clicks:0,uniques:0,humans:0,robots:0,timeline:[],countries:[],browsers:[],operatingSystems:[],devices:[],referrers:[],domains:[],topLinks:[],recent:[] };
    const domainOptions = domains.rows.map(domain=>`<option value="${domain.id}" ${domain.id===domainId?"selected":""}>${escapeHtml(domain.hostname)}</option>`).join("");
    const periodOptions = [7,30,90,365].map(value=>`<option value="${value}" ${days===value?"selected":""}>${session.locale === "fr" ? `${value} derniers jours` : `Last ${value} days`}</option>`).join("");
    const filters = `<form method="get" action="/admin/stats" class="stats-filter-card"><div><span class="stats-filter-kicker">ANALYTICS SCOPE</span><strong>Explore your traffic</strong></div><label><span>Domain</span><select class="form-select" name="domain"><option value="">All allowed domains</option>${domainOptions}</select></label><label><span>Period</span><select class="form-select" name="days">${periodOptions}</select></label><button class="btn btn-primary"><i class="bi bi-funnel"></i> Apply</button></form>`;
    const kpis = [
      ["Total clicks",stat.total_clicks,"All time","activity","violet"],
      ["Period clicks",stat.period_clicks,`${days} ${session.locale === "fr" ? "jours" : "days"}`,"graph-up-arrow","cyan"],
      ["Unique visitors",stat.uniques,"Anonymous estimate","people","blue"],
      ["Humans",stat.humans,"Qualified traffic","person-check","green"],
      ["Robots",stat.robots,"Automated traffic","robot","orange"],
      ["Active links",stat.active_links,"Within your access","link-45deg","pink"]
    ].map(([label,value,caption,glyph,color])=>`<article class="stats-kpi is-${color}"><div><span>${label}</span><strong>${numberFor(value,session)}</strong><small>${caption}</small></div><i class="bi bi-${glyph}"></i></article>`).join("");
    const classified = Number(stat.humans) + Number(stat.robots);
    const topMaximum = Math.max(1,...stat.topLinks.map(link=>Number(link.clicks)));
    const topLinks = stat.topLinks.map((link,index)=>{const percent=Math.max(5,Math.round(Number(link.clicks)/topMaximum*20)*5);return `<article class="stats-top-link"><b>${String(index+1).padStart(2,"0")}</b><div><a href="/admin/links/${link.id}">${escapeHtml(link.domain)}/${escapeHtml(link.slug)}</a><small title="${escapeHtml(link.destination)}">${escapeHtml(link.destination)}</small><i><span class="stats-w-${percent}"></span></i></div><strong>${numberFor(link.clicks,session)}</strong></article>`;}).join("") || '<div class="stats-empty"><i class="bi bi-link-45deg"></i><span>No data for this period.</span></div>';
    const recentRows = stat.recent.map(event=>{
      const client=[event.browser,event.operatingSystem,event.deviceType].filter(value=>value&&value!=="Unknown").join(" · ")||"Unknown";
      const badge=event.visitorClass==="human"?"success":event.visitorClass==="robot"?"warning":"secondary";
      return `<tr><td class="text-nowrap">${new Date(event.clickedAt).toLocaleString(localeTag(session.locale))}</td><td><span class="badge text-bg-${badge}">${escapeHtml(event.visitorClass)}</span></td><td><span class="country-flag">${countryFlag(event.country)}</span> ${escapeHtml(countryName(event.country,session))}</td><td><a class="fw-semibold text-decoration-none" href="/admin/links/${event.linkId}">${escapeHtml(event.domain)}/${escapeHtml(event.slug)}</a></td><td><span title="${escapeHtml(event.userAgent)}">${escapeHtml(client)}</span></td><td class="stats-referrer" title="${escapeHtml(event.referrer)}">${escapeHtml(referrerName(event.referrer))}</td></tr>`;
    }).join("")||'<tr><td colspan="6" class="text-center text-secondary py-5">No traffic for this period.</td></tr>';
    const content = `${filters}<section class="stats-kpi-grid">${kpis}</section><section class="stats-primary-grid"><article class="stats-panel stats-panel-wide"><header><div><span>TRAFFIC</span><h2>Clicks over time</h2></div><div class="stats-live-pill"><i></i>${session.locale==="fr"?`${days} jours`:`${days} days`}</div></header>${timelineChart(stat.timeline,session)}</article><article class="stats-panel"><header><div><span>AUDIENCE</span><h2>Humans vs robots</h2></div><small>${numberFor(classified,session)} ${session.locale === "fr" ? "classés" : "classified"}</small></header>${audienceDonut(Number(stat.humans),Number(stat.robots),session)}</article></section><section class="stats-breakdown-grid"><article class="stats-panel"><header><div><span>GEOGRAPHY</span><h2>Top countries</h2></div><i class="bi bi-globe2"></i></header>${rankBars(stat.countries,session,"country")}</article><article class="stats-panel"><header><div><span>TECHNOLOGY</span><h2>Browsers</h2></div><i class="bi bi-browser-chrome"></i></header>${rankBars(stat.browsers,session)}</article><article class="stats-panel"><header><div><span>TECHNOLOGY</span><h2>Operating systems</h2></div><i class="bi bi-window"></i></header>${rankBars(stat.operatingSystems,session)}</article><article class="stats-panel"><header><div><span>TECHNOLOGY</span><h2>Devices</h2></div><i class="bi bi-phone"></i></header>${rankBars(stat.devices,session)}</article></section><section class="stats-secondary-grid"><article class="stats-panel"><header><div><span>ACQUISITION</span><h2>Top referrers</h2></div><i class="bi bi-signpost-split"></i></header>${rankBars(stat.referrers,session,"referrer")}</article><article class="stats-panel"><header><div><span>PERFORMANCE</span><h2>Top-performing links</h2></div><i class="bi bi-trophy"></i></header><div class="stats-top-links">${topLinks}</div></article><article class="stats-panel"><header><div><span>DISTRIBUTION</span><h2>Domains</h2></div><i class="bi bi-diagram-3"></i></header>${rankBars(stat.domains,session)}</article></section><section class="stats-panel stats-recent"><header><div><span>REAL-TIME DETAIL</span><h2>Latest visits</h2></div><small>50 most recent events in the selected period</small></header><div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Time</th><th>Type</th><th>Country</th><th>Shortlink</th><th>Client</th><th>Referrer</th></tr></thead><tbody>${recentRows}</tbody></table></div></section>`;
    return reply.type("text/html").send(adminLayout("Statistics", "/admin/stats", session, content));
  });

  app.get("/admin/links", async (request, reply) => {
    const session = await sessionFor(request, reply, "links.read"); if (!session) return;
    const query = request.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(query.page) || 1);
    const requestedLimit = Number(query.limit) || 25;
    const limit = [25, 50, 100].includes(requestedLimit) ? requestedLimit : 25;
    const search = String(query.q ?? "").trim().slice(0, 200);
    const domainId = /^[0-9a-f-]{36}$/i.test(String(query.domain ?? "")) ? String(query.domain) : "";
    const status = ["active", "disabled", "suspended"].includes(String(query.status)) ? String(query.status) : "";
    const sort = ["newest", "oldest", "clicks_desc", "clicks_asc"].includes(String(query.sort)) ? String(query.sort) : "newest";
    const orderBy = { newest: "l.created_at DESC", oldest: "l.created_at ASC", clicks_desc: "l.click_count DESC", clicks_asc: "l.click_count ASC" }[sort]!;
    const scope = domainScope(session);
    const links = await db.query(
      `SELECT l.*,d.hostname::text FROM links l JOIN domains d ON d.id=l.domain_id
       WHERE l.deleted_at IS NULL
         AND ($1::uuid[] IS NULL OR l.domain_id=ANY($1))
         AND ($2::text='' OR l.domain_id::text=$2)
         AND ($3::text='' OR l.slug ILIKE '%'||$3||'%' OR l.destination ILIKE '%'||$3||'%' OR d.hostname::text ILIKE '%'||$3||'%')
         AND ($4::text='' OR l.status=$4)
       ORDER BY ${orderBy} LIMIT $5 OFFSET $6`, [scope, domainId, search, status, limit + 1, (page - 1) * limit]
    );
    const domains = await db.query("SELECT id,hostname::text,status FROM domains WHERE ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY is_primary DESC,hostname", [scope]);
    const canWrite = session.permissions.includes("links.write");
    const rows = links.rows.slice(0, limit).map((link) => `<tr><td><a class="fw-bold text-decoration-none" href="/admin/links/${link.id}">https://${escapeHtml(link.hostname)}/${escapeHtml(link.slug)}</a><div class="small text-secondary text-truncate" style="max-width:420px">${escapeHtml(link.destination)}</div></td><td>${statusBadge(link.status)}</td><td>${Number(link.click_count).toLocaleString()}</td><td>${new Date(link.created_at).toLocaleDateString(localeTag(session.locale))}</td><td class="text-end">${canWrite ? `<form method="post" action="/admin/links/${link.id}/toggle" class="d-inline">${csrfField(session.csrfToken)}<button class="btn btn-sm btn-outline-secondary">${link.status === "active" ? "Disable" : "Enable"}</button></form>` : ""}</td></tr>`).join("") || '<tr><td colspan="5" class="text-center py-5 text-secondary">No links match these filters.</td></tr>';
    const domainOptions = domains.rows.map((domain) => `<option value="${domain.id}" ${domain.status !== "active" ? "disabled" : ""}>${escapeHtml(domain.hostname)}${domain.status !== "active" ? ` (${domain.status})` : ""}</option>`).join("");
    const domainFilters = domains.rows.map((domain) => `<option value="${domain.id}" ${domainId === domain.id ? "selected" : ""}>${escapeHtml(domain.hostname)}</option>`).join("");
    const message = queryMessage(request);
    const create = canWrite ? `<button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#createLink"><i class="bi bi-plus-lg"></i> New link</button><div class="modal fade" id="createLink" tabindex="-1"><div class="modal-dialog modal-lg"><form class="modal-content" method="post" action="/admin/links"><div class="modal-header"><h2 class="modal-title h5">Create a shortlink</h2><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body">${csrfField(session.csrfToken)}<div class="row g-3"><div class="col-md-5"><label class="form-label">Domain</label><select class="form-select" name="domain_id" required>${domainOptions}</select></div><div class="col-md-7"><label class="form-label">Custom slug <span class="text-secondary">(optional)</span></label><input class="form-control code-field" name="slug" placeholder="Generated automatically"></div><div class="col-12"><label class="form-label">Destination URL</label><input class="form-control" type="url" name="destination" required placeholder="https://example.com/long/path"></div><div class="col-md-4"><label class="form-label">Redirect</label><select class="form-select" name="redirect_type"><option>302</option><option>307</option><option>301</option><option>308</option></select></div><div class="col-md-4"><label class="form-label">Expires at</label><input class="form-control" type="datetime-local" name="expires_at"></div><div class="col-md-4"><label class="form-label">Maximum clicks</label><input class="form-control" type="number" min="1" name="max_clicks"></div><div class="col-12"><label class="form-label">Tags</label><input class="form-control" name="tags" placeholder="campaign, social"><div class="form-check mt-3"><input class="form-check-input" type="checkbox" name="pass_query" value="1" id="passQuery"><label class="form-check-label" for="passQuery">Pass incoming query parameters to destination</label></div></div></div></div><div class="modal-footer"><button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary">Create link</button></div></form></div></div>` : "";
    const filters = `<form class="card panel-card mb-4" method="get" action="/admin/links"><div class="card-body"><div class="row g-3 align-items-end"><div class="col-lg-4"><label class="form-label">Search</label><input class="form-control" name="q" value="${escapeHtml(search)}" placeholder="Slug, destination or domain"></div><div class="col-md-4 col-lg-2"><label class="form-label">Domain</label><select class="form-select" name="domain"><option value="">All allowed domains</option>${domainFilters}</select></div><div class="col-md-4 col-lg-2"><label class="form-label">Status</label><select class="form-select" name="status"><option value="">All statuses</option>${["active","disabled","suspended"].map(value=>`<option value="${value}" ${status===value?"selected":""}>${value}</option>`).join("")}</select></div><div class="col-md-4 col-lg-2"><label class="form-label">Order</label><select class="form-select" name="sort">${[["newest","Newest"],["oldest","Oldest"],["clicks_desc","Most clicks"],["clicks_asc","Fewest clicks"]].map(([value,label])=>`<option value="${value}" ${sort===value?"selected":""}>${label}</option>`).join("")}</select></div><div class="col-md-6 col-lg-1"><label class="form-label">Rows</label><select class="form-select" name="limit">${[25,50,100].map(value=>`<option ${limit===value?"selected":""}>${value}</option>`).join("")}</select></div><div class="col-md-6 col-lg-1"><button class="btn btn-outline-primary w-100">Filter</button></div></div></div></form>`;
    const baseParams = new URLSearchParams(); if(search)baseParams.set("q",search);if(domainId)baseParams.set("domain",domainId);if(status)baseParams.set("status",status);if(sort!=="newest")baseParams.set("sort",sort);if(limit!==25)baseParams.set("limit",String(limit));
    const pageBase = `/admin/links${baseParams.size ? `?${baseParams.toString()}` : ""}`;
    const content = `${alert(message.message, message.kind)}<div class="d-flex justify-content-end mb-3">${create}</div>${filters}<div class="card panel-card"><div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Link</th><th>Status</th><th>Clicks</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>${pagination(page, links.rows.length > limit, pageBase,session.locale)}`;
    return reply.type("text/html").send(adminLayout("Links", "/admin/links", session, content));
  });

  app.post("/admin/links", async (request, reply) => {
    const session = await sessionFor(request, reply, "links.write"); if (!session || !requireCsrfOrReply(request, reply, session)) return;
    const body = request.body as Record<string, string>;
    try {
      const requestedDomainId = String(body.domain_id ?? "");
      if (!canAccessDomain(session, requestedDomainId)) throw new Error("This domain is not assigned to your account");
      const domain = await db.query<{ id: string; hostname: string }>("SELECT id,hostname::text FROM domains WHERE id=$1 AND status='active'", [requestedDomainId]);
      if (!domain.rows[0]) throw new Error("Select a verified active domain");
      const platformDomains = await db.query<{ hostname: string }>("SELECT hostname::text FROM domains");
      const destination = validateDestination(body.destination ?? "", platformDomains.rows.map((d) => d.hostname));
      let slug = body.slug ? validateSlug(body.slug) : generateSlug();
      let created: { id: string } | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const result = await db.query<{ id: string }>(
            `INSERT INTO links (domain_id,slug,destination,redirect_type,expires_at,max_clicks,pass_query,tags,created_by,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
            [requestedDomainId, slug, destination, Number(body.redirect_type) || 302, body.expires_at || null, body.max_clicks ? Number(body.max_clicks) : null, body.pass_query === "1", parseTags(body.tags), session.userId]
          );
          created = result.rows[0]; break;
        } catch (error) {
          if (String(error).includes("links_domain_id_slug_key") && !body.slug) { slug = generateSlug(); continue; }
          if (String(error).includes("links_domain_id_slug_key")) throw new Error("This slug already exists on the selected domain");
          throw error;
        }
      }
      if (!created) throw new Error("Unable to generate a unique slug");
      await audit(request, "link.created", { actorUserId: session.userId, targetType: "link", targetId: created.id });
      return reply.redirect(`/admin/links?ok=${encodeURIComponent("Shortlink created")}`, 303);
    } catch (error) {
      return reply.redirect(`/admin/links?error=${encodeURIComponent(error instanceof Error ? error.message : "Creation failed")}`, 303);
    }
  });

  app.post<{ Params: { id: string } }>("/admin/links/:id/toggle", async (request, reply) => {
    const session = await sessionFor(request, reply, "links.write"); if (!session || !requireCsrfOrReply(request, reply, session)) return;
    const scope = domainScope(session);
    const result = await db.query<{ hostname: string; slug: string; status: string }>(
      `UPDATE links l SET status=CASE WHEN l.status='active' THEN 'disabled' ELSE 'active' END,updated_at=now(),updated_by=$2
       FROM domains d WHERE l.id=$1 AND d.id=l.domain_id AND l.status IN ('active','disabled')
       AND ($3::uuid[] IS NULL OR l.domain_id=ANY($3)) RETURNING d.hostname::text,l.slug,l.status`,
      [request.params.id, session.userId, scope]
    );
    const link = result.rows[0];
    if (link) { await invalidateLink(link.hostname, link.slug); await audit(request, "link.status.changed", { actorUserId: session.userId, targetType: "link", targetId: request.params.id, metadata: { status: link.status } }); }
    return reply.redirect("/admin/links", 303);
  });

  app.get<{ Params: { id: string } }>("/admin/links/:id", async (request, reply) => {
    const session = await sessionForAny(request, reply, ["links.read", "stats.read"]); if (!session) return;
    const scope = domainScope(session);
    const linkResult = await db.query(
      "SELECT l.*,d.hostname::text FROM links l JOIN domains d ON d.id=l.domain_id WHERE l.id=$1 AND ($2::uuid[] IS NULL OR l.domain_id=ANY($2))", [request.params.id, scope]
    );
    const link = linkResult.rows[0]; if (!link) return reply.code(404).send("Not found");
    const summary = await db.query(
      `SELECT count(*)::int AS clicks,count(DISTINCT visitor_hash)::int AS uniques,
       count(*) FILTER(WHERE visitor_class='human')::int AS humans,count(*) FILTER(WHERE visitor_class='robot')::int AS robots
       FROM click_events WHERE link_id=$1`, [request.params.id]
    );
    const countries = await db.query("SELECT coalesce(country_code,'--') country,count(*)::int clicks FROM click_events WHERE link_id=$1 GROUP BY country ORDER BY clicks DESC LIMIT 10", [request.params.id]);
    const recent = await db.query("SELECT clicked_at,visitor_class,country_code,browser,operating_system,device_type,referrer FROM click_events WHERE link_id=$1 ORDER BY clicked_at DESC LIMIT 50", [request.params.id]);
    const stat = summary.rows[0];
    const countryRows = countries.rows.map((r) => `<tr><td>${escapeHtml(r.country)}</td><td class="text-end fw-semibold">${r.clicks}</td></tr>`).join("") || '<tr><td colspan="2" class="text-secondary">No data</td></tr>';
    const recentRows = recent.rows.map((r) => `<tr><td>${new Date(r.clicked_at).toLocaleString(localeTag(session.locale))}</td><td>${statusBadge(r.visitor_class)}</td><td>${escapeHtml(r.country_code ?? "—")}</td><td>${escapeHtml([r.browser,r.operating_system,r.device_type].filter(Boolean).join(" · ") || "Unknown")}</td><td class="text-truncate" style="max-width:260px">${escapeHtml(r.referrer ?? "Direct")}</td></tr>`).join("") || '<tr><td colspan="5" class="text-secondary text-center py-4">No clicks recorded yet.</td></tr>';
    const content = `<div class="card panel-card mb-4"><div class="card-body p-4"><div class="d-flex flex-wrap justify-content-between gap-3"><div><div class="text-secondary small">SHORT URL</div><div class="h4 code-field mb-1">https://${escapeHtml(link.hostname)}/${escapeHtml(link.slug)}</div><div class="text-secondary text-break">${escapeHtml(link.destination)}</div></div>${statusBadge(link.status)}</div></div></div><div class="row g-4 mb-4">${[["Clicks",stat.clicks],["Unique",stat.uniques],["Humans",stat.humans],["Robots",stat.robots]].map(([a,b])=>`<div class="col-6 col-xl-3"><div class="card metric-card"><div class="card-body"><div class="text-secondary">${a}</div><div class="metric-value">${b}</div></div></div></div>`).join("")}</div><div class="row g-4"><div class="col-xl-4"><div class="card panel-card"><div class="card-header bg-white fw-bold">Top countries</div><table class="table mb-0">${countryRows}</table></div></div><div class="col-xl-8"><div class="card panel-card"><div class="card-header bg-white fw-bold">Recent visits</div><div class="table-responsive"><table class="table mb-0"><thead><tr><th>Time</th><th>Type</th><th>Country</th><th>Client</th><th>Referrer</th></tr></thead><tbody>${recentRows}</tbody></table></div></div></div></div>`;
    return reply.type("text/html").send(adminLayout("Link analytics", "/admin/links", session, content));
  });

  app.get("/admin/domains", async (request, reply) => {
    const session = await sessionFor(request, reply, "domains.read"); if (!session) return;
    const scope = domainScope(session);
    const domains = await db.query("SELECT * FROM domains WHERE ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY is_primary DESC,created_at", [scope]);
    const canWrite = session.permissions.includes("domains.write");
    const primaryHomepage = config.PUBLIC_ORIGIN.replace(/\/$/, "");
    const rows = domains.rows.map((domain) => {
      const homepage = String(domain.homepage_redirect ?? "").replace(/\/$/, "");
      const usesDefaultHomepage = !homepage || homepage === primaryHomepage;
      const homepageEditor = domain.is_primary
        ? `<div class="domain-homepage-fixed"><i class="bi bi-house-check"></i><div><strong>Main shurl.be homepage</strong><small>Primary domain behaviour is fixed</small></div></div>`
        : canWrite
          ? `<form method="post" action="/admin/domains/${domain.id}/homepage" class="domain-homepage-form">${csrfField(session.csrfToken)}<select class="form-select form-select-sm" name="homepage_mode" data-homepage-mode><option value="default" ${usesDefaultHomepage?"selected":""}>Main shurl.be homepage</option><option value="custom" ${!usesDefaultHomepage?"selected":""}>Custom HTTPS URL</option></select><input class="form-control form-control-sm" type="url" name="homepage_redirect" value="${escapeHtml(usesDefaultHomepage?"":homepage)}" placeholder="https://www.example.com" data-homepage-custom ${usesDefaultHomepage?"disabled":""}><button class="btn btn-sm btn-outline-primary"><i class="bi bi-check2"></i> Save homepage</button></form>`
          : `<div class="domain-homepage-fixed"><i class="bi bi-house-door"></i><div><strong>${usesDefaultHomepage?"Main shurl.be homepage":"Custom HTTPS URL"}</strong><small>${escapeHtml(usesDefaultHomepage?primaryHomepage:homepage)}</small></div></div>`;
      const verify = canWrite ? `<form method="post" action="/admin/domains/${domain.id}/verify">${csrfField(session.csrfToken)}<button class="btn btn-sm btn-outline-primary">Verify DNS</button></form>` : "";
      return `<tr><td><div class="fw-bold">${escapeHtml(domain.hostname)} ${domain.is_primary ? '<span class="badge text-bg-primary">Primary</span>' : ""}</div><div class="small text-secondary">_shurl.${escapeHtml(domain.hostname)}</div></td><td>${statusBadge(domain.status)}</td><td class="domain-homepage-cell">${homepageEditor}</td><td><code>shurl-verification=${escapeHtml(domain.verification_token)}</code></td><td>${domain.verified_at ? new Date(domain.verified_at).toLocaleString(localeTag(session.locale)) : "—"}</td><td class="text-end">${verify}</td></tr>`;
    }).join("");
    const message = queryMessage(request);
    const create = session.permissions.includes("domains.write") && session.allDomains ? `<form method="post" action="/admin/domains" class="row g-2 mb-4">${csrfField(session.csrfToken)}<div class="col-md-3"><label class="form-label">Domain</label><input class="form-control" name="hostname" placeholder="links.example.com" required></div><div class="col-md-3"><label class="form-label">Homepage behaviour</label><select class="form-select" name="homepage_mode" data-homepage-mode><option value="default">Main shurl.be homepage</option><option value="custom">Custom HTTPS URL</option></select></div><div class="col-md-4"><label class="form-label">Custom URL</label><input class="form-control" type="url" name="homepage_redirect" placeholder="https://www.example.com" data-homepage-custom disabled></div><div class="col-md-2 d-flex align-items-end"><button class="btn btn-primary w-100">Attach domain</button></div></form>` : "";
    const content = `${alert(message.message,message.kind)}${create}<div class="alert alert-info border-0"><i class="bi bi-info-circle me-2"></i>Add the exact TXT value shown below at <strong>_shurl.your-domain</strong>. HTTPS and shortlinks remain disabled until verification succeeds.</div><div class="card panel-card"><div class="table-responsive"><table class="table align-middle mb-0 domain-table"><thead><tr><th>Domain</th><th>Status</th><th>Homepage behaviour</th><th>Required TXT value</th><th>Verified</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    return reply.type("text/html").send(adminLayout("Domains", "/admin/domains", session, content));
  });

  app.post("/admin/domains", async (request, reply) => {
    const session = await sessionFor(request, reply, "domains.write"); if (!session || !requireCsrfOrReply(request, reply, session)) return;
    if (!session.allDomains) return reply.code(403).type("text/plain").send("Only users with access to every domain can attach a domain.");
    try {
      const body = request.body as Record<string,string>; const hostname = normalizeHostname(body.hostname ?? "");
      const requestedRedirect=body.homepage_mode==="custom"?String(body.homepage_redirect??"").trim():config.PUBLIC_ORIGIN;
      if(body.homepage_mode==="custom"&&!requestedRedirect)throw new Error("Enter the custom homepage URL");
      const homepageRedirect = validateHomepageRedirect(requestedRedirect, hostname);
      const token = randomToken(24);
      await db.query("INSERT INTO domains (hostname,verification_token,homepage_redirect,created_by) VALUES ($1,$2,$3,$4)", [hostname,token,homepageRedirect,session.userId]);
      await audit(request,"domain.attached",{actorUserId:session.userId,targetType:"domain",metadata:{hostname}});
      return reply.redirect(`/admin/domains?ok=${encodeURIComponent("Domain attached; add the TXT record, then verify")}`,303);
    } catch (error) { return reply.redirect(`/admin/domains?error=${encodeURIComponent(error instanceof Error ? error.message : "Unable to attach domain")}`,303); }
  });

  app.post<{Params:{id:string}}>("/admin/domains/:id/verify", async (request, reply) => {
    const session=await sessionFor(request,reply,"domains.write"); if(!session||!requireCsrfOrReply(request,reply,session))return;
    if(!canAccessDomain(session,request.params.id))return reply.code(403).type("text/plain").send("This domain is not assigned to your account.");
    const result=await verifyDomain(request.params.id); await audit(request,"domain.verification",{actorUserId:session.userId,targetType:"domain",targetId:request.params.id,outcome:result.verified?"success":"failure",metadata:{message:result.message}});
    return reply.redirect(`/admin/domains?${result.verified?"ok":"error"}=${encodeURIComponent(result.message)}`,303);
  });

  app.post<{Params:{id:string}}>("/admin/domains/:id/homepage", async (request, reply) => {
    const session=await sessionFor(request,reply,"domains.write"); if(!session||!requireCsrfOrReply(request,reply,session))return;
    if(!canAccessDomain(session,request.params.id))return reply.code(403).type("text/plain").send("This domain is not assigned to your account.");
    try {
      const domainResult=await db.query<{hostname:string;is_primary:boolean}>("SELECT hostname::text,is_primary FROM domains WHERE id=$1",[request.params.id]);
      const domain=domainResult.rows[0];
      if(!domain)return reply.code(404).type("text/plain").send("Domain not found");
      if(domain.is_primary)throw new Error("The primary domain always serves the shurl.be homepage");
      const body=request.body as Record<string,string>;
      const mode=body.homepage_mode==="custom"?"custom":"default";
      const requested=mode==="custom"?String(body.homepage_redirect??"").trim():config.PUBLIC_ORIGIN;
      if(mode==="custom"&&!requested)throw new Error("Enter the custom homepage URL");
      const homepageRedirect=validateHomepageRedirect(requested,domain.hostname);
      await db.query("UPDATE domains SET homepage_redirect=$2,updated_at=now() WHERE id=$1",[request.params.id,homepageRedirect]);
      await audit(request,"domain.homepage.updated",{actorUserId:session.userId,targetType:"domain",targetId:request.params.id,metadata:{hostname:domain.hostname,mode}});
      return reply.redirect(`/admin/domains?ok=${encodeURIComponent("Homepage behaviour updated")}`,303);
    } catch(error) {
      return reply.redirect(`/admin/domains?error=${encodeURIComponent(error instanceof Error?error.message:"Unable to update homepage behaviour")}`,303);
    }
  });

  app.get("/admin/users", async (request, reply) => {
    const session=await sessionFor(request,reply,"users.read"); if(!session)return;
    const users=await db.query(`SELECT u.id,u.username::text,u.email::text,u.display_name,u.status,u.totp_enabled,u.last_login_at,u.created_at,coalesce(string_agg(r.name::text,', '),'') roles FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id GROUP BY u.id ORDER BY u.created_at`);
    const roles=await db.query("SELECT id,name::text FROM roles ORDER BY name");
    const rows=users.rows.map((u)=>`<tr><td><a href="/admin/users/${u.id}" class="fw-bold text-decoration-none">${escapeHtml(u.display_name)}</a><div class="small text-secondary">@${escapeHtml(u.username)} · ${escapeHtml(u.email)}</div></td><td>${escapeHtml(u.roles)}</td><td>${statusBadge(u.status)}</td><td>${u.totp_enabled?'<span class="text-success"><i class="bi bi-check-circle"></i> Enabled</span>':'<span class="text-warning">Setup required</span>'}</td><td>${u.last_login_at?new Date(u.last_login_at).toLocaleString(localeTag(session.locale)):"Never"}</td><td class="text-end">${u.id!==session.userId?`<form method="post" action="/admin/users/${u.id}/toggle">${csrfField(session.csrfToken)}<button class="btn btn-sm btn-outline-secondary">${u.status==="active"?"Suspend":"Activate"}</button></form>`:""}</td></tr>`).join("");
    const message=queryMessage(request); const roleOptions=roles.rows.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("");
    const create=session.permissions.includes("users.write")?`<button class="btn btn-primary mb-3" data-bs-toggle="modal" data-bs-target="#createUser"><i class="bi bi-person-plus"></i> New user</button><div class="modal fade" id="createUser"><div class="modal-dialog"><form class="modal-content" method="post" action="/admin/users">${csrfField(session.csrfToken)}<div class="modal-header"><h2 class="h5 modal-title">Create user</h2><button class="btn-close" type="button" data-bs-dismiss="modal"></button></div><div class="modal-body"><label class="form-label">Display name</label><input class="form-control mb-3" name="display_name" required><label class="form-label">Username</label><input class="form-control mb-3 code-field" name="username" pattern="[a-z0-9][a-z0-9._-]{2,31}" minlength="3" maxlength="32" autocapitalize="none" required><label class="form-label">Email</label><input class="form-control mb-3" type="email" name="email" required><label class="form-label">Temporary password</label><input class="form-control mb-3" type="password" name="password" minlength="16" required><label class="form-label">Role</label><select class="form-select" name="role_id" required>${roleOptions}</select></div><div class="modal-footer"><button class="btn btn-primary">Create user</button></div></form></div></div>`:"";
    return reply.type("text/html").send(adminLayout("Users","/admin/users",session,`${alert(message.message,message.kind)}${create}<div class="card panel-card"><div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>2FA</th><th>Last login</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`));
  });

  app.post("/admin/users", async(request,reply)=>{
    const session=await sessionFor(request,reply,"users.write");if(!session||!requireCsrfOrReply(request,reply,session))return;
    const body=request.body as Record<string,string>; try{const password=body.password??"";if(password.length<16)throw new Error("Password must contain at least 16 characters"); const result=await db.query<{id:string}>("INSERT INTO users(username,email,display_name,password_hash,all_domains) VALUES($1,$2,$3,$4,false) RETURNING id",[normalizeUsername(body.username),body.email?.trim().toLowerCase(),body.display_name?.trim(),await hashPassword(password)]);await db.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)",[result.rows[0]!.id,body.role_id]);await audit(request,"user.created",{actorUserId:session.userId,targetType:"user",targetId:result.rows[0]!.id});return reply.redirect(`/admin/users/${result.rows[0]!.id}?ok=${encodeURIComponent("User created; assign domains before first login")}`,303);}catch(error){return reply.redirect(`/admin/users?error=${encodeURIComponent(error instanceof Error?error.message:"Creation failed")}`,303);}
  });

  app.get<{Params:{id:string}}>("/admin/users/:id",async(request,reply)=>{
    const session=await sessionFor(request,reply,"users.write");if(!session)return;
    const userResult=await db.query("SELECT id,username::text,email::text,display_name,locale,status,totp_enabled,all_domains FROM users WHERE id=$1",[request.params.id]);const user=userResult.rows[0];if(!user)return reply.code(404).send("Not found");
    const roles=await db.query("SELECT r.id,r.name::text,(ur.user_id IS NOT NULL) selected FROM roles r LEFT JOIN user_roles ur ON ur.role_id=r.id AND ur.user_id=$1 ORDER BY r.name",[request.params.id]);
    const effective=await db.query<{permission_code:string}>(`SELECT DISTINCT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1 AND NOT EXISTS(SELECT 1 FROM user_permission_overrides o WHERE o.user_id=$1 AND o.permission_code=rp.permission_code AND o.allowed=false) UNION SELECT permission_code FROM user_permission_overrides WHERE user_id=$1 AND allowed=true`,[request.params.id]);const allowed=new Set(effective.rows.map(r=>r.permission_code));
    const roleChecks=roles.rows.map(r=>`<div class="form-check"><input class="form-check-input" type="checkbox" name="roles" value="${r.id}" id="role-${r.id}" ${r.selected?"checked":""}><label class="form-check-label" for="role-${r.id}">${escapeHtml(r.name)}</label></div>`).join("");
    const permissionChecks=permissions.map(p=>`<div class="col-md-6 col-xl-4"><div class="form-check"><input class="form-check-input" type="checkbox" name="permissions" value="${p}" id="perm-${p}" ${allowed.has(p)?"checked":""}><label class="form-check-label code-field" for="perm-${p}">${p}</label></div></div>`).join("");
    const userDomains=await db.query("SELECT d.id,d.hostname::text,(uda.user_id IS NOT NULL) selected FROM domains d LEFT JOIN user_domain_access uda ON uda.domain_id=d.id AND uda.user_id=$1 ORDER BY d.is_primary DESC,d.hostname",[request.params.id]);
    const domainChecks=userDomains.rows.map(d=>`<div class="col-md-6 col-xl-4"><div class="form-check"><input class="form-check-input" type="checkbox" name="domain_ids" value="${d.id}" id="user-domain-${d.id}" ${d.selected?"checked":""}><label class="form-check-label" for="user-domain-${d.id}">${escapeHtml(d.hostname)}</label></div></div>`).join("");
    const message=queryMessage(request);const content=`${alert(message.message,message.kind)}<div class="card panel-card mb-4"><div class="card-body p-4"><div class="d-flex justify-content-between mb-4"><div><h2 class="h4 mb-1">${escapeHtml(user.display_name)}</h2><div class="text-secondary">@${escapeHtml(user.username)} · ${escapeHtml(user.email)}</div></div>${statusBadge(user.status)}</div><h3 class="h6 fw-bold">Account details</h3><form method="post" action="/admin/users/${user.id}/account">${csrfField(session.csrfToken)}<div class="row g-3"><div class="col-md-6"><label class="form-label">Display name</label><input class="form-control" name="display_name" maxlength="100" value="${escapeHtml(user.display_name)}" required></div><div class="col-md-6"><label class="form-label">Username</label><input class="form-control code-field" name="username" value="${escapeHtml(user.username)}" pattern="[a-z0-9][a-z0-9._-]{2,31}" required></div><div class="col-md-8"><label class="form-label">Email</label><input class="form-control" type="email" name="email" value="${escapeHtml(user.email)}" required></div><div class="col-md-4"><label class="form-label">Language</label><select class="form-select" name="locale"><option value="en" ${user.locale==="en"?"selected":""}>English</option><option value="fr" ${user.locale==="fr"?"selected":""}>French</option></select></div></div><button class="btn btn-outline-primary mt-3">Save account</button></form></div></div><div class="card panel-card"><form method="post" action="/admin/users/${user.id}/permissions"><div class="card-body p-4">${csrfField(session.csrfToken)}<h3 class="h6 fw-bold">Roles</h3><div class="mb-4">${roleChecks}</div><h3 class="h6 fw-bold">Effective personalized privileges</h3><p class="small text-secondary">These selections override role defaults for this user. Grant <code>stats.read</code> alone for statistics-only access.</p><div class="row g-2">${permissionChecks}</div><hr class="my-4"><h3 class="h6 fw-bold">Domain access</h3><p class="small text-secondary">Every dashboard, statistics and link query is restricted to this scope.</p><div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="all_domains" value="1" id="allDomains" ${user.all_domains?"checked":""}><label class="form-check-label fw-semibold" for="allDomains">Allow every domain</label></div><div class="row g-2">${domainChecks}</div></div><div class="card-footer bg-white p-4"><button class="btn btn-primary">Save privileges and domains</button><a href="/admin/users" class="btn btn-light">Cancel</a></div></form></div>`;
    return reply.type("text/html").send(adminLayout("User privileges","/admin/users",session,content));
  });

  app.post<{Params:{id:string}}>("/admin/users/:id/account",async(request,reply)=>{
    const session=await sessionFor(request,reply,"users.write");if(!session||!requireCsrfOrReply(request,reply,session))return;
    try {
      const account=normalizeAccount(request.body as Record<string,string|string[]>);
      const result=await db.query("UPDATE users SET username=$2,email=$3,display_name=$4,locale=$5,updated_at=now() WHERE id=$1 RETURNING id",[request.params.id,account.username,account.email,account.displayName,account.locale]);
      if(!result.rowCount)return reply.code(404).send("Not found");
      await audit(request,"user.account.updated",{actorUserId:session.userId,targetType:"user",targetId:request.params.id,metadata:{locale:account.locale}});
      return reply.redirect(`/admin/users/${request.params.id}?ok=${encodeURIComponent("Account updated")}`,303);
    } catch(error) {
      const message=String(error).includes("duplicate key")?"Username or email already in use":error instanceof Error?error.message:"Account update failed";
      return reply.redirect(`/admin/users/${request.params.id}?error=${encodeURIComponent(message)}`,303);
    }
  });

  app.post<{Params:{id:string}}>("/admin/users/:id/permissions",async(request,reply)=>{
    const session=await sessionFor(request,reply,"users.write");if(!session||!requireCsrfOrReply(request,reply,session))return;
    const body=request.body as Record<string,string|string[]>;
    const selectedPermissions=new Set(Array.isArray(body.permissions)?body.permissions:body.permissions?[String(body.permissions)]:[]);
    const selectedRoles=Array.isArray(body.roles)?body.roles:body.roles?[String(body.roles)]:[];
    const rawDomains=Array.isArray(body.domain_ids)?body.domain_ids:body.domain_ids?[String(body.domain_ids)]:[];
    const selectedDomains=rawDomains.filter((value)=>/^[0-9a-f-]{36}$/i.test(value));
    const allDomains=body.all_domains==="1";
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      await client.query("DELETE FROM user_roles WHERE user_id=$1",[request.params.id]);
      for(const role of selectedRoles)await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)",[request.params.id,role]);
      await client.query("DELETE FROM user_permission_overrides WHERE user_id=$1",[request.params.id]);
      for(const permission of permissions)await client.query("INSERT INTO user_permission_overrides(user_id,permission_code,allowed) VALUES($1,$2,$3)",[request.params.id,permission,selectedPermissions.has(permission)]);
      await client.query("UPDATE users SET all_domains=$2,updated_at=now() WHERE id=$1",[request.params.id,allDomains]);
      await client.query("DELETE FROM user_domain_access WHERE user_id=$1",[request.params.id]);
      if(!allDomains&&selectedDomains.length)await client.query("INSERT INTO user_domain_access(user_id,domain_id) SELECT $1,id FROM domains WHERE id=ANY($2::uuid[])",[request.params.id,selectedDomains]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2",[request.params.id,session.sessionId]);
    await audit(request,"user.permissions.updated",{actorUserId:session.userId,targetType:"user",targetId:request.params.id,metadata:{allDomains,domainIds:selectedDomains}});
    return reply.redirect("/admin/users",303);
  });

  app.post<{Params:{id:string}}>("/admin/users/:id/toggle",async(request,reply)=>{const session=await sessionFor(request,reply,"users.write");if(!session||!requireCsrfOrReply(request,reply,session)||request.params.id===session.userId)return;await db.query("UPDATE users SET status=CASE WHEN status='active' THEN 'suspended' ELSE 'active' END,updated_at=now() WHERE id=$1",[request.params.id]);await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1",[request.params.id]);await audit(request,"user.status.changed",{actorUserId:session.userId,targetType:"user",targetId:request.params.id});return reply.redirect("/admin/users",303);});

  app.get("/admin/api-clients", async(request,reply)=>{
    const session=await sessionFor(request,reply,"api.read");if(!session)return;const scope=domainScope(session);const clients=await db.query("SELECT * FROM api_clients WHERE ($1::uuid[] IS NULL OR domain_ids && $1::uuid[]) ORDER BY created_at DESC",[scope]);const domains=await db.query("SELECT id,hostname::text FROM domains WHERE status='active' AND ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY hostname",[scope]);
    const rows=clients.rows.map(c=>{const wordpress=session.permissions.includes("api.write")?(c.token_ciphertext?`<a class="btn btn-sm btn-outline-primary" href="/admin/api-clients/${c.id}/wordpress" title="WordPress connection block" aria-label="WordPress connection block"><i class="bi bi-wordpress"></i></a>`:`<button class="btn btn-sm btn-outline-secondary" type="button" disabled title="Token created before reusable encrypted configurations"><i class="bi bi-wordpress"></i></button>`):"";const revoke=c.status==="active"?`<form class="d-inline" method="post" action="/admin/api-clients/${c.id}/revoke">${csrfField(session.csrfToken)}<button class="btn btn-sm btn-outline-danger" data-confirm="Revoke this API client?">Revoke</button></form>`:"";return `<tr><td><div class="fw-bold">${escapeHtml(c.name)}</div><code>${escapeHtml(c.token_prefix)}…</code></td><td>${statusBadge(c.status)}</td><td>${escapeHtml(c.allowed_cidrs?.join(", ")||"Any")}</td><td>${c.rate_limit_per_minute}/min</td><td>${c.expires_at?new Date(c.expires_at).toLocaleString(localeTag(session.locale)):"No expiry"}</td><td>${c.last_used_at?new Date(c.last_used_at).toLocaleString(localeTag(session.locale)):"Never"}</td><td class="text-end"><div class="d-inline-flex gap-1">${wordpress}${revoke}</div></td></tr>`;}).join("")||'<tr><td colspan="7" class="text-center text-secondary py-5">No API clients.</td></tr>';
    const domainChecks=domains.rows.map(d=>`<div class="form-check"><input class="form-check-input" type="checkbox" name="domain_ids" value="${d.id}" id="d-${d.id}"><label class="form-check-label" for="d-${d.id}">${escapeHtml(d.hostname)}</label></div>`).join(""); const scopes=["links:read","links:write","links:delete","stats:read","domains:read"].map(s=>`<div class="form-check form-check-inline"><input class="form-check-input" type="checkbox" name="scopes" value="${s}" id="s-${s}" checked><label class="form-check-label" for="s-${s}">${s}</label></div>`).join(""); const message=queryMessage(request);
    const create=session.permissions.includes("api.write")?`<button class="btn btn-primary mb-3" data-bs-toggle="modal" data-bs-target="#createApi"><i class="bi bi-key"></i> New API client</button><div class="modal fade" id="createApi"><div class="modal-dialog modal-lg"><form class="modal-content" method="post" action="/admin/api-clients">${csrfField(session.csrfToken)}<div class="modal-header"><h2 class="h5 modal-title">Create API client</h2><button class="btn-close" type="button" data-bs-dismiss="modal"></button></div><div class="modal-body"><label class="form-label">Name</label><input class="form-control mb-3" name="name" required><label class="form-label">Allowed CIDRs <span class="text-secondary">comma-separated</span></label><input class="form-control code-field mb-3" name="allowed_cidrs" placeholder="203.0.113.5/32" required><label class="form-label">Rate limit per minute</label><input class="form-control mb-3" type="number" name="rate_limit" min="1" max="10000" value="120"><label class="form-label">Expires at <span class="text-secondary">optional</span></label><input class="form-control mb-3" type="datetime-local" name="expires_at"><label class="form-label d-block">Scopes</label><div class="mb-3">${scopes}</div><label class="form-label">Domains</label>${domainChecks}<div class="form-text">Select none to allow every active domain.</div></div><div class="modal-footer"><button class="btn btn-primary">Generate client</button></div></form></div></div>`:"";
    const wordpress=`<div class="card panel-card mb-4 overflow-hidden"><div class="card-body p-4 p-lg-5"><div class="row align-items-center g-4"><div class="col-lg-8"><div class="text-uppercase text-primary small fw-bold mb-2">WordPress integration · v1.3.1</div><h2 class="h3 fw-bold">Shortlinks inside the WordPress editor</h2><p class="text-secondary mb-3">Generate links automatically by content type, copy them in one click, run controlled bulk jobs, and open detailed analytics on shurl.be without slowing WordPress pages.</p><div class="d-flex flex-wrap gap-2"><span class="badge text-bg-light">Automatic generation</span><span class="badge text-bg-light">IP-restricted API</span><span class="badge text-bg-light">Fast local summary</span><span class="badge text-bg-light">Update checks</span></div></div><div class="col-lg-4 text-lg-end"><a class="btn btn-dark btn-lg" href="/assets/downloads/shortlinker-wordpress.zip" download><i class="bi bi-wordpress me-2"></i>Download plugin</a><div class="small text-secondary mt-2">WordPress 6.5+ · PHP 7.4+</div></div></div></div><div class="card-footer bg-light border-0 px-4 py-3"><i class="bi bi-info-circle me-2"></i>Create a dedicated client, restrict it to the WordPress server IP and selected domains, then paste the generated connection block in <strong>Settings → Shortlinker</strong>.</div></div>`;
    return reply.type("text/html").send(adminLayout("API clients","/admin/api-clients",session,`${alert(message.message,message.kind)}${wordpress}${create}<div class="card panel-card"><div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Client</th><th>Status</th><th>IP allowlist</th><th>Quota</th><th>Expires</th><th>Last use</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`));
  });

  app.post("/admin/api-clients",async(request,reply)=>{
    const session=await sessionFor(request,reply,"api.write");if(!session||!requireCsrfOrReply(request,reply,session))return;
    const body=request.body as Record<string,string|string[]>;
    try {
      const prefix=randomToken(6);const secret=randomToken(32);const token=`shurl_live_${prefix}_${secret}`;
      const scopes=Array.isArray(body.scopes)?body.scopes:body.scopes?[String(body.scopes)]:[];
      const domainIds=Array.isArray(body.domain_ids)?body.domain_ids:body.domain_ids?[String(body.domain_ids)]:[];
      const cidrs=String(body.allowed_cidrs??"").split(",").map(v=>v.trim()).filter(Boolean);
      const expiresAt=String(body.expires_at??"").trim()||null;
      if(!String(body.name??"").trim())throw new Error("Client name is required");
      if(!cidrs.length)throw new Error("At least one source CIDR is required");
      if(!session.allDomains&&(!domainIds.length||domainIds.some(id=>!canAccessDomain(session,id))))throw new Error("Select only domains assigned to your account");
      if(expiresAt&&new Date(expiresAt).getTime()<=Date.now())throw new Error("Expiry must be in the future");
      const selectedDomain=await db.query<{hostname:string}>("SELECT hostname::text FROM domains WHERE status='active' AND ($1::uuid[]='{}' OR id=ANY($1)) ORDER BY is_primary DESC,hostname LIMIT 1",[domainIds]);
      if(!selectedDomain.rows[0])throw new Error("Select at least one active domain");
      const result=await db.query<{id:string}>("INSERT INTO api_clients(name,token_prefix,token_hash,token_ciphertext,scopes,allowed_cidrs,domain_ids,rate_limit_per_minute,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6::cidr[],$7::uuid[],$8,$9,$10) RETURNING id",[String(body.name).trim(),prefix,sha256(token),encrypt(token),scopes,cidrs,domainIds,Number(body.rate_limit)||120,expiresAt,session.userId]);
      await audit(request,"api_client.created",{actorUserId:session.userId,targetType:"api_client",targetId:result.rows[0]!.id});
      const connection=JSON.stringify({version:1,apiBase:`${config.PUBLIC_ORIGIN}/api/v1`,token,domain:selectedDomain.rows[0].hostname,defaultRedirectType:302,defaultTags:["wordpress"]},null,2);
      const content=`<div class="alert alert-warning"><strong>Store this token securely.</strong> Privileged administrators can reopen its encrypted WordPress connection block from the client list.</div><div class="card panel-card mb-4"><div class="card-body p-4"><label class="form-label fw-bold">Bearer token</label><div class="input-group"><input id="newToken" class="form-control code-field" readonly value="${escapeHtml(token)}"><button class="btn btn-primary" type="button" data-copy="#newToken"><i class="bi bi-copy"></i> Copy</button></div></div></div><div class="card panel-card"><div class="card-body p-4"><div class="d-flex justify-content-between align-items-center mb-2"><label class="form-label fw-bold mb-0">WordPress connection block</label><button class="btn btn-sm btn-outline-primary" type="button" data-copy="#wordpressConfig"><i class="bi bi-copy"></i> Copy config</button></div><textarea id="wordpressConfig" class="form-control code-field" rows="11" readonly>${escapeHtml(connection)}</textarea><div class="form-text">Paste this complete JSON block in WordPress → Settings → Shortlinker.</div></div></div><a href="/admin/api-clients" class="btn btn-outline-secondary mt-4">Done</a>`;
      return reply.type("text/html").send(adminLayout("API client created","/admin/api-clients",session,content));
    } catch(error) {return reply.redirect(`/admin/api-clients?error=${encodeURIComponent(error instanceof Error?error.message:"Creation failed")}`,303);}
  });

  app.get<{Params:{id:string}}>("/admin/api-clients/:id/wordpress",async(request,reply)=>{
    const session=await sessionFor(request,reply,"api.write");if(!session)return;
    const result=await db.query<{id:string;name:string;token_ciphertext:string|null;hostname:string|null}>(`SELECT c.id,c.name,c.token_ciphertext,
      coalesce((SELECT d.hostname::text FROM domains d WHERE d.id=ANY(c.domain_ids) AND d.status='active' ORDER BY d.is_primary DESC,d.hostname LIMIT 1),
               (SELECT d.hostname::text FROM domains d WHERE d.status='active' ORDER BY d.is_primary DESC,d.hostname LIMIT 1)) AS hostname
      FROM api_clients c WHERE c.id=$1 AND ($2::uuid[] IS NULL OR c.domain_ids && $2::uuid[])`,[request.params.id,domainScope(session)]);
    const client=result.rows[0];
    if(!client)return reply.code(404).send("Not found");
    if(!client.token_ciphertext||!client.hostname)return reply.redirect(`/admin/api-clients?error=${encodeURIComponent("This historical client has no reusable encrypted token; create or rotate it to generate a WordPress configuration")}`,303);
    const connection=JSON.stringify({version:1,apiBase:`${config.PUBLIC_ORIGIN}/api/v1`,token:decrypt(client.token_ciphertext),domain:client.hostname,defaultRedirectType:302,defaultTags:["wordpress"]},null,2);
    await audit(request,"api_client.wordpress_config.viewed",{actorUserId:session.userId,targetType:"api_client",targetId:client.id});
    const content=`<div class="alert alert-info"><i class="bi bi-shield-lock me-2"></i>This block contains an API secret. Copy it only into the intended WordPress administration.</div><div class="card panel-card"><div class="card-body p-4"><div class="d-flex justify-content-between align-items-center mb-2"><div><div class="text-secondary small">${escapeHtml(client.name)}</div><label class="form-label fw-bold mb-0">WordPress connection block</label></div><button class="btn btn-primary" type="button" data-copy="#wordpressConfig"><i class="bi bi-copy"></i> Copy config</button></div><textarea id="wordpressConfig" class="form-control code-field" rows="11" readonly>${escapeHtml(connection)}</textarea></div></div><a href="/admin/api-clients" class="btn btn-outline-secondary mt-4"><i class="bi bi-arrow-left"></i> Back to API clients</a>`;
    return reply.type("text/html").send(adminLayout("WordPress connection","/admin/api-clients",session,content));
  });

  app.post<{Params:{id:string}}>("/admin/api-clients/:id/revoke",async(request,reply)=>{const session=await sessionFor(request,reply,"api.write");if(!session||!requireCsrfOrReply(request,reply,session))return;await db.query("UPDATE api_clients SET status='revoked',revoked_at=now() WHERE id=$1 AND ($2::uuid[] IS NULL OR domain_ids && $2::uuid[])",[request.params.id,domainScope(session)]);await audit(request,"api_client.revoked",{actorUserId:session.userId,targetType:"api_client",targetId:request.params.id});return reply.redirect("/admin/api-clients",303);});

  app.get("/admin/settings",async(request,reply)=>{const session=await sessionFor(request,reply,"settings.read");if(!session)return;const turnstile=await getSetting<TurnstileSettings>("turnstile",{enabled:false,siteKey:"",secretEncrypted:""});const privacy=await getSetting("privacy",{rawIpRetentionDays:7});const message=queryMessage(request);const content=`${alert(message.message,message.kind)}<div class="row g-4"><div class="col-xl-7"><div class="card panel-card"><div class="card-body p-4"><h2 class="h5 fw-bold"><i class="bi bi-cloud-check me-2"></i>Cloudflare Turnstile</h2><p class="text-secondary">Protect the login form. The secret is encrypted at rest and never displayed.</p><form method="post" action="/admin/settings/turnstile">${csrfField(session.csrfToken)}<div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="enabled" value="1" id="turnstileEnabled" ${turnstile.enabled?"checked":""}><label class="form-check-label" for="turnstileEnabled">Enable on login</label></div><label class="form-label">Site key</label><input class="form-control code-field mb-3" name="site_key" value="${escapeHtml(turnstile.siteKey)}"><label class="form-label">Secret key</label><input class="form-control code-field mb-1" type="password" name="secret_key" placeholder="${turnstile.secretEncrypted?"Stored — leave blank to keep":"Enter secret key"}"><div class="form-text mb-3">Hostnames must be restricted to shurl.be in Cloudflare.</div><button class="btn btn-primary">Save Turnstile</button></form></div></div></div><div class="col-xl-5"><div class="card panel-card"><div class="card-body p-4"><h2 class="h5 fw-bold">Privacy retention</h2><form method="post" action="/admin/settings/privacy">${csrfField(session.csrfToken)}<label class="form-label">Encrypted raw IP retention</label><div class="input-group"><input class="form-control" type="number" min="0" max="365" name="days" value="${Number(privacy.rawIpRetentionDays)}"><span class="input-group-text">days</span></div><div class="form-text mb-3">Country and pseudonymous aggregates remain available.</div><button class="btn btn-outline-primary">Update retention</button></form></div></div></div></div>`;return reply.type("text/html").send(adminLayout("Settings","/admin/settings",session,content));});

  app.post("/admin/settings/turnstile",async(request,reply)=>{const session=await sessionFor(request,reply,"settings.write");if(!session||!requireCsrfOrReply(request,reply,session))return;const body=request.body as Record<string,string>;const previous=await getSetting<TurnstileSettings>("turnstile",{enabled:false,siteKey:"",secretEncrypted:""});const next={enabled:body.enabled==="1",siteKey:String(body.site_key??"").trim(),secretEncrypted:body.secret_key?encrypt(String(body.secret_key)):previous.secretEncrypted};if(next.enabled&&(!next.siteKey||!next.secretEncrypted))return reply.redirect(`/admin/settings?error=${encodeURIComponent("Both Turnstile keys are required before enabling")}`,303);await setSetting("turnstile",next,session.userId);await audit(request,"settings.turnstile.updated",{actorUserId:session.userId,metadata:{enabled:next.enabled,secretRotated:Boolean(body.secret_key)}});return reply.redirect(`/admin/settings?ok=${encodeURIComponent("Turnstile settings saved")}`,303);});
  app.post("/admin/settings/privacy",async(request,reply)=>{const session=await sessionFor(request,reply,"settings.write");if(!session||!requireCsrfOrReply(request,reply,session))return;const days=clampRetentionDays((request.body as Record<string,string>).days);await setSetting("privacy",{rawIpRetentionDays:days},session.userId);await audit(request,"settings.privacy.updated",{actorUserId:session.userId,metadata:{days}});return reply.redirect(`/admin/settings?ok=${encodeURIComponent("Retention updated")}`,303);});

  app.get("/admin/security",async(_request,reply)=>reply.redirect("/admin/profile",308));

  app.post("/admin/profile",async(request,reply)=>{
    const session=await sessionFor(request,reply);if(!session||!requireCsrfOrReply(request,reply,session))return;
    try {
      const account=normalizeAccount(request.body as Record<string,string|string[]>);
      await db.query("UPDATE users SET username=$2,email=$3,display_name=$4,locale=$5,updated_at=now() WHERE id=$1",[session.userId,account.username,account.email,account.displayName,account.locale]);
      await audit(request,"user.profile.updated",{actorUserId:session.userId,targetType:"user",targetId:session.userId,metadata:{locale:account.locale}});
      reply.setCookie("shurl_locale",account.locale,{path:"/",secure:config.isProduction,sameSite:"strict",maxAge:31_536_000});
      return reply.redirect(`/admin/profile?ok=${encodeURIComponent(account.locale==="fr"?"Profil enregistré":"Profile saved")}`,303);
    } catch(error) {
      const message=String(error).includes("duplicate key")?"Username or email already in use":error instanceof Error?error.message:"Profile update failed";
      return reply.redirect(`/admin/profile?error=${encodeURIComponent(message)}`,303);
    }
  });

  app.get("/admin/profile",async(request,reply)=>{const session=await sessionFor(request,reply);if(!session)return;const userResult=await db.query<{totp_enabled:boolean;totp_secret_encrypted:string|null}>("SELECT totp_enabled,totp_secret_encrypted FROM users WHERE id=$1",[session.userId]);const user=userResult.rows[0]!;let setup="";if(!user.totp_enabled){let secret:string;if(user.totp_secret_encrypted)secret=decrypt(user.totp_secret_encrypted);else{secret=createTotpSecret();await db.query("UPDATE users SET totp_secret_encrypted=$2 WHERE id=$1",[session.userId,encrypt(secret)]);}const uri=createTotpUri(session.email,config.WEBAUTHN_RP_NAME,secret);const qr=await QRCode.toDataURL(uri,{width:240,margin:1});setup=`<div class="alert alert-warning"><strong>MFA setup required.</strong> Other administration areas remain locked until activation.</div><div class="row align-items-center g-4"><div class="col-md-auto"><img src="${qr}" width="240" height="240" alt="TOTP QR code" class="img-thumbnail"></div><div class="col"><h2 class="h5 fw-bold">Scan with your authenticator</h2><p class="text-secondary">Then enter the current six-digit code to confirm.</p><code class="d-block p-3 bg-light rounded mb-3 text-break">${escapeHtml(secret)}</code><form method="post" action="/admin/profile/totp">${csrfField(session.csrfToken)}<div class="input-group"><input class="form-control form-control-lg code-field" name="code" inputmode="numeric" maxlength="6" required><button class="btn btn-primary">Activate 2FA</button></div></form></div></div>`;}else setup=`<div class="d-flex align-items-center gap-3"><div class="feature-icon text-success"><i class="bi bi-shield-check"></i></div><div><h2 class="h5 mb-1">Two-factor authentication enabled</h2><p class="text-secondary mb-0">Your account requires a password and authenticator code.</p></div></div>`;const sessions=await db.query("SELECT id,user_agent,created_at,last_seen_at,ip_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC",[session.userId]);const sessionRows=sessions.rows.map(s=>`<tr><td>${s.id===session.sessionId?'<span class="badge text-bg-success">Current</span>':'Session'}</td><td class="text-truncate" style="max-width:360px">${escapeHtml(s.user_agent||"Unknown client")}</td><td>${new Date(s.last_seen_at).toLocaleString(localeTag(session.locale))}</td></tr>`).join("");const passwordSetup=`<div class="card panel-card mb-4 ${session.requirePasswordChange?"border-warning":""}"><div class="card-body p-4"><h2 class="h5 fw-bold">${session.requirePasswordChange?"Replace the temporary password":"Change password"}</h2><p class="text-secondary">${session.requirePasswordChange?"Choose a unique password of at least 16 characters before using the control plane.":"Use your current password to choose a new one of at least 16 characters."}</p><form method="post" action="/admin/profile/password">${csrfField(session.csrfToken)}<div class="row g-3"><div class="col-md-4"><input class="form-control" type="password" name="current_password" autocomplete="current-password" placeholder="Current password" required></div><div class="col-md-4"><input class="form-control" type="password" name="new_password" autocomplete="new-password" minlength="16" placeholder="New password" required></div><div class="col-md-4"><input class="form-control" type="password" name="confirm_password" autocomplete="new-password" minlength="16" placeholder="Confirm password" required></div></div><button class="btn btn-warning mt-3">Change password</button></form></div></div>`;const profileSetup=`<div class="card panel-card mb-4"><div class="card-body p-4"><div class="d-flex align-items-center gap-3 mb-4"><span class="profile-avatar profile-avatar-lg">${escapeHtml(session.displayName.slice(0,1).toUpperCase())}</span><div><h2 class="h5 fw-bold mb-1">Personal information</h2><div class="text-secondary">@${escapeHtml(session.username)}</div></div></div><form method="post" action="/admin/profile">${csrfField(session.csrfToken)}<div class="row g-3"><div class="col-md-6"><label class="form-label">Display name</label><input class="form-control" name="display_name" maxlength="100" value="${escapeHtml(session.displayName)}" required></div><div class="col-md-6"><label class="form-label">Username</label><input class="form-control code-field" name="username" pattern="[a-z0-9][a-z0-9._-]{2,31}" value="${escapeHtml(session.username)}" required></div><div class="col-md-8"><label class="form-label">Email</label><input class="form-control" type="email" name="email" value="${escapeHtml(session.email)}" required></div><div class="col-md-4"><label class="form-label">Language</label><select class="form-select" name="locale"><option value="en" ${session.locale==="en"?"selected":""}>English</option><option value="fr" ${session.locale==="fr"?"selected":""}>French</option></select></div></div><button class="btn btn-primary mt-4">Save profile</button></form></div></div>`;const message=queryMessage(request);const content=`${alert(message.message,message.kind)}${profileSetup}${passwordSetup}<div class="card panel-card mb-4"><div class="card-body p-4">${setup}</div></div><div class="card panel-card"><div class="card-header bg-white fw-bold">Active sessions</div><div class="table-responsive"><table class="table mb-0"><thead><tr><th></th><th>Client</th><th>Last seen</th></tr></thead><tbody>${sessionRows}</tbody></table></div></div>`;return reply.type("text/html").send(adminLayout("My profile","/admin/profile",session,content));});

  app.post("/admin/profile/password",async(request,reply)=>{const session=await sessionFor(request,reply);if(!session||!requireCsrfOrReply(request,reply,session))return;const body=request.body as Record<string,string>;const current=body.current_password??"";const next=body.new_password??"";if(next.length<16||next!==body.confirm_password)return reply.redirect(`/admin/profile?error=${encodeURIComponent("New passwords must match and contain at least 16 characters")}`,303);const user=await db.query<{password_hash:string}>("SELECT password_hash FROM users WHERE id=$1",[session.userId]);if(!user.rows[0]||!await verifyPassword(user.rows[0].password_hash,current))return reply.redirect(`/admin/profile?error=${encodeURIComponent("Current password is incorrect")}`,303);await db.query("UPDATE users SET password_hash=$2,require_password_change=false,updated_at=now() WHERE id=$1",[session.userId,await hashPassword(next)]);await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2",[session.userId,session.sessionId]);await audit(request,"auth.password.changed",{actorUserId:session.userId});return reply.redirect(`/admin/profile?ok=${encodeURIComponent("Password changed")}`,303);});

  app.post("/admin/profile/totp",async(request,reply)=>{const session=await sessionFor(request,reply);if(!session||!requireCsrfOrReply(request,reply,session))return;const user=await db.query<{totp_secret_encrypted:string}>("SELECT totp_secret_encrypted FROM users WHERE id=$1",[session.userId]);const secret=user.rows[0]?.totp_secret_encrypted?decrypt(user.rows[0].totp_secret_encrypted):"";const code=String((request.body as Record<string,string>).code??"");const totpValid=secret?await verifyTotpToken(code,secret):false;if(!totpValid)return reply.code(400).type("text/html").send(adminLayout("My profile","/admin/profile",session,alert("Invalid authenticator code.","danger")));const codes=Array.from({length:10},()=>randomToken(9).replace(/[^A-Z0-9]/gi,"").slice(0,12).toUpperCase().padEnd(12,"X"));const client=await db.connect();try{await client.query("BEGIN");await client.query("UPDATE users SET totp_enabled=true WHERE id=$1",[session.userId]);await client.query("DELETE FROM recovery_codes WHERE user_id=$1",[session.userId]);for(const recovery of codes)await client.query("INSERT INTO recovery_codes(user_id,code_hash) VALUES($1,$2)",[session.userId,await hashPassword(recovery)]);await client.query("UPDATE sessions SET mfa_verified=true WHERE id=$1",[session.sessionId]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}await audit(request,"auth.mfa.enrolled",{actorUserId:session.userId});const list=codes.map(c=>`<code class="d-block">${c}</code>`).join("");return reply.type("text/html").send(adminLayout("Recovery codes","/admin/profile",{...session,mfaVerified:true},`<div class="alert alert-success"><strong>2FA is active.</strong></div><div class="card panel-card"><div class="card-body p-4"><h2 class="h5 fw-bold">Save these recovery codes now</h2><p class="text-secondary">Each code works once. They will not be displayed again.</p><div id="recoveryCodes" class="bg-light p-4 rounded code-field">${list}</div><button class="btn btn-primary mt-3" type="button" data-copy="#recoveryCodes"><i class="bi bi-copy"></i> Copy all</button><a href="/admin" class="btn btn-outline-secondary mt-3">Continue</a></div></div>`));});

  app.get("/admin/audit",async(request,reply)=>{const session=await sessionFor(request,reply,"audit.read");if(!session)return;const logs=await db.query(`SELECT a.*,u.email::text FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 200`);const rows=logs.rows.map(l=>`<tr><td>${new Date(l.created_at).toLocaleString(localeTag(session.locale))}</td><td><code>${escapeHtml(l.action)}</code></td><td>${escapeHtml(l.email??l.api_client_id??"system")}</td><td>${statusBadge(l.outcome)}</td><td>${escapeHtml(l.target_type??"")} ${escapeHtml(l.target_id??"")}</td></tr>`).join("");return reply.type("text/html").send(adminLayout("Audit log","/admin/audit",session,`<div class="card panel-card"><div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Outcome</th><th>Target</th></tr></thead><tbody>${rows}</tbody></table></div></div>`));});

  app.get("/admin/abuse",async(request,reply)=>{const session=await sessionFor(request,reply,"abuse.manage");if(!session)return;const reports=await db.query(`SELECT a.*,d.hostname::text,l.slug FROM abuse_reports a LEFT JOIN links l ON l.id=a.link_id LEFT JOIN domains d ON d.id=l.domain_id ORDER BY a.created_at DESC LIMIT 200`);const rows=reports.rows.map(r=>`<tr><td>${new Date(r.created_at).toLocaleString(localeTag(session.locale))}</td><td>${statusBadge(r.status)}</td><td><strong>${escapeHtml(r.reason)}</strong><div class="small text-secondary">${escapeHtml(r.details)}</div></td><td>${r.hostname?escapeHtml(`${r.hostname}/${r.slug}`):"Unmatched"}</td><td class="text-end">${r.link_id?`<form method="post" action="/admin/abuse/${r.id}/suspend">${csrfField(session.csrfToken)}<button class="btn btn-sm btn-danger" data-confirm="Suspend this link?">Suspend link</button></form>`:""}</td></tr>`).join("")||'<tr><td colspan="5" class="text-center text-secondary py-5">No abuse reports.</td></tr>';return reply.type("text/html").send(adminLayout("Abuse reports","/admin/abuse",session,`<div class="card panel-card"><div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Received</th><th>Status</th><th>Report</th><th>Link</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`));});

  app.post<{Params:{id:string}}>("/admin/abuse/:id/suspend",async(request,reply)=>{const session=await sessionFor(request,reply,"abuse.manage");if(!session||!requireCsrfOrReply(request,reply,session))return;const result=await db.query<{link_id:string;hostname:string;slug:string}>(`WITH report AS (UPDATE abuse_reports SET status='resolved',resolved_by=$2,resolved_at=now() WHERE id=$1 RETURNING link_id) UPDATE links l SET status='suspended',updated_at=now(),updated_by=$2 FROM report r,domains d WHERE l.id=r.link_id AND d.id=l.domain_id RETURNING l.id AS link_id,d.hostname::text,l.slug`,[request.params.id,session.userId]);const link=result.rows[0];if(link){await invalidateLink(link.hostname,link.slug);await audit(request,"abuse.link.suspended",{actorUserId:session.userId,targetType:"link",targetId:link.link_id});}return reply.redirect("/admin/abuse",303);});
};
