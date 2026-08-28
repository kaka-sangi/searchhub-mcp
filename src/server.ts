// Server entry — Bun.serve with Hono. Mounts:
//   GET  /.well-known/oauth-authorization-server
//   GET  /.well-known/oauth-protected-resource
//   POST /oauth/register
//   GET/POST /oauth/authorize
//   POST /oauth/token
//   POST /oauth/revoke
//   POST /admin/signup        (only when SEARCHHUB_ALLOW_SIGNUP=1)
//   GET  /healthz
//   ALL  /mcp                 (JSON-RPC over HTTPSSE; bearer-auth required)
//
// ponytail: single-file router, no plugin framework. When routes >20, split.

import { Hono } from "hono";
import { serve } from "bun";
import oauth, { maybeSignupRoute } from "./oauth/handler.ts";
import { handleJsonRpc } from "./mcp/jsonrpc.ts";
import { enabledProviders } from "./providers/registry.ts";

const app = new Hono();

app.route("/", oauth);
app.route("/", maybeSignupRoute());

app.get("/healthz", (c) => c.json({ ok: true, providers: enabledProviders().map((p) => p.id) }));

app.all("/mcp", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json({ error: "invalid json" }, 400);
  return handleJsonRpc(c, body);
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`searchhub-mcp listening on :${port} — ${enabledProviders().length} providers enabled`);
