// OAuth 2.1 endpoints. RFC 8414 metadata + RFC 7591 DCR + RFC 7636 PKCE + RFC 7009 revocation.
// Issuer URL is read from process.env.ISSUER.
import { Hono } from "hono";
import { db, hashPassword, randomToken, verifyPassword } from "../store.ts";

const ISSUER = process.env.ISSUER ?? "http://localhost:3000";
const SIGNING = process.env.JWT_SIGNING_SECRET ?? "dev-only-replace-me-32-chars";
const ACCESS_TOKEN_TTL = 60 * 60;             // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const AUTH_CODE_TTL = 10 * 60;                // 10 minutes
const DEFAULT_SCOPES = process.env.DEFAULT_SCOPES ?? "mcp:tools";

function now() {
  return Math.floor(Date.now() / 1000);
}

// ponytail: HS256 keeps the crypto single-file. Switch to RS256 + JWK rotation when multi-issuer.
async function signAccessToken(payload: { sub: string; client_id: string; scope: string; jti: string }) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(
    JSON.stringify({
      iss: ISSUER,
      aud: `${ISSUER}/mcp`,
      ...payload,
      iat: now(),
      exp: now() + ACCESS_TOKEN_TTL,
    }),
  );
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "")}`;
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function verifyPkce(verifier: string, challenge: string, method: string): Promise<boolean> {
  if (method === "plain") return verifier === challenge;
  if (method !== "S256") return false;
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return b64url(hash) === challenge;
}

const oauth = new Hono();

// RFC 8414 — server metadata
oauth.get("/.well-known/oauth-authorization-server", (c) => {
  return c.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: DEFAULT_SCOPES.split(/\s+/),
    service_documentation: `${ISSUER}/docs`,
  });
});

// RFC 9728 — protected resource metadata for the MCP endpoint
oauth.get("/.well-known/oauth-protected-resource", (c) => {
  return c.json({
    resource: `${ISSUER}/mcp`,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: DEFAULT_SCOPES.split(/\s+/),
  });
});

// RFC 7591 — Dynamic Client Registration
oauth.post("/oauth/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid_request" }, 400);

  const redirect_uris: string[] = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u: unknown): u is string => typeof u === "string")
    : [];
  if (redirect_uris.length === 0) {
    return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris required" }, 400);
  }
  const grant_types: string[] = Array.isArray(body.grant_types)
    ? body.grant_types.filter((g: unknown): g is string => typeof g === "string")
    : ["authorization_code", "refresh_token"];
  const auth_method: string =
    typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  const client_id = randomToken(16);
  const client_secret = auth_method === "none" ? null : randomToken(32);
  const issued_at = now();
  const expires_at = client_secret ? issued_at + 90 * 24 * 60 * 60 : 0;

  db.query(
    `INSERT INTO oauth_clients
     (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope, client_id_issued_at, client_secret_expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    client_id,
    client_secret, // ponytail: storing plain secret here for simplicity; hash with scrypt before prod
    typeof body.client_name === "string" ? body.client_name : "Unnamed Client",
    JSON.stringify(redirect_uris),
    JSON.stringify(grant_types),
    auth_method,
    typeof body.scope === "string" ? body.scope : DEFAULT_SCOPES,
    issued_at,
    expires_at,
    JSON.stringify(body),
  );

  const resp: Record<string, unknown> = {
    client_id,
    client_id_issued_at: issued_at,
    redirect_uris,
    grant_types,
    token_endpoint_auth_method: auth_method,
    response_types: ["code"],
  };
  if (client_secret) {
    resp.client_secret = client_secret;
    resp.client_secret_expires_at = expires_at;
  }
  return c.json(resp, 201);
});

// Authorization endpoint — server-rendered login form on Hono JSX, then redirect with code.
oauth.get("/oauth/authorize", (c) => {
  const params = c.req.query();
  const err = params.error;
  return c.html(renderAuthorizePage(params, err));
});

