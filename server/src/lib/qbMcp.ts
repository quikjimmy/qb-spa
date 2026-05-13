// QuickBase MCP client — lazy singleton over Streamable HTTP.
//
// The MCP server is a separate Railway service (KinHome-it/qb-mcp). It speaks
// read-only Quickbase: discovery (schemas, glossary, field lookup) + querying
// (query_records, count_records, find_records, run_report). Auth is a static
// shared secret enforced by the MCP server's BearerAuthMiddleware — set
// QB_MCP_TOKEN here, MCP_SHARED_SECRET there, same value.
//
// Why a lazy singleton: one HTTP transport is enough for the entire qb-spa
// process. listTools() result is cached for a few minutes since the tool list
// is stable; callTool round-trips each time.
//
// Failure mode: any connect/list/call error resets the cached client so the
// next call reconnects. The chat route treats `getQbTools() = []` as "no
// tools available" — chatbot still works, just without QB access.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema; passed straight through to each LLM provider
}

export interface QbMcpStatus {
  enabled: boolean
  url: string | null
  hasToken: boolean
  reason?: string
}

const URL_ENV = 'QB_MCP_URL'
const TOKEN_ENV = 'QB_MCP_TOKEN'
const TOOL_CACHE_MS = 5 * 60_000   // listTools is stable; refresh every ~5 min

let _client: Client | null = null
let _connecting: Promise<Client> | null = null
let _toolsCache: { at: number; tools: McpToolDef[] } | null = null

function readConfig(): { url: string; token: string | null } | null {
  const url = (process.env[URL_ENV] || '').trim()
  if (!url) return null
  const token = (process.env[TOKEN_ENV] || '').trim() || null
  return { url, token }
}

export function qbMcpStatus(): QbMcpStatus {
  const cfg = readConfig()
  if (!cfg) return { enabled: false, url: null, hasToken: false, reason: `${URL_ENV} not set` }
  return { enabled: true, url: cfg.url, hasToken: !!cfg.token }
}

function resetClient(): void {
  // Drop the cached client on any error so the next call reconnects from scratch.
  // Tool cache is independent of the client (just listTools data), but we clear
  // it too so a reconnect picks up any server-side tool changes.
  _client = null
  _toolsCache = null
}

async function connect(): Promise<Client> {
  if (_client) return _client
  if (_connecting) return _connecting
  _connecting = (async () => {
    const cfg = readConfig()
    if (!cfg) throw new Error(`${URL_ENV} is not set`)
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      // requestInit is applied to every outbound POST/GET — that's how the
      // Authorization header reaches the MCP server's BearerAuthMiddleware
      // on each request, not just the handshake.
      requestInit: cfg.token
        ? { headers: { Authorization: `Bearer ${cfg.token}` } }
        : undefined,
    })
    const client = new Client({ name: 'qb-spa-chatbot', version: '1.0.0' })
    await client.connect(transport)
    _client = client
    return client
  })()
  try {
    return await _connecting
  } catch (e) {
    resetClient()
    throw e
  } finally {
    _connecting = null
  }
}

// Returns the MCP server's tool list, or [] if MCP isn't configured / the
// server is unreachable. Never throws — chatbot must still work without QB.
export async function getQbTools(): Promise<McpToolDef[]> {
  if (!readConfig()) return []
  if (_toolsCache && Date.now() - _toolsCache.at < TOOL_CACHE_MS) return _toolsCache.tools
  try {
    const client = await connect()
    const r = await client.listTools()
    const tools: McpToolDef[] = (r.tools || []).map(t => ({
      name: String(t.name),
      description: String(t.description || ''),
      inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
    }))
    _toolsCache = { at: Date.now(), tools }
    return tools
  } catch (e) {
    console.warn('[qb-mcp] listTools failed:', e instanceof Error ? e.message : e)
    resetClient()
    return []
  }
}

// Execute a tool by name. The MCP server returns content blocks; we flatten
// to a single string because that's what every LLM tool-result slot expects.
// Errors surface to the caller so the LLM gets a real error message (not a
// silent empty string that it might interpret as "no data").
export async function callQbTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await connect()
  try {
    const r = await client.callTool({ name, arguments: args })
    const content = (r as { content?: Array<{ type: string; text?: string }> }).content || []
    const flat = content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text!)
      .join('\n')
    return flat || JSON.stringify(content)
  } catch (e) {
    resetClient()
    throw e
  }
}
