# SearchHub MCP — Handoff

## What this is

A unified OAuth-2.1-protected MCP server that aggregates 13 search/research providers
behind a single bearer-authenticated endpoint. Lives at `C:\Users\PC\find\searchhub-mcp`.

Public URL (planned): **https://meow.v244.net**

## Domain: meow.v244.net

- Current DNS: Cloudflare-proxied (104.21.46.206 / 172.67.141.202 / IPv6).
  Returns 404 today (no service attached).
- OpenShip cloudflare credential is `cred_cnUVqGgqqBiGJihs` (status `active`),
  last verified 2026-08-28 — auto-configuring DNS through it should work.
- Plan: OpenShip's `post_domains` with `hostname: "meow.v244.net"` +
  `projectId: <searchhub-project>` + DNS provider `cloudflare` +
  `autoConfigure: true`. The browser-based verification then auto-sets the
  CNAME and issues SSL via OpenShip's edge.

## What's built and verified locally

- Bun+Hono server (`src/server.ts`) on port 3000 (smoke-tested on 3137).
- OAuth 2.1 (RFC 7591 DCR, RFC 7636 PKCE S256+plain, RFC 8414 issuer metadata,
  RFC 9728 protected resource metadata, RFC 7009 revocation) — `src/oauth/handler.ts`.
- SQLite-backed store for clients, auth codes, access/refresh tokens, users — `src/store.ts`.
- Hono JSX-rendered login page (auto-form, error display).
- 13-provider registry: 8 cloud MCPs (exa, tavily, parallel, grep, deepwiki,
  context7, ydc, firecrawl) + 5 OpenShip-deployed Git MCPs (camofox, koon,
  google, openwebsearch, searxng) — `src/providers/registry.ts`.
- Parallel fan-out client with 3s/req timeout + degraded `_error` markers
  when an upstream is dead or 403s — `src/providers/client.ts`.
- 5-minute tool-list cache (steady-state `tools/list` <300ms; cold ~2s).
- Single bearer-auth gate on `/mcp` — 401 with `WWW-Authenticate` + resource
  metadata link when token is missing — `src/mcp/jsonrpc.ts`.

## Verified smoke tests (on this box)

1. `GET /healthz` → `{"ok":true,"providers":[13 ids]}`
2. `GET /.well-known/oauth-authorization-server` → RFC 8414 metadata
3. `GET /.well-known/oauth-protected-resource` → RFC 9728 metadata
4. `POST /admin/signup` → user created
5. `POST /oauth/register` (public PKCE client) → `client_id` returned
6. `POST /oauth/authorize` with username/password → 302 redirect with code
7. `POST /oauth/token` (authorization_code + PKCE verifier) → JWT access + opaque refresh
8. `POST /mcp` `initialize` with bearer → 200 JSON-RPC
9. `POST /mcp` `tools/list` with bearer → 17 tools (5 healthy + 12 degraded markers)
10. `POST /oauth/token` (refresh_token) → rotated tokens
11. `POST /mcp` without bearer → 401 with `WWW-Authenticate`

## To deploy on OpenShip (ship.v244.net)

Decision: **install SearchHub standalone as a custom app**; the 5 `find-*` Git MCPs
keep running independently and are reached via env-var URLs.

1. **Code is already on GitHub** at `github.com/kaka-sangi/searchhub-mcp`. OpenShip
   clones from this repo on deploy.

2. **Register as a custom app via `post_apps_custom`** with this skeleton:
   ```json
   {
     "id": "searchhub",
     "kind": "template",
     "name": "SearchHub MCP",
     "description": "OAuth 2.1-protected MCP aggregator for 13 search/research providers",
     "category": "automation",
     "tags": ["mcp", "search", "oauth"],
     "endpoints": [{ "service": "searchhub", "port": 3000, "kind": "http" }],
     "configFields": [
       { "key": "ISSUER",             "service": "searchhub", "type": "text", "required": true,  "label": "Public URL of this instance" },
       { "key": "JWT_SIGNING_SECRET", "service": "searchhub", "type": "text", "required": true,  "label": "HS256 signing secret (32+ chars)" },
       { "key": "DEFAULT_SCOPES",     "service": "searchhub", "type": "text", "required": false, "default": "mcp:tools" },
       { "key": "SEARCHHUB_ALLOW_SIGNUP", "service": "searchhub", "type": "text", "required": false, "default": "1" }
     ],
     "custom": true
   }
   ```

