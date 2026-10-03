import type { FastifyPluginAsync } from "fastify";
import { authenticator } from "otplib";
import { db, redis } from "../db.js";
import { audit } from "../audit.js";
import { createSession, destroySession, isAdminIp, loadSession, turnstilePublicSettings, verifyCsrf, verifyTurnstile } from "../auth.js";
import { decrypt, hashPassword, hmacIp, randomToken, sha256, verifyPassword } from "../crypto.js";
import { loginPage, mfaPage } from "../ui.js";
import { config } from "../config.js";

async function loginRateLimited(ip: string, identifier: string): Promise<boolean> {
  try {
    if (redis.status === "wait") await redis.connect();
    const key = `shortlinker:login:${sha256(`${ip}|${identifier}`)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 900);
    return count > 8;
  } catch { return false; }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get("/auth/login", async (request, reply) => {
    if (!isAdminIp(request)) return reply.code(403).type("text/plain").send("Administration is not available from this network.");
    if (await loadSession(request)) return reply.redirect("/admin", 303);
    return reply.type("text/html").send(loginPage({ turnstile: await turnstilePublicSettings() }));
  });

  app.post("/auth/login", async (request, reply) => {
    if (!isAdminIp(request)) return reply.code(403).type("text/plain").send("Administration is not available from this network.");
    const body = request.body as Record<string, string>;
    const identifier = String(body.identifier ?? "").trim().toLowerCase().slice(0, 320);
    const password = String(body.password ?? "");
    const genericError = "Invalid credentials or security challenge.";
    if (await loginRateLimited(request.ip, identifier)) {
      await audit(request, "auth.login.rate_limited", { outcome: "failure", metadata: { identifierHash: sha256(identifier) } });
      return reply.code(429).type("text/html").send(loginPage({ error: "Too many attempts. Try again later.", turnstile: await turnstilePublicSettings() }));
    }
    const turnstileOk = await verifyTurnstile(request, body["cf-turnstile-response"]);
    const result = await db.query<{ id: string; password_hash: string; totp_enabled: boolean; status: string }>(
      "SELECT id, password_hash, totp_enabled, status FROM users WHERE username = $1 OR email = $1", [identifier]
    );
    const user = result.rows[0];
    const passwordOk = user ? await verifyPassword(user.password_hash, password) : await verifyPassword(await hashPassword(randomToken()), password);
    if (!turnstileOk || !user || !passwordOk || user.status !== "active") {
      await audit(request, "auth.login.failed", { actorUserId: user?.id, outcome: "failure", metadata: { identifierHash: sha256(identifier), turnstileOk } });
      return reply.code(401).type("text/html").send(loginPage({ error: genericError, turnstile: await turnstilePublicSettings() }));
    }

    const passkeys = await db.query("SELECT 1 FROM webauthn_credentials WHERE user_id = $1 LIMIT 1", [user.id]);
    if (user.totp_enabled || passkeys.rowCount) {
      const token = randomToken(32);
      await db.query(
        "INSERT INTO login_challenges (token_hash, user_id, ip_hash, expires_at) VALUES ($1,$2,$3,now()+interval '5 minutes')",
        [sha256(token), user.id, hmacIp(request.ip)]
      );
      reply.setCookie("shurl_challenge", token, { path: "/auth", httpOnly: true, secure: config.isProduction, sameSite: "strict", maxAge: 300 });
      return reply.redirect("/auth/2fa", 303);
    }

    await createSession(request, reply, user.id, false);
    await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    await audit(request, "auth.login.password", { actorUserId: user.id });
    return reply.redirect("/admin/security", 303);
  });

  app.get("/auth/2fa", async (request, reply) => {
    if (!isAdminIp(request)) return reply.code(403).send();
    if (!request.cookies.shurl_challenge) return reply.redirect("/auth/login", 303);
    return reply.type("text/html").send(mfaPage());
  });

  app.post("/auth/2fa", async (request, reply) => {
    if (!isAdminIp(request)) return reply.code(403).send();
    const challengeToken = request.cookies.shurl_challenge;
    if (!challengeToken) return reply.redirect("/auth/login", 303);
    const challenge = await db.query<{ user_id: string; totp_secret_encrypted: string | null }>(
      `SELECT c.user_id, u.totp_secret_encrypted FROM login_challenges c JOIN users u ON u.id=c.user_id
       WHERE c.token_hash=$1 AND c.expires_at>now() AND c.ip_hash=$2`, [sha256(challengeToken), hmacIp(request.ip)]
    );
    const row = challenge.rows[0];
    const code = String((request.body as Record<string, string>).code ?? "").replace(/[\s-]/g, "");
    let valid = false;
    if (row?.totp_secret_encrypted && /^\d{6}$/.test(code)) {
      valid = authenticator.verify({ token: code, secret: decrypt(row.totp_secret_encrypted) });
    }
    if (row && !valid && /^[A-Z0-9]{12}$/.test(code.toUpperCase())) {
      const codes = await db.query<{ id: string; code_hash: string }>("SELECT id, code_hash FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL", [row.user_id]);
      for (const recovery of codes.rows) {
        if (await verifyPassword(recovery.code_hash, code.toUpperCase())) {
          await db.query("UPDATE recovery_codes SET used_at=now() WHERE id=$1", [recovery.id]);
          valid = true;
          break;
        }
      }
    }
    if (!row || !valid) {
      await audit(request, "auth.mfa.failed", { actorUserId: row?.user_id, outcome: "failure" });
      return reply.code(401).type("text/html").send(mfaPage("Invalid or expired code."));
    }
    await db.query("DELETE FROM login_challenges WHERE token_hash=$1", [sha256(challengeToken)]);
    reply.clearCookie("shurl_challenge", { path: "/auth" });
    await createSession(request, reply, row.user_id, true);
    await db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [row.user_id]);
    await audit(request, "auth.login.mfa", { actorUserId: row.user_id });
    return reply.redirect("/admin", 303);
  });

  app.post("/auth/logout", async (request, reply) => {
    const session = await loadSession(request);
    if (session && verifyCsrf(request, session)) {
      await destroySession(request, reply);
      await audit(request, "auth.logout", { actorUserId: session.userId });
    }
    return reply.redirect("/auth/login", 303);
  });
};
