import type { UserSession } from "./types.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]!);
}

const icon = (name: string) => `<i class="bi bi-${name}"></i>`;

export function alert(message?: string, kind: "success" | "danger" | "warning" | "info" = "info"): string {
  return message ? `<div class="alert alert-${kind} border-0 shadow-sm" role="alert">${escapeHtml(message)}</div>` : "";
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(token)}">`;
}

function head(title: string, turnstile = false): string {
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · Shortlinker</title>
  <link rel="stylesheet" href="/assets/vendor/bootstrap/bootstrap.min.css">
  <link rel="stylesheet" href="/assets/vendor/bootstrap-icons/bootstrap-icons.min.css">
  <link rel="stylesheet" href="/assets/app.css?v=20261004-2">
  ${turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
  </head>`;
}

const navItems = [
  ["/admin", "speedometer2", "Overview", ""],
  ["/admin/links", "link-45deg", "Links", "links.read"],
  ["/admin/domains", "globe2", "Domains", "domains.read"],
  ["/admin/users", "people", "Users", "users.read"],
  ["/admin/api-clients", "braces", "API clients", "api.read"],
  ["/admin/abuse", "shield-exclamation", "Abuse", "abuse.manage"],
  ["/admin/audit", "journal-check", "Audit log", "audit.read"],
  ["/admin/settings", "sliders", "Settings", "settings.read"],
  ["/admin/security", "fingerprint", "Security", ""]
] as const;

export function adminLayout(title: string, active: string, session: UserSession, content: string): string {
  const nav = navItems.filter((item) => !item[3] || session.permissions.includes(item[3])).map(([href, glyph, label]) =>
    `<a class="nav-link ${active === href ? "active" : ""}" href="${href}">${icon(glyph)}${label}</a>`).join("");
  return `${head(title)}<body><div class="container-fluid admin-shell"><div class="row">
    <aside class="col-lg-2 px-3 py-4 admin-sidebar">
      <a href="/admin" class="navbar-brand text-white d-flex align-items-center mb-4"><span class="brand-mark">S</span>Shortlinker</a>
      <nav class="nav nav-pills flex-column gap-1">${nav}</nav>
      <div class="mt-5 pt-4 border-top border-secondary-subtle small">
        <div class="text-white fw-semibold">${escapeHtml(session.displayName)}</div>
        <div class="text-secondary text-truncate">@${escapeHtml(session.username)} · ${escapeHtml(session.email)}</div>
        <form action="/auth/logout" method="post" class="mt-3">${csrfField(session.csrfToken)}
          <button class="btn btn-sm btn-outline-light w-100">${icon("box-arrow-right")} Sign out</button>
        </form>
      </div>
    </aside>
    <main class="col-lg-10 admin-main px-3 px-md-5 py-4 py-md-5">
      <header class="d-flex align-items-center justify-content-between mb-4"><div><div class="text-uppercase text-secondary small fw-bold">Control plane</div><h1 class="h2 mb-0 fw-bold">${escapeHtml(title)}</h1></div><span class="badge rounded-pill text-bg-dark"><span class="pulse-dot me-2"></span>Live</span></header>
      ${content}
    </main>
  </div></div><script src="/assets/vendor/bootstrap/bootstrap.bundle.min.js"></script><script src="/assets/app.js?v=20261004-2"></script></body></html>`;
}

export function landingPage(): string {
  return `${head("High-performance links")}<body class="landing">
  <nav class="navbar navbar-expand-lg navbar-dark fixed-top"><div class="container py-2">
    <a class="navbar-brand" href="/"><span class="brand-mark">S</span>shurl.be</a>
    <div class="ms-auto d-flex gap-2"><a href="#platform" class="btn btn-link text-light text-decoration-none">Platform</a><a href="/api/v1" class="btn btn-link text-light text-decoration-none d-none d-md-inline-flex">API</a><a href="/auth/login" class="btn btn-outline-light rounded-pill px-4">Admin</a></div>
  </div></nav>
  <main><section class="hero"><div class="hero-grid"></div><div class="container position-relative">
    <div class="hero-copy-block text-center mx-auto"><div class="hero-kicker mb-4"><span class="pulse-dot me-3"></span>The link intelligence layer</div>
      <h1>Shorten the URL.<br><span class="gradient-text">Expand the signal.</span></h1>
      <p class="hero-copy mx-auto my-4">Turn unwieldy destinations into instant, measurable routes. One compact link feeds real-time intelligence, secure automation, and decisions that move at click speed.</p>
      <div class="d-flex justify-content-center flex-wrap gap-3"><a href="#flow" class="btn btn-primary btn-lg rounded-pill px-4">See the signal flow ${icon("arrow-down-right")}</a><a href="/api/v1" class="btn btn-outline-light btn-lg rounded-pill px-4">Explore the API</a></div>
    </div>

    <div id="flow" class="signal-board mt-5" aria-label="A long URL is transformed into a short link connected to analytics and API services">
      <div class="board-chrome"><div class="chrome-dots"><i></i><i></i><i></i></div><div class="board-status"><span class="pulse-dot"></span> ROUTING LIVE</div><div class="board-latency">EDGE / 12 MS</div></div>
      <div class="signal-canvas">
        <svg class="signal-lines" viewBox="0 0 1200 460" role="presentation" aria-hidden="true">
          <defs><linearGradient id="signalGradient"><stop offset="0" stop-color="#7457ff"/><stop offset="1" stop-color="#19d3da"/></linearGradient><filter id="signalGlow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
          <path class="signal-path base" d="M300 230 C390 230 420 230 505 230"/>
          <path class="signal-path base" d="M695 230 C770 230 755 118 840 118"/>
          <path class="signal-path base" d="M695 230 C770 230 755 342 840 342"/>
          <path class="signal-path active path-one" d="M300 230 C390 230 420 230 505 230"/>
          <path class="signal-path active path-two" d="M695 230 C770 230 755 118 840 118"/>
          <path class="signal-path active path-three" d="M695 230 C770 230 755 342 840 342"/>
        </svg>

        <article class="flow-node source-node">
          <div class="node-label"><span>${icon("globe2")} SOURCE URL</span><span class="node-state">INPUT</span></div>
          <div class="url-stack"><span>https://commerce.example.com</span><strong>/campaigns/autumn-2026/</strong><span>performance?source=network</span></div>
          <div class="node-foot"><span>2,048+ chars ready</span><span>${icon("lock-fill")} HTTPS</span></div>
        </article>

        <article class="flow-node core-node">
          <div class="core-orbit orbit-one"></div><div class="core-orbit orbit-two"></div>
          <div class="core-bolt">${icon("lightning-charge-fill")}</div>
          <div class="node-label justify-content-center">SHORTLINK CORE</div>
          <div class="short-output">shurl.be/<strong>aB7xK2q</strong></div>
          <div class="core-meta"><span>302</span><span>cached</span><span>tracked</span></div>
        </article>

        <article class="flow-node stats-node">
          <div class="node-label"><span>${icon("graph-up-arrow")} LIVE ANALYTICS</span><span class="node-state live">REAL TIME</span></div>
          <div class="stats-summary"><div><strong>24.8K</strong><span>clicks</span></div><div><strong>91.4%</strong><span>human</span></div><div><strong>37</strong><span>countries</span></div></div>
          <div class="mini-chart" aria-hidden="true"><i class="bar-1"></i><i class="bar-2"></i><i class="bar-3"></i><i class="bar-4"></i><i class="bar-5"></i><i class="bar-6"></i><i class="bar-7"></i><i class="bar-8"></i><i class="bar-9"></i><i class="bar-10"></i><i class="bar-11"></i><i class="bar-12"></i></div>
        </article>

        <article class="flow-node api-node">
          <div class="node-label"><span>${icon("braces-asterisk")} AUTOMATION API</span><span class="node-state">V1</span></div>
          <pre><span>POST</span> /api/v1/links
{
  <b>"domain"</b>: "shurl.be",
  <b>"destination"</b>: "https://…"
}</pre>
          <div class="api-foot"><span>${icon("shield-check")} Scoped token</span><span>201 CREATED</span></div>
        </article>
      </div>
      <div class="board-metrics"><div><span>REDIRECT PATH</span><strong>&lt; 15 ms</strong></div><div><span>EVENT CAPTURE</span><strong>ASYNC</strong></div><div><span>DOMAINS</span><strong>VERIFIED</strong></div><div><span>TRANSPORT</span><strong>TLS 1.3</strong></div></div>
    </div>
  </div></section>
  <section id="platform" class="pb-5"><div class="container py-5"><div class="row mb-5"><div class="col-lg-7"><div class="hero-kicker">One compact control plane</div><h2 class="display-5 fw-bold mt-3">Power behind a seven-character link.</h2></div></div>
    <div class="row g-4 feature-grid">
      ${feature("graph-up-arrow", "Clarity at every click", "Human and bot traffic, country, device, referrer and temporal trends in one focused view.")}
      ${feature("shield-check", "Control without compromise", "Granular roles, mandatory MFA, restricted administration and a complete audit trail.")}
      ${feature("globe-americas", "Every domain, one engine", "Attach verified domains with DNS TXT ownership checks and automatic HTTPS.")}
      ${feature("braces-asterisk", "API built for automation", "Scoped, revocable API clients with IP allowlists, quotas and predictable responses.")}
      ${feature("speedometer", "Redirects stay lean", "PostgreSQL truth, Redis cache and asynchronous analytics keep the hot path fast.")}
      ${feature("ban", "Abuse has nowhere to hide", "Suspend destinations instantly, collect reports and preserve a forensic audit trail.")}
    </div>
  </div></section></main>
  <footer class="footer-dark py-4">
    <div class="container footer-inner">
      <div>© ${new Date().getFullYear()} Shortlinker · A <a href="https://jessysystem.com/" target="_blank" rel="noopener noreferrer">Jessy System</a> project.</div>
      <a class="footer-github" href="https://github.com/TheLibertyWolf/shortlinker" target="_blank" rel="noopener noreferrer" aria-label="View Shortlinker on GitHub">
        <i class="bi bi-github" aria-hidden="true"></i><span>GitHub repository</span>
      </a>
    </div>
  </footer>
  <script src="/assets/vendor/bootstrap/bootstrap.bundle.min.js"></script></body></html>`;
}

function feature(glyph: string, title: string, copy: string): string {
  return `<div class="col-md-6 col-xl-4"><article class="card h-100 p-4"><div class="feature-icon mb-4">${icon(glyph)}</div><h3 class="h5 fw-bold">${title}</h3><p class="text-secondary mb-0">${copy}</p></article></div>`;
}

export function loginPage(options: { error?: string; turnstile?: { enabled: boolean; siteKey: string } }): string {
  const turnstile = options.turnstile;
  return `${head("Sign in", turnstile?.enabled)}<body class="bg-dark text-light"><main class="min-vh-100 d-flex align-items-center"><div class="container"><div class="row justify-content-center"><div class="col-md-7 col-lg-5 col-xl-4">
    <div class="text-center mb-4"><a href="/" class="navbar-brand text-white"><span class="brand-mark">S</span>Shortlinker</a></div>
    <div class="card border-0 shadow-lg rounded-4"><div class="card-body p-4 p-md-5"><h1 class="h3 fw-bold mb-2">Welcome back</h1><p class="text-secondary mb-4">Enter the protected control plane.</p>
      ${alert(options.error, "danger")}
      <form method="post" action="/auth/login"><div class="mb-3"><label class="form-label">Username or email</label><input class="form-control form-control-lg" type="text" name="identifier" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></div>
      <div class="mb-4"><label class="form-label">Password</label><input class="form-control form-control-lg" type="password" name="password" autocomplete="current-password" required></div>
      ${turnstile?.enabled ? `<div class="cf-turnstile mb-4" data-sitekey="${escapeHtml(turnstile.siteKey)}" data-action="login" data-theme="light"></div>` : ""}
      <button class="btn btn-primary btn-lg w-100">Continue ${icon("arrow-right")}</button></form>
    </div></div><p class="text-secondary small text-center mt-4">Access restricted by network policy and multi-factor authentication.</p>
  </div></div></div></main></body></html>`;
}

export function mfaPage(error?: string): string {
  return `${head("Two-factor authentication")}<body class="bg-dark"><main class="min-vh-100 d-flex align-items-center"><div class="container"><div class="row justify-content-center"><div class="col-md-6 col-lg-4"><div class="card border-0 rounded-4 shadow-lg"><div class="card-body p-5 text-center">
    <div class="feature-icon mx-auto mb-4">${icon("shield-lock")}</div><h1 class="h3 fw-bold">Security check</h1><p class="text-secondary">Enter your authenticator code or a recovery code.</p>${alert(error, "danger")}
    <form method="post" action="/auth/2fa"><input class="form-control form-control-lg text-center code-field my-4" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="19" required autofocus><button class="btn btn-primary btn-lg w-100">Verify</button></form>
  </div></div></div></div></div></main></body></html>`;
}

export function statusBadge(status: string): string {
  const kind = status === "active" ? "success" : status === "pending" ? "warning" : status === "suspended" ? "danger" : "info";
  return `<span class="badge badge-soft-${kind} rounded-pill">${escapeHtml(status)}</span>`;
}

export function pagination(page: number, hasNext: boolean, base: string): string {
  return `<nav class="d-flex justify-content-between mt-4"><a class="btn btn-outline-secondary ${page <= 1 ? "disabled" : ""}" href="${base}?page=${page - 1}">${icon("arrow-left")} Previous</a><span class="text-secondary align-self-center">Page ${page}</span><a class="btn btn-outline-secondary ${!hasNext ? "disabled" : ""}" href="${base}?page=${page + 1}">Next ${icon("arrow-right")}</a></nav>`;
}
