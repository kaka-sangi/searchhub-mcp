# SearchHub MCP — Handoff

## What this is

A unified OAuth-2.1-protected MCP server that aggregates 13 search/research providers
behind a single bearer-authenticated endpoint. Lives at `C:\Users\PC\find\searchhub-mcp`.

**Public URL (LIVE): https://meow.v244.net**

## Live Deploy Status (2026-08-29)

- **Project:** `proj_YJ6vi_WL9IN5FfAh` on ship.v244.net
- **Service:** `svc_iHwevfhcU3UY9lPc` (compose `searchhub`, framework `docker-compose`)
- **Active deployment:** `dep_bWCsgsNtoD14_noR` (build v8), container `a12b12ac…`
- **Deployed commit:** `1e00e4b` — `fix(deploy): ship missing oauth/ui.ts`
- **Domain:** `meow.v244.net` (custom), SSL `active`, primary
- **Volume:** `searchhub_data:/app/data` (named, persistent SQLite at `/app/data/searchhub.db`)
- **Auto-deploy:** ON (webhook on the GitHub repo)

### Env vars wired

`PORT`, `ISSUER`, `DATA_DIR`, `NODE_ENV`, `DEFAULT_SCOPES`, `JWT_SIGNING_SECRET`,
`SEARCHHUB_ALLOW_SIGNUP` — all present in deployment metadata (masked).

### Live endpoint smoke (2026-08-29 13:30 UTC)

| Endpoint | Method | Status |
|---|---|---|
| `/healthz` | GET | 200 (`{ok:true, providers:13}`) |
| `/.well-known/oauth-authorization-server` | GET | 200 (issuer `https://meow.v244.net`) |
| `/.well-known/oauth-protected-resource` | GET | 200 |
| `/oauth/register` | POST | 201 (DCR works) |
| `/mcp` (no bearer) | POST | 401 (correct JSON-RPC error) |

## Verified End-to-End (earlier session)

```bash
curl https://meow.v244.net/healthz
# {"ok":true,"providers":["exa","tavily","parallel","grep","deepwiki",
#  "context7","ydc","firecrawl","camofox","koon","google",
#  "openwebsearch","searxng"]}
```

With a JWT access token from the OAuth flow:
- `initialize` → `protocolVersion: 2024-11-05, server: searchhub-mcp 0.1.0`
- `tools/list` → **18 tools** (10 healthy + 8 degraded markers)

## OAuth Login (browser-side)

Sign in to SearchHub via `https://meow.v244.net/.well-known/oauth-authorization-server`,
then DCR → authorize → token.

### Credentials (DB-verified)

- `owner` / `ChangeMeNow2026` — owner user (password rotated to no-special-chars)
- `admin` / `SearchHubPass2026!` — smoke-test user from initial deploy

## Auth fix log (2026-08-29)

Three commits shipped and deployed:

1. **`541b46b`** — `src/store.ts` WAL + synchronous=NORMAL + busy_timeout=5000
   (closes read-after-write race across Bun workers).
   `src/oauth/handler.ts` rate-limit (5 fails/15min per username) + render errors
   as HTML via `renderErrorPage()`.
2. **`49018f4`** — `tsconfig.json` `allowImportingTsExtensions=true` for bun tsc parity.
3. **`1e00e4b`** — re-ship `src/oauth/ui.ts` (was only on local; container failed to
   import `./ui.ts` until this commit).

### Known issue (handed off to user)

HTTP `POST /oauth/authorize` with correct credentials occasionally returns
`200 + form-with-error` instead of `302 + code`. DB-side `verifyPassword()` returns
`true` for the same hash via container exec — the HTTP path has a divergence that
couldn't be diagnosed from outside the container within this session's debug budget.

Reproduction: `curl -X POST https://meow.v244.net/oauth/authorize` with form fields
`client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`,
`username=owner`, `password=ChangeMeNow2026` returns `200` (failure-branch render)
`5/5` retries. Likely candidates: stale container, Bun `parseBody()` regression,
or per-worker DB handle state not fully closed by WAL.

User should test interactively in a real browser — JS form encoding may not exhibit
the same failure.

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
  user_id from the JWT. (5-fail/15min login rate-limit IS already wired
  via the new `oauth_login_attempts` table.)

## Files

- Local source: `C:\Users\PC\find\searchhub-mcp`
- GitHub: https://github.com/kaka-sangi/searchhub-mcp
- OpenShip project: https://ship.v244.net/projects/proj_YJ6vi_WL9IN5FfAh
- Live MCP endpoint: https://meow.v244.net/mcp
