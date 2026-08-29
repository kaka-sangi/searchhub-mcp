// OAuth 2.1 endpoints. RFC 8414 metadata + RFC 7591 DCR + RFC 7636 PKCE + RFC 7009 revocation.
import { Hono } from "hono";
import { db, hashPassword, randomToken, verifyPassword, checkRateLimit, recordLoginAttempt } from "../store.ts";
import { renderAuthorizePage as renderAuthorizePageUI, renderSignupPage, renderErrorPage, renderSuccessPage, type AuthorizeContext } from "./ui.ts";

const ISSUER = process.env.ISSUER ?? "http://localhost:3000";
const SIGNING = process.env.JWT_SIGNING_SECRET ?? "dev-only-replace-me-32-chars";
const ACCESS_TOKEN_TTL = 60 * 60;
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL = 10 * 60;
const DEFAULT_SCOPES = process.env.DEFAULT_SCOPES ?? "mcp:tools";

function now() { return Math.floor(Date.now() / 1000); }

async function signAccessToken(payload: { sub: string; client_id: string; scope: string; jti: string }) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify({ iss: ISSUER, aud: `${ISSUER}/mcp`, ...payload, iat: now(), exp: now() + ACCESS_TOKEN_TTL }));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "")}`;
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifyPkce(verifier: string, challenge: string, method: string): Promise<boolean> {
  if (method === "plain") return verifier === challenge;
  if (method !== "S256") return false;
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return b64url(hash) === challenge;
}

const oauth = new Hono();

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

oauth.get("/.well-known/oauth-protected-resource", (c) => {
  return c.json({
    resource: `${ISSUER}/mcp`,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: DEFAULT_SCOPES.split(/\s+/),
  });
});

oauth.post("/oauth/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid_request" }, 400);
  const redirect_uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u: unknown): u is string => typeof u === "string") : [];
  if (redirect_uris.length === 0) return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris required" }, 400);
  const grant_types: string[] = Array.isArray(body.grant_types) ? body.grant_types.filter((g: unknown): g is string => typeof g === "string") : ["authorization_code", "refresh_token"];
  const auth_method: string = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  const client_id = randomToken(16);
  const client_secret = auth_method === "none" ? null : randomToken(32);
  const issued_at = now();
  const expires_at = client_secret ? issued_at + 90 * 24 * 60 * 60 : 0;
  db.query(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope, client_id_issued_at, client_secret_expires_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    client_id,
    client_secret,
    typeof body.client_name === "string" ? body.client_name : "Unnamed Client",
    JSON.stringify(redirect_uris),
    JSON.stringify(grant_types),
    auth_method,
    typeof body.scope === "string" ? body.scope : DEFAULT_SCOPES,
    issued_at,
    expires_at,
    JSON.stringify(body),
  );
  const resp: Record<string, unknown> = { client_id, client_id_issued_at: issued_at, redirect_uris, grant_types, token_endpoint_auth_method: auth_method, response_types: ["code"] };
  if (client_secret) { resp.client_secret = client_secret; resp.client_secret_expires_at = expires_at; }
  return c.json(resp, 201);
});

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

  const ctx: AuthorizeContext = {
    client_id, redirect_uri, scope,
    state: state || undefined,
    code_challenge: code_challenge || undefined,
    code_challenge_method: code_challenge_method || undefined,
  };

  if (username) {
    const rl = checkRateLimit(username);
    if (!rl.ok) {
      return c.html(renderAuthorizePageUI(
        ctx,
        `Too many failed attempts. Try again in ${Math.ceil((rl.retryAfter ?? 0) / 60)} minutes.`,
        username,
        process.env.SEARCHHUB_ALLOW_SIGNUP === "1",
      ));
    }
  }

  const client = db.query(`SELECT * FROM oauth_clients WHERE client_id = ?`).get(client_id) as Record<string, string> | null;
  if (!client) return c.html(renderErrorPage("invalid", "Unknown client. The OAuth client_id is not registered."));

  const allowed = JSON.parse(client.redirect_uris) as string[];
  if (!allowed.includes(redirect_uri)) return c.html(renderErrorPage("invalid", "redirect_uri is not registered for this client."));
  if (!code_challenge) return c.html(renderErrorPage("invalid", "PKCE required: code_challenge parameter is missing."));

  const user = db.query(`SELECT * FROM oauth_users WHERE username = ?`).get(username) as { user_id: string; password_hash: string } | null;
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginAttempt(username, false);
    return c.html(renderAuthorizePageUI(
      ctx,
      "Invalid username or password. Please check your credentials and try again.",
      username,
      process.env.SEARCHHUB_ALLOW_SIGNUP === "1",
    ));
  }
  recordLoginAttempt(username, true);

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

oauth.post("/oauth/token", async (c) => {
  const form = await c.req.parseBody();
  const grant_type = String(form.grant_type ?? "");
  if (grant_type === "authorization_code") {
    const code = String(form.code ?? "");
    const redirect_uri = String(form.redirect_uri ?? "");
    const code_verifier = String(form.code_verifier ?? "");
    const client_id = String(form.client_id ?? "");
    const row = db.query(`SELECT * FROM oauth_auth_codes WHERE code = ?`).get(code) as Record<string, number | string> | null;
    if (!row || row.used === 1 || (row.expires_at as number) < now()) return c.json({ error: "invalid_grant" }, 400);
    if (row.client_id !== client_id || row.redirect_uri !== redirect_uri) return c.json({ error: "invalid_grant" }, 400);
    if (!(await verifyPkce(code_verifier, String(row.code_challenge), String(row.code_challenge_method)))) {
      return c.json({ error: "invalid_grant", error_description: "PKCE failed" }, 400);
    }
    db.query(`UPDATE oauth_auth_codes SET used = 1 WHERE code = ?`).run(code);
    const access_jti = randomToken(16);
    const access = await signAccessToken({ sub: String(row.user_id), client_id: String(row.client_id), scope: String(row.scope), jti: access_jti });
    const refresh = randomToken(32);
    const created = now();
    db.query(`INSERT INTO oauth_access_tokens (token, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(access_jti, row.client_id, row.user_id, row.scope, created + ACCESS_TOKEN_TTL, created);
    db.query(`INSERT INTO oauth_refresh_tokens (token, client_id, user_id, scope, access_token_jti, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(refresh, row.client_id, row.user_id, row.scope, access_jti, created + REFRESH_TOKEN_TTL, created);
    return c.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token: refresh, scope: row.scope });
  }
  if (grant_type === "refresh_token") {
    const refresh = String(form.refresh_token ?? "");
    const row = db.query(`SELECT * FROM oauth_refresh_tokens WHERE token = ? AND revoked = 0`).get(refresh) as Record<string, number | string> | null;
    if (!row || (row.expires_at as number) < now()) return c.json({ error: "invalid_grant" }, 400);
    db.query(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token = ?`).run(refresh);
    db.query(`DELETE FROM oauth_access_tokens WHERE token = ?`).run(row.access_token_jti);
    const access_jti = randomToken(16);
    const access = await signAccessToken({ sub: String(row.user_id), client_id: String(row.client_id), scope: String(row.scope), jti: access_jti });
    const new_refresh = randomToken(32);
    const created = now();
    db.query(`INSERT INTO oauth_access_tokens (token, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(access_jti, row.client_id, row.user_id, row.scope, created + ACCESS_TOKEN_TTL, created);
    db.query(`INSERT INTO oauth_refresh_tokens (token, client_id, user_id, scope, access_token_jti, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(new_refresh, row.client_id, row.user_id, row.scope, access_jti, created + REFRESH_TOKEN_TTL, created);
    return c.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token: new_refresh, scope: row.scope });
  }
  return c.json({ error: "unsupported_grant_type" }, 400);
});