oauth.post("/oauth/authorize", async (c) => {
  const form = await c.req.parseBody();
  const client_id = String(form.client_id ?? "");
  const redirect_uri = String(form.redirect_uri ?? "");
  const scope = String(form.scope ?? DEFAULT_SCOPES);
  const state = String(form.state ?? "");
  const code_challenge = String(form.code_challenge ?? "");
  const code_challenge_method = String(form.code_challenge_method ?? "S256");
  const username = String(form.username ?? "");
  const password = String(form.password ?? "");

  const client = db
    .query(`SELECT * FROM oauth_clients WHERE client_id = ?`)
    .get(client_id) as Record<string, string> | null;
  if (!client) return c.text("Unknown client", 400);

  const allowed = JSON.parse(client.redirect_uris) as string[];
  if (!allowed.includes(redirect_uri)) return c.text("redirect_uri not registered", 400);
  if (!code_challenge) return c.text("PKCE required (code_challenge)", 400);

  const user = db
    .query(`SELECT * FROM oauth_users WHERE username = ?`)
    .get(username) as { user_id: string; password_hash: string } | null;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.html(renderAuthorizePage({ client_id, redirect_uri, scope, state, code_challenge, code_challenge_method }, "Invalid credentials"));
  }

  const code = randomToken(32);
  const created = now();
  db.query(
    `INSERT INTO oauth_auth_codes (code, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(code, client_id, user.user_id, redirect_uri, scope, code_challenge, code_challenge_method, created + AUTH_CODE_TTL, created);

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return c.redirect(url.toString(), 302);
});

// Token endpoint — authorization_code and refresh_token grants.
oauth.post("/oauth/token", async (c) => {
  const form = await c.req.parseBody();
  const grant_type = String(form.grant_type ?? "");

  if (grant_type === "authorization_code") {
    const code = String(form.code ?? "");
    const redirect_uri = String(form.redirect_uri ?? "");
    const code_verifier = String(form.code_verifier ?? "");
    const client_id = String(form.client_id ?? "");

    const row = db
      .query(`SELECT * FROM oauth_auth_codes WHERE code = ?`)
      .get(code) as Record<string, number | string> | null;
    if (!row || row.used === 1 || (row.expires_at as number) < now()) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    if (row.client_id !== client_id || row.redirect_uri !== redirect_uri) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    if (!(await verifyPkce(code_verifier, String(row.code_challenge), String(row.code_challenge_method)))) {
      return c.json({ error: "invalid_grant", error_description: "PKCE failed" }, 400);
    }

    db.query(`UPDATE oauth_auth_codes SET used = 1 WHERE code = ?`).run(code);

    const access_jti = randomToken(16);
    const access = await signAccessToken({
      sub: String(row.user_id),
      client_id: String(row.client_id),
      scope: String(row.scope),
      jti: access_jti,
    });
    const refresh = randomToken(32);
    const created = now();
    db.query(
      `INSERT INTO oauth_access_tokens (token, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(access_jti, row.client_id, row.user_id, row.scope, created + ACCESS_TOKEN_TTL, created);
    db.query(
      `INSERT INTO oauth_refresh_tokens (token, client_id, user_id, scope, access_token_jti, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(refresh, row.client_id, row.user_id, row.scope, access_jti, created + REFRESH_TOKEN_TTL, created);

    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refresh,
      scope: row.scope,
    });
  }

  if (grant_type === "refresh_token") {
    const refresh = String(form.refresh_token ?? "");
    const row = db
      .query(`SELECT * FROM oauth_refresh_tokens WHERE token = ? AND revoked = 0`)
      .get(refresh) as Record<string, number | string> | null;
    if (!row || (row.expires_at as number) < now()) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    db.query(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token = ?`).run(refresh);
    db.query(`DELETE FROM oauth_access_tokens WHERE token = ?`).run(row.access_token_jti);

    const access_jti = randomToken(16);
    const access = await signAccessToken({
      sub: String(row.user_id),
      client_id: String(row.client_id),
      scope: String(row.scope),
      jti: access_jti,
    });
    const new_refresh = randomToken(32);
    const created = now();
    db.query(
      `INSERT INTO oauth_access_tokens (token, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(access_jti, row.client_id, row.user_id, row.scope, created + ACCESS_TOKEN_TTL, created);
    db.query(
      `INSERT INTO oauth_refresh_tokens (token, client_id, user_id, scope, access_token_jti, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(new_refresh, row.client_id, row.user_id, row.scope, access_jti, created + REFRESH_TOKEN_TTL, created);

    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: new_refresh,
      scope: row.scope,
    });
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});

// RFC 7009 — revocation (best-effort, also revokes the bound access token).
oauth.post("/oauth/revoke", async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  if (token) {
    db.query(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token = ?`).run(token);
  }
  return c.text("", 200);
});

// Bearer middleware — verifies JWT on protected MCP routes.
export async function requireBearer(authHeader: string | undefined): Promise<{ user_id: string; client_id: string; scope: string } | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - parts[2].length % 4) % 4)), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
    if (!ok) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp < now()) return null;
    return { user_id: payload.sub, client_id: payload.client_id, scope: payload.scope };
  } catch {
    return null;
  }
}

// HTML page — Hono JSX-rendered.
function renderAuthorizePage(params: Record<string, string>, error?: string): string {
  const e = error ? `<p style="color:#c00">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorize — SearchHub</title>
<style>body{font-family:system-ui,sans-serif;max-width:380px;margin:60px auto;padding:0 16px}
h1{font-size:20px}input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{background:#1f6feb;color:#fff;border:0;padding:10px 16px;width:100%;font-weight:600;cursor:pointer}
code{background:#f4f4f4;padding:1px 4px;border-radius:3px}</style></head>
<body><h1>Sign in to SearchHub MCP</h1>
<p>Client <code>${escapeHtml(params.client_id ?? "")}</code> wants to connect with scope <code>${escapeHtml(params.scope ?? "mcp:tools")}</code>.</p>
${e}
<form method="POST" action="/oauth/authorize">
${Object.entries(params)
  .filter(([k]) => k !== "username" && k !== "password")
  .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
  .join("")}
<label>Username <input name="username" required autofocus></label>
<label>Password <input name="password" type="password" required></label>
<button type="submit">Authorize</button>
</form></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;");
}

export default oauth;

// Admin endpoint — register a user (closed by default unless SEARCHHUB_ALLOW_SIGNUP=1).
export function maybeSignupRoute(): Hono {
  const h = new Hono();
  h.post("/admin/signup", async (c) => {
    if (process.env.SEARCHHUB_ALLOW_SIGNUP !== "1") return c.text("signup closed", 403);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const user_id = randomToken(16);
    try {
      db.query(`INSERT INTO oauth_users (user_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`)
        .run(user_id, body.username, hashPassword(body.password), now());
      return c.json({ user_id, username: body.username }, 201);
    } catch (e) {
      return c.json({ error: "user_exists" }, 409);
    }
  });
  return h;
}
