// Upstream MCP JSON-RPC client. Spawns an SSE/streamableHTTP session lazily and
// caches per-provider tool lists. ponytail: 30s in-memory cache; bump to 5min
// when traffic stabilizes.

import { enabledProviders, prefixedName, parsePrefixedName, type ProviderDef } from "./registry.ts";

type ToolInfo = { name: string; description?: string; inputSchema?: unknown };

const sessionUrl = (url: string) => url;
const TOOL_CACHE_TTL_MS = 5 * 60_000;

type CacheEntry = { tools: ToolInfo[]; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

async function fetchTools(p: ProviderDef): Promise<ToolInfo[]> {
  const hit = cache.get(p.id);
  if (hit && Date.now() - hit.fetchedAt < TOOL_CACHE_TTL_MS) return hit.tools;

  const initRes = await fetch(sessionUrl(p.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(p.authHeader ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "searchhub", version: "0.1.0" },
      },
    }),
  });
  if (!initRes.ok) throw new Error(`initialize ${p.id} -> ${initRes.status}`);
  // Drain event-stream header to get session id, then send "initialized" notification, then tools/list.
  const sessionId = initRes.headers.get("mcp-session-id");
  const sendHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(p.authHeader ?? {}),
  };
  if (sessionId) sendHeaders["Mcp-Session-Id"] = sessionId;

  await fetch(sessionUrl(p.url), {
    method: "POST",
    headers: sendHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const listRes = await fetch(sessionUrl(p.url), {
    method: "POST",
    headers: sendHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  if (!listRes.ok) throw new Error(`tools/list ${p.id} -> ${listRes.status}`);
  const listText = await listRes.text();
  // Streamable HTTP returns SSE — pull out the first JSON line.
  const line = listText.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? listText;
  const parsed = JSON.parse(line) as { result?: { tools: ToolInfo[] } };
  const tools = parsed.result?.tools ?? [];
  cache.set(p.id, { tools, fetchedAt: Date.now() });
  return tools;
}
export async function listAllTools(): Promise<Array<ToolInfo & { prefixed: string; providerId: string }>> {
  // ponytail: fan out concurrently with bounded timeout. Slow/dead upstreams
  // surface as `_error` synthetic tools instead of blocking the whole call.
  const results = await Promise.all(
    enabledProviders().map((p) =>
      Promise.race([
        fetchTools(p)
          .then((tools) => ({ p, tools, ok: true as const }))
          .catch((err: Error) => ({ p, ok: false, err })),
        new Promise<{ p: ProviderDef; ok: false; err: Error }>((resolve) =>
          setTimeout(() => resolve({ p, ok: false, err: new Error("timeout") }), 3000),
        ),
      ]),
    ),
  );
  const out: Array<ToolInfo & { prefixed: string; providerId: string }> = [];
  for (const r of results) {
    if (r.ok) {
      for (const t of r.tools) out.push({ ...t, prefixed: prefixedName(r.p, t.name), providerId: r.p.id });
    } else {
      out.push({
        prefixed: prefixedName(r.p, "_error"),
        providerId: r.p.id,
        name: "_error",
        description: `Upstream ${r.p.id} unavailable: ${r.err.message}`,
        inputSchema: { type: "object", properties: {} },
      });
    }
  }
  return out;
}

export async function callPrefixedTool(
  prefixed: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }> {
  const parsed = parsePrefixedName(prefixed);
  if (!parsed) throw new Error(`invalid prefixed tool: ${prefixed}`);
  const p = enabledProviders().find((x) => x.id === parsed.providerId);
  if (!p) throw new Error(`provider not found: ${parsed.providerId}`);

  const initRes = await fetch(sessionUrl(p.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(p.authHeader ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "searchhub", version: "0.1.0" },
      },
    }),
  });
  if (!initRes.ok) throw new Error(`initialize ${p.id} -> ${initRes.status}`);
  const sessionId = initRes.headers.get("mcp-session-id");
  const sendHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(p.authHeader ?? {}),
  };
  if (sessionId) sendHeaders["Mcp-Session-Id"] = sessionId;

  await fetch(sessionUrl(p.url), {
    method: "POST",
    headers: sendHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const callRes = await fetch(sessionUrl(p.url), {
    method: "POST",
    headers: sendHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: parsed.tool, arguments: args },
    }),
  });
  if (!callRes.ok) {
    return { content: [{ type: "text", text: `upstream ${p.id} -> ${callRes.status}` }], isError: true };
  }
  const text = await callRes.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text;
  const parsed2 = JSON.parse(line) as {
    result?: { content?: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (parsed2.error) {
    return { content: [{ type: "text", text: parsed2.error.message }], isError: true };
  }
  return {
    content: parsed2.result?.content ?? [],
    isError: parsed2.result?.isError,
  };
}
