// MCP JSON-RPC handler. Implements `initialize`, `tools/list`, `tools/call`
// at the local `/mcp` endpoint with OAuth bearer auth. Upstreams the rest.

import type { Context } from "hono";
import { listAllTools, callPrefixedTool } from "../providers/client.ts";

const SERVER_INFO = {
  name: "searchhub-mcp",
  version: "0.1.0",
  title: "SearchHub MCP",
  websiteUrl: "https://github.com/can1357/oh-my-pi",
};

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  resources: { listChanged: true },
  prompts: { listChanged: true },
};

type RpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type RpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: unknown } };

const JSON_RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
};

function err(id: string | number | null, code: number, message: string, data?: unknown): RpcResponse {
  if (data === undefined) return { jsonrpc: "2.0", id, error: { code, message } };
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export async function handleJsonRpc(c: Context, body: RpcRequest | RpcRequest[]): Promise<Response> {
  const requests = Array.isArray(body) ? body : [body];
  const auth = c.req.header("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(err(requests[0]?.id ?? null, JSON_RPC_ERROR.UNAUTHORIZED, "missing bearer"), 401, {
      "WWW-Authenticate": 'Bearer realm="mcp", resource_metadata="/.well-known/oauth-protected-resource"',
    });
  }

  const responses: RpcResponse[] = [];
  for (const req of requests) {
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      responses.push(err(req.id ?? null, JSON_RPC_ERROR.INVALID_REQUEST, "invalid jsonrpc"));
      continue;
    }
    const id = req.id ?? null;
    if (req.method === "initialize") {
      responses.push({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      });
      continue;
    }
    if (req.method === "notifications/initialized") {
      continue; // ack-only
    }
    if (req.method === "ping") {
      responses.push({ jsonrpc: "2.0", id, result: {} });
      continue;
    }
    if (req.method === "tools/list") {
      const tools = await listAllTools();
      responses.push({
        jsonrpc: "2.0",
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.prefixed,
            description: t.description ?? `Upstream ${t.providerId}`,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
        },
      });
      continue;
    }
    if (req.method === "tools/call") {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await callPrefixedTool(name, args);
        responses.push({ jsonrpc: "2.0", id, result: out });
      } catch (e) {
        responses.push(err(id, JSON_RPC_ERROR.INTERNAL, (e as Error).message));
      }
      continue;
    }
    if (req.method === "resources/list") {
      responses.push({ jsonrpc: "2.0", id, result: { resources: [] } });
      continue;
    }
    if (req.method === "prompts/list") {
      responses.push({ jsonrpc: "2.0", id, result: { prompts: [] } });
      continue;
    }
    responses.push(err(id, JSON_RPC_ERROR.METHOD_NOT_FOUND, `method not found: ${req.method}`));
  }

  const out = Array.isArray(body) ? responses : responses[0];
  return c.json(out);
}
