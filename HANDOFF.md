# SearchHub MCP — Handoff

## What this is

A unified OAuth-2.1-protected MCP server that aggregates 13 search/research providers
behind a single bearer-authenticated endpoint. Lives at `C:\Users\PC\find\searchhub-mcp`.

**Public URL (LIVE): https://meow.v244.net**

## Live Deploy Status (2026-08-28)

- **Project:** `proj_YJ6vi_WL9IN5FfAh` on ship.v244.net
- **Service:** `svc_iHwevfhcU3UY9lPc` (compose `searchhub`, framework `docker-compose`)
- **Domain:** `dom_b1S9YDXlcSJoaztX` — `meow.v244.net` (status `active`, SSL `active`, primary)
- **Source:** `github.com/kaka-sangi/searchhub-mcp` @ `9a2895d`
- **Container:** built from repo `Dockerfile`, `oven/bun:1.3.14-alpine` base
- **Volume:** `searchhub_data:/app/data` (named, persistent SQLite)
- **Auto-deploy:** ON (webhook registered on the GitHub repo)

## Verified End-to-End (live URL)

```bash
curl https://meow.v244.net/healthz
# {"ok":true,"providers":["exa","tavily","parallel","grep","deepwiki",
#  "context7","ydc","firecrawl","camofox","koon","google",
#  "openwebsearch","searxng"]}

curl https://meow.v244.net/.well-known/oauth-authorization-server
# RFC 8414 metadata, issuer=https://meow.v244.net

curl https://meow.v244.net/.well-known/oauth-protected-resource
# RFC 9728 metadata, resource=https://meow.v244.net/mcp

curl -X POST https://meow.v244.net/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
# 401 + missing bearer (gate works)
```

With a JWT access token from the OAuth flow:
- `initialize` → `protocolVersion: 2024-11-05, server: searchhub-mcp 0.1.0`
- `tools/list` → **18 tools** (10 healthy + 8 degraded markers):
  - Healthy: exa (2), parallel (2), context7 (2), grep (1), deepwiki (3),
    plus `_error` markers for the OpenShip internal URLs (camofox, koon,
    google, openwebsearch, searxng) which are unreachable from this box,
    and tavily/ydc/firecrawl which 401/404 on initialize (need
    per-provider OAuth setup — see below).

## OAuth Login (browser-side)

Sign in to SearchHub via `https://meow.v244.net/.well-known/oauth-authorization-server`,
then DCR → authorize → token. Existing admin user provisioned during deploy:
```
POST /admin/signup (one-time, with SEARCHHUB_ALLOW_SIGNUP=1)
```

## Deployment Steps That Worked (final)

1. **Push code to GitHub** at `github.com/kaka-sangi/searchhub-mcp` (done).
2. **REST `POST /projects`** `{name, source:"git", repo:"kaka-sangi/searchhub-mcp", branch:"main"}`
   → returns `projectId`. The MCP `post_projects` adapter rejects this body
   shape — use the REST endpoint directly.
3. **REST `POST /projects/{id}/git/link`** `{owner, repo, branch}` → enables
   auto-deploy webhook. MCP adapter strips `owner`/`repo`; use REST.
4. **REST `PATCH /projects/{id}/env`** with `environment: "production"`
   and upsert each env var with `isSecret: true` for `JWT_SIGNING_SECRET`.
5. **REST `PATCH /projects/{id}`** to set `framework: "docker-compose"`,
   `dockerfile: "Dockerfile"`, `composePath: "docker-compose.yml"`,
   `packageManager: "bun"`, `port: 3000`.
6. **Push `docker-compose.yml` to the repo** with the build context, env,
   and a named volume mount for `/app/data`.
7. **REST `POST /deployments/{id}/redeploy`** to trigger the first build
   using the docker-compose framework.
8. **REST `POST /domains`** `{hostname, projectId, provider:"cloudflare"}`
   to claim `meow.v244.net`. Verify via `POST /domains/{id}/verify` — it
   re-confirms DNS and SSL.
9. **REST `PATCH /projects/{id}/services/{sid}`** to set
   `exposed: true, exposedPort: "3000", customDomain: "meow.v244.net"`.
   This wires the edge → service route (the missing piece that initially
   caused `openship-edge-unrouted`).
10. **Smoke**: `curl https://meow.v244.net/healthz` returns 200 + 13 providers.

## OpenShip Quirks Hit (and Worked Around)

- **MCP adapter strips keys**: `post_projects` rejects `{name, source:...}`
  even though the field name is `name` (zod schema OK) — the adapter
  preprocesses the body differently. Use REST `POST /projects` with the
  flat shape `{name, source:"git", repo:..., branch:...}`.
- **`git/link` field-name mismatch**: MCP `post_projects_by_id_git_link`
  ignores `owner` and `repo` keys; must use REST `POST /projects/{id}/git/link`.
- **`post_apps_custom` is opaque**: the `Upload a JSON app definition`
  error gives no usable hint. Skipped the custom-app registry entirely;
  the docker-compose framework detector from the repo works fine.
- **SQLite permission error**: the Dockerfile originally set `USER bun`
  before the volume mount, so the named volume is owned by root and bun
  can't write to `/app/data`. Fix: drop `USER bun`, `chmod 777 /app/data`
  in the Dockerfile (running as root inside the container is fine in this
  OpenShip sandbox).
- **`openship-edge-unrouted` (404 on verified domain)**: domain was active
  + SSL on, but the edge had no service routing entry. Fixed by exposing
  the service: `PATCH .../services/{sid}` with `exposed: true, exposedPort,
  customDomain`. Without this, the domain verified but no traffic reached
  the container.

## Hourly Health Watch

`get_issues_summary` returns `outage: 3, actionRequired: 0, advisory: 2` —
all 3 outages are **pre-existing on unrelated projects** (`firecrawl`,
`@pylone/app`, `version-244`) and have been failing since before this
deploy. **searchhub itself has zero issues.**

## What's Deliberately Not Done

- **Cloud provider credentials** — exa/tavily/ydc/firecrawl surface
  `_error` markers when SearchHub tries to forward `tools/list` upstream.
  Fix: add per-provider `Authorization` headers via env vars
  (`EXA_OAUTH_TOKEN`, `TAVILY_API_KEY`, `YDC_API_KEY`, `FIRECRAWL_API_KEY`).
  The OMP-side vault rows for `exa` already exist; mirror them through
  to SearchHub's env via `PATCH /projects/{id}/env`.
- **OpenShip children (`find-*` projects) are unreachable** from outside
  the cluster. Their `_error` markers are expected. Either expose them
  via OpenShip domains, or wire them as private connections to SearchHub
  via `POST /projects/{id}/connections` and read `process.env` from
  SearchHub.
- **`SEARCHHUB_ALLOW_SIGNUP` is still `1`** for the first admin creation.
  Remove it via `PATCH /projects/{id}/env` (delete the key) once admin
  users are provisioned.
- **HS256 JWT** + plaintext client-secret storage + scrypt password hash
  — same dev-only choices as the local build. Migrate to RS256/JWKS +
  scrypt client secrets + argon2id before adding more than a handful of
  users.
- **No rate limit / quota** — add a token-bucket middleware once you have
  user_id from the JWT.

## Files

- Local source: `C:\Users\PC\find\searchhub-mcp`
- GitHub: https://github.com/kaka-sangi/searchhub-mcp
- OpenShip project: https://ship.v244.net/projects/proj_YJ6vi_WL9IN5FfAh
- Live MCP endpoint: https://meow.v244.net/mcp