oauth.post("/oauth/revoke", async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  if (token) db.query(`UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token = ?`).run(token);
  return c.text("", 200);
});

export async function requireBearer(authHeader: string | undefined): Promise<{ user_id: string; client_id: string; scope: string } | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - parts[2].length % 4) % 4)), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
    if (!ok) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp < now()) return null;
    return { user_id: payload.sub, client_id: payload.client_id, scope: payload.scope };
  } catch { return null; }
}

function toCtx(params: Record<string, string>): AuthorizeContext {
  return { client_id: params.client_id ?? "", redirect_uri: params.redirect_uri ?? "", scope: params.scope ?? "mcp:tools", state: params.state || undefined, code_challenge: params.code_challenge || undefined, code_challenge_method: params.code_challenge_method || undefined, client_name: params.client_name };
}
function renderAuthorizePage(params: Record<string, string>, error?: string): string {
  return renderAuthorizePageUI(toCtx(params), error, params.username, process.env.SEARCHHUB_ALLOW_SIGNUP === "1");
}

export default oauth;

oauth.get("/", (c) => {
  const params = c.req.query();
  if (params.client_id) return c.html(renderAuthorizePageUI(toCtx(params), params.error));
  return c.html(renderAuthorizePageUI({ client_id: "", redirect_uri: "", scope: "mcp:tools" }));
});

oauth.get("/signin", (c) => {
  const params = c.req.query();
  return c.html(renderAuthorizePageUI(toCtx(params), params.error, undefined, process.env.SEARCHHUB_ALLOW_SIGNUP === "1"));
});

oauth.get("/error", (c) => {
  const params = c.req.query();
  const variant = (params.variant as "denied" | "invalid" | "expired" | "generic") || "generic";
  return c.html(renderErrorPage(variant, params.description));
});

oauth.get("/denied", (c) => {
  return c.html(renderErrorPage("denied", c.req.query().description));
});

export function maybeSignupRoute(): Hono {
  const h = new Hono();
  const signupEnabled = () => process.env.SEARCHHUB_ALLOW_SIGNUP === "1";
  h.get("/admin/signup", (c) => {
    const params = c.req.query();
    return c.html(renderSignupPage(params.error, signupEnabled()));
  });
  h.post("/admin/signup", async (c) => {
    if (!signupEnabled()) return c.text("signup closed", 403);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.username !== "string" || typeof body.password !== "string") return c.json({ error: "invalid_request" }, 400);
    const user_id = randomToken(16);
    try {
      db.query(`INSERT INTO oauth_users (user_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`).run(user_id, body.username, hashPassword(body.password), now());
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/json")) return c.json({ user_id, username: body.username }, 201);
      return c.html(renderSuccessPage(body.username));
    } catch (e) {
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/json")) return c.json({ error: "user_exists" }, 409);
      const u = new URL(c.req.url);
      u.searchParams.set("error", "Username already exists or password too weak.");
      return c.redirect(u.pathname + "?" + u.searchParams.toString(), 303);
    }
  });
  return h;
}
