// ─── KPI Toolkit MCP Server ───────────────────────────────────────────
// Exposes the provider-neutral data toolkit (TOOL_SPECS + executeDataTool)
// over the Model Context Protocol. This is the "ANY LLM / ANY agent" path:
// MCP is the cross-vendor standard, so once this is running, the exact
// same KPI/project tools are usable from Claude Desktop, Cursor, Continue,
// custom OpenAI/LangChain agents with an MCP client, etc. — with no
// provider-specific code.
//
// We use the low-level Server (not the Zod-based McpServer helper) so the
// neutral JSON-Schema TOOL_SPECS pass straight through unchanged — no
// schema re-declaration, one source of truth.
//
// Transport: stdio. Point an MCP client at:
//   command: "npx", args: ["tsx", "server/src/agents/tools/mcpServer.ts"]
// Requires the same env as the app (the SQLite project_cache path), since
// it reads the local cache directly — no QB credentials needed for reads.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TOOL_SPECS, executeDataTool } from './dataTools'

export function buildKpiMcpServer(): Server {
  const server = new Server(
    { name: 'kin-kpi-toolkit', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  // Advertise the neutral specs verbatim — MCP's `inputSchema` IS JSON Schema.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SPECS.map(s => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema,
    })),
  }))

  // Route every call through the shared dispatcher. A throw becomes an
  // MCP error result so the calling agent can recover.
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params
    try {
      const result = executeDataTool(name, (args ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  })

  return server
}

// Run as a stdio server when invoked directly (tsx mcpServer.ts).
async function main(): Promise<void> {
  const server = buildKpiMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdio servers must not write to stdout (it's the protocol channel);
  // log to stderr so MCP clients still get clean framing.
  console.error('[kin-kpi-toolkit] MCP server running on stdio')
}

// ESM entrypoint guard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[kin-kpi-toolkit] fatal:', err)
    process.exit(1)
  })
}
