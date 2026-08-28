// Provider registry — each upstream search MCP exposes a list of tools
// and a forwarder that proxies JSON-RPC `tools/call` invocations.
//
// ponytail: 13 providers inlined as one registry (small enough). When >20,
// move to disk-loaded config.

export type ProviderDef = {
  id: string;                 // tool prefix, e.g. "exa", "tavily"
  displayName: string;
  url: string;
  authHeader?: Record<string, string>;  // optional literal auth for upstream
  enabled: boolean;
  // tool names from upstream; if undefined, discovered at startup via tools/list
  knownTools?: string[];
};

export const providers: ProviderDef[] = [
  // Cloud MCPs (already-mounted OMP providers, re-exposed under SearchHub namespace)
  {
    id: "exa",
    displayName: "Exa Search",
    url: process.env.EXA_MCP_URL ?? "https://mcp.exa.ai/mcp",
    enabled: true,
    knownTools: ["web_search_exa", "web_fetch_exa", "web_search_advanced_exa"],
  },
  {
    id: "tavily",
    displayName: "Tavily",
    url: process.env.TAVILY_MCP_URL ?? "https://mcp.tavily.com/mcp",
    enabled: true,
    knownTools: ["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map", "tavily_research"],
  },
  {
    id: "parallel",
    displayName: "Parallel",
    url: process.env.PARALLEL_MCP_URL ?? "https://search.parallel.ai/mcp",
    authHeader: process.env.PARALLEL_API_KEY
      ? { Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
      : undefined,
    enabled: true,
    knownTools: ["search"],
  },
  {
    id: "grep",
    displayName: "grep.app",
    url: process.env.GREP_MCP_URL ?? "https://mcp.grep.app",
    enabled: true,
    knownTools: ["searchGitHub"],
  },
  {
    id: "deepwiki",
    displayName: "DeepWiki",
    url: process.env.DEEPWIKI_MCP_URL ?? "https://mcp.deepwiki.com/mcp",
    enabled: true,
    knownTools: ["ask_question", "read_wiki_structure", "read_wiki_contents"],
  },
  {
    id: "context7",
    displayName: "Context7",
    url: process.env.CONTEXT7_MCP_URL ?? "https://mcp.context7.com/mcp",
    enabled: true,
    knownTools: ["resolve-library-id", "query-docs"],
  },
  {
    id: "ydc",
    displayName: "You.com",
    url: process.env.YDC_MCP_URL ?? "https://api.you.com/mcp",
    enabled: true,
    knownTools: ["you_search", "you_contents", "you_answer", "you_research"],
  },
  {
    id: "firecrawl",
    displayName: "Firecrawl",
    url: process.env.FIRECRAWL_MCP_URL ?? "https://firecrawl.v244.net",
    enabled: true,
    knownTools: ["firecrawl_scrape", "firecrawl_extract", "firecrawl_crawl"],
  },

  // OpenShip-deployed MCPs (internal cluster URLs)
  {
    id: "camofox",
    displayName: "CamoFox",
    url: process.env.SEARCHHUB_CAMOFOX_URL ?? "http://proj_ccNap5-XxfLibBYS:3000/mcp",
    enabled: true,
  },
  {
    id: "koon",
    displayName: "Koon",
    url: process.env.SEARCHHUB_KOON_URL ?? "http://proj_BL5syaO37oLnQMNc:3000/mcp",
    enabled: true,
  },
  {
    id: "google",
    displayName: "Google Search",
    url: process.env.SEARCHHUB_GOOGLE_URL ?? "http://proj_nwfYZuTe9BLTxXPS:3000/mcp",
    enabled: true,
  },
  {
    id: "openwebsearch",
    displayName: "Open WebSearch",
    url: process.env.SEARCHHUB_OPENWEBSEARCH_URL ?? "http://proj_7j5h6hczHXChX0Ah:3000/mcp",
    enabled: true,
  },
  {
    id: "searxng",
    displayName: "SearXNG",
    url: process.env.SEARCHHUB_SEARXNG_URL ?? "http://proj_ZOIiOvuAFIVs7elG:3000/mcp",
    enabled: true,
  },
];

export const enabledProviders = (): ProviderDef[] => providers.filter((p) => p.enabled);

// Tool name mangling: `<provider>__<tool>` to avoid collisions across providers.
export function prefixedName(p: ProviderDef, tool: string): string {
  return `${p.id}__${tool}`;
}

export function parsePrefixedName(name: string): { providerId: string; tool: string } | null {
  const idx = name.indexOf("__");
  if (idx < 1) return null;
  return { providerId: name.slice(0, idx), tool: name.slice(idx + 2) };
}
