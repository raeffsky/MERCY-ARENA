import { json } from "./http.js";

function decodePart(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodePart(value)));
}

export async function requireAccessIdentity(request, env) {
  const domain = String(env.CF_ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = String(env.CF_ACCESS_AUD || "").trim();
  if (!domain || !audience) {
    return { error: json({ error: { code: "AUTH_NOT_CONFIGURED", message: "Вход организатора ещё не настроен." } }, 503) };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { error: json({ error: { code: "AUTH_REQUIRED", message: "Требуется вход через Cloudflare Access." } }, 401) };

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed token");
    const header = decodeJson(parts[0]);
    const claims = decodeJson(parts[1]);
    if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token");
    const issuer = `https://${domain}`;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !aud.includes(audience) || !claims.exp || claims.exp <= now || (claims.nbf && claims.nbf > now)) {
      throw new Error("Invalid token claims");
    }

    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!response.ok) throw new Error("Unable to load Access signing keys");
    const jwks = await response.json();
    const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
    if (!jwk) throw new Error("Unknown signing key");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!valid) throw new Error("Invalid signature");

    const email = String(claims.email || "").trim().toLowerCase();
    if (!email || !claims.sub) throw new Error("Missing identity claims");
    return { identity: { email, subject: String(claims.sub), name: String(claims.name || email).slice(0, 120) } };
  } catch {
    return { error: json({ error: { code: "INVALID_IDENTITY", message: "Не удалось подтвердить сессию. Войдите заново." } }, 401) };
  }
}

export async function loadOrBootstrapUser(db, identity, env) {
  const bootstrapEmail = String(env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  let user = await db.prepare("SELECT id,email,display_name FROM users WHERE email = ?").bind(identity.email).first();

  if (!user && bootstrapEmail && identity.email === bootstrapEmail) {
    const id = crypto.randomUUID();
    await db.prepare("INSERT OR IGNORE INTO users (id,email,display_name) VALUES (?,?,?)").bind(id, identity.email, identity.name).run();
    user = await db.prepare("SELECT id,email,display_name FROM users WHERE email = ?").bind(identity.email).first();
    if (user) {
      await db.prepare("INSERT OR IGNORE INTO user_roles (user_id,role) VALUES (?,'administrator')").bind(user.id).run();
      await db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,'bootstrap_admin_created','user',?,?)")
        .bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ email: identity.email, role: "administrator" })).run();
    }
  }

  if (!user) return null;
  const { results } = await db.prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role").bind(user.id).all();
  return { ...user, roles: (results || []).map((row) => row.role) };
}