3. **Install** via `post_apps`:
   ```json
   { "templateId": "searchhub", "name": "searchhub",
     "routes": [{ "service": "searchhub", "port": 3000, "mode": "domain" }],
     "config": { "ISSUER": "https://meow.v244.net", "JWT_SIGNING_SECRET": "<32+ random chars>" } }
   ```
   Capture the new projectId from the response — that's `<searchhub-project>` below.

4. **Claim the domain** via `post_domains`:
   ```json
   { "hostname": "meow.v244.net", "projectId": "<searchhub-project>", "provider": "cloudflare", "autoConfigure": true }
   ```
   `autoConfigure: true` writes the CNAME through the `cred_cnUVqGgqqBiGJihs`
   Cloudflare credential and OpenShip issues SSL. If `autoConfigure` isn't a
   valid field on this version, fall back to `post_domains_by_id_dns_apply`
   after the domain row is created.

5. **Verify** the domain reaches the running container:
   ```bash
   curl -sS https://meow.v244.net/healthz
   ```
   Should return `{"ok":true,"providers":[13 ids]}`.

6. **Smoke-test the OAuth flow** by pointing a browser at
   `https://meow.v244.net/.well-known/oauth-authorization-server`,
   then DCR + authorize + token + MCP initialize, mirroring the local flow.

7. **Disable the `SEARCHHUB_ALLOW_SIGNUP=1` env** once your first user is
   created (`patch_projects_by_id_env` to delete it, then redeploy).

## To use SearchHub from OMP

Add to `~/.omp/agent/mcp.json`:
```json
{
  "mcpServers": {
    "searchhub": {
      "type": "http",
      "url": "https://meow.v244.net/mcp",
      "enabled": true
    }
  }
}
```

OMP will discover the metadata at `/.well-known/oauth-protected-resource`,
prompt the user to log in via the browser, store the OAuth tokens in the
vault (same `mcp_oauth:profile:default:<URL>` row pattern that already
holds `mcp.exa.ai`), and mount all 13 aggregated tools under their
`<provider>__<tool>` prefixed names.

## To override the bundled upstream URLs

`SEARCHHUB_*_URL` env vars per `.env.example`. The 5 OpenShip children should
be reachable via the internal Docker network as `http://proj_<id>:3000/mcp`,
or via `host.docker.internal:<hostPort>` (20011–20015).

## What's deliberately not done

- **JWT signing is HS256 (single secret).** Move to RS256 + JWKS rotation when
  more than one SearchHub instance runs.
- **Client secrets are stored in plaintext in `oauth_clients.client_secret_hash`.**
  Hash with `scrypt` (helper already in `store.ts`) before production.
- **Password hashing uses scrypt with N=16384.** Switch to argon2id if available.
- **No session/refresh-token binding to client metadata** beyond the access
  token's `jti`. Add DPoP or `cnf` claim when supporting refresh on mobile.
- **No rate limiting / per-user quota.** Add a token-bucket middleware in
  front of `/mcp` once you have user_id from the JWT.
- **No UI for user self-signup.** Currently `SEARCHHUB_ALLOW_SIGNUP=1` exposes
  `POST /admin/signup`. Disable once admin users are provisioned.
- **Cloud provider credentials.** `parallel` will work with a literal key
  via `PARALLEL_API_KEY` env; other cloud MCPs rely on the OMP-side auth
  (exa = OAuth, tavily = sealed token, etc.) which is **not** yet plumbed
  through to SearchHub — that needs an `exa_oauth_*` env or per-provider
  vault lookup. Add as needed.

## OpenShip-side answer summary

- **Shape:** standalone (children untouched).
- **Domain:** `meow.v244.net` (Cloudflare-proxied, auto-config via the active
  Cloudflare credential in OpenShip).
- **OAuth:** RFC 7591 DCR + 7636 PKCE + 8414 + 9728 + 7009. JWT bearer.
- **Hand-off point:** after this handoff doc — OpenShip deploy is gated on
  the code being on `github.com/kaka-sangi/searchhub-mcp` (DONE).
