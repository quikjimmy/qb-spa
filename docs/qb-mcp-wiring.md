# QuickBase MCP wiring

How clients (the qb-spa chatbot, the VPS OpenClaw agents, and anything else
internal) talk to our QuickBase MCP server.

- MCP server repo: [`KinHome-it/qb-mcp`](https://github.com/KinHome-it/qb-mcp)
- Railway service name: **`QB_MCP`** (Railway lowercases the DNS label to `qb-mcp`)
- Auth: static bearer token. The MCP server's `BearerAuthMiddleware` 401s any
  request missing `Authorization: Bearer <secret>`.

## The two URLs

| Caller | URL | Why |
|---|---|---|
| qb-spa (Railway) | `http://qb-mcp.railway.internal:8080/mcp` | Same Railway project. Private-network only — never traverses the public internet, no egress fees, no DNS lookups. |
| OpenClaw on the VPS | `https://<qb-mcp-public-host>/mcp` | VPS is outside Railway, so it must use the public hostname. The bearer token is the only gate; defense in depth would also be Cloudflare Access or an IP allowlist. |
| Local laptop dev | `http://localhost:8080/mcp` *or* the public URL | Whatever's running. The internal `*.railway.internal` hostname only resolves inside Railway. |

The MCP server enforces the bearer on **every** request regardless of which
URL hit it — so even the internal-network calls send the header. Defense in
depth: network path *and* app-layer check.

## qb-spa chatbot wiring (already done)

Two env vars on the qb-spa Railway service:

```bash
QB_MCP_URL=http://qb-mcp.railway.internal:8080/mcp
QB_MCP_TOKEN=<same value as MCP_SHARED_SECRET on the qb-mcp service>
```

When both are set, every chatbot thread (`/api/chat/threads/:id/messages`)
runs as an agentic tool loop with read-only QuickBase access. The system
prompt switches to MCP-on mode automatically — the model is told to *use*
the tools rather than refuse. Tool calls are persisted on the assistant
message in `chat_messages.tool_calls_json` and surfaced on the API.

If `QB_MCP_URL` is unset, the chatbot falls back to the strict
"refuse anything not pre-loaded" prompt and runs as a single-shot completion
— no behavior change from before MCP existed.

## OpenClaw on the VPS

Add `@modelcontextprotocol/sdk` to the OpenClaw package and wire a small
client wrapper. Pattern mirrors `qb-spa/server/src/lib/qbMcp.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const QB_MCP_URL = process.env.QB_MCP_URL!       // https://<qb-mcp-public-host>/mcp
const QB_MCP_TOKEN = process.env.QB_MCP_TOKEN!   // same value as MCP_SHARED_SECRET

let _client: Client | null = null

async function getClient(): Promise<Client> {
  if (_client) return _client
  const transport = new StreamableHTTPClientTransport(new URL(QB_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${QB_MCP_TOKEN}` } },
  })
  const client = new Client({ name: 'openclaw', version: '1.0.0' })
  await client.connect(transport)
  _client = client
  return client
}

export async function listQbTools() {
  const c = await getClient()
  return (await c.listTools()).tools
}

export async function callQbTool(name: string, args: Record<string, unknown>) {
  const c = await getClient()
  const r = await c.callTool({ name, arguments: args })
  // Flatten text blocks for the agent's tool-result slot.
  const content = (r as { content?: Array<{ type: string; text?: string }> }).content || []
  return content.filter(b => b.type === 'text').map(b => b.text!).join('\n')
}
```

VPS env vars (in OpenClaw's own `.env` / systemd unit / wherever it loads from):

```bash
QB_MCP_URL=https://<qb-mcp-public-host>/mcp
QB_MCP_TOKEN=<same secret as MCP_SHARED_SECRET>
```

Wire `listQbTools()` / `callQbTool()` into each agent's tool-use loop the
same way the qb-spa chatbot does in `server/src/lib/callUserLlm.ts` — list
tools once, pass them to the LLM, execute the calls, feed results back.

> **Don't ship the token in plaintext config.** Use whatever secret-management
> the VPS already does for `OPENCLAW_API_KEY` etc. and add this alongside.

## Verifying the bearer is enforced

Run these from anywhere with the public URL:

```bash
# 1. No token → 401 unauthorized.
curl -i https://<qb-mcp-public-host>/mcp
# Expected: HTTP/1.1 401 Unauthorized + WWW-Authenticate: Bearer

# 2. Wrong token → 401.
curl -i -H "Authorization: Bearer not-the-real-secret" https://<qb-mcp-public-host>/mcp

# 3. Correct token → 4xx but NOT 401 (a bare GET still fails because /mcp
#    expects a POST with an MCP initialize message, but you'll see a different
#    error or 405 method-not-allowed, not the 401).
curl -i -H "Authorization: Bearer <real-secret>" https://<qb-mcp-public-host>/mcp
```

If step 1 returns anything other than 401, `MCP_SHARED_SECRET` isn't set on
the qb-mcp Railway service — fix that before going live.

## Rotating the secret

`MCP_SHARED_SECRETS` (plural) on the qb-mcp service accepts a comma-separated
list of valid secrets, so you can roll without downtime:

1. Add a new secret to `MCP_SHARED_SECRETS` alongside the current one.
2. Update every client (`QB_MCP_TOKEN` on qb-spa and OpenClaw) to the new value.
3. Remove the old secret from the qb-mcp service.

Each step is a redeploy of the affected services, but no single moment where
auth is open.
