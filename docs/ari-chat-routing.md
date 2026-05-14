# Ari Chat Routing — Phase 1

How project-attached chat threads in `qb-spa` reach Ari (and other named
agents) running on the OpenClaw VPS, with the user's identity carried
through so backend permissions can be enforced.

Last updated: 2026-05-13. Status: design committed, implementation in flight.

## TL;DR

```
qb-spa user (req.user.email, roles)
   │
   │  POST /api/chat/threads/:id/messages   (existing chat route)
   ▼
qb-spa chat handler
   │
   │  if thread is project-attached:
   │     POST https://ai.kinhome.com/api/agent-runs/chat
   │     body: { workspace, content, session_key, actor }
   │     auth: Authorization: Bearer ${ARI_SHIM_TOKEN}
   ▼
Caddy reverse_proxy → localhost:18790
   │
   ▼
ari-chat-shim (new — small Python service on the VPS)
   │
   │  subprocess: claude --print --permission-mode bypassPermissions --session-id <key>
   │  cwd:        /root/.openclaw/workspace-coord   (or whatever workspace this agent lives in)
   │  env:        CLAUDE_ACTOR_EMAIL, CLAUDE_ACTOR_ROLES, CLAUDE_PROJECT_ID  (per-user identity)
   ▼
Claude Code CLI (Ari persona)
   │
   │  MCP calls into qb-mcp with X-Actor-Email forwarded
   ▼
qb-mcp → QuickBase   (scoped to the user's record filter)
```

For project-less ("general") chat threads, nothing changes — those continue
to run through the local `callUserLlm` path with the QB MCP tools we shipped
in [`docs/qb-mcp-wiring.md`](./qb-mcp-wiring.md). Phase 1 only routes
project-attached threads to Ari.

## Why this shape (and not OpenClaw RPC)

Working theory before probing: qb-spa would speak OpenClaw's WebSocket
gateway directly on `:18789`. What the VPS actually showed:

- The Telegram-bot bridge (`/opt/claude-tg-ops/bot.py`) — the one inbound
  channel for Ari that's currently working — doesn't touch the OpenClaw
  gateway. It spawns `claude --print --permission-mode bypassPermissions
  --continue` with `cwd=CLAUDE_CWD`. That's Anthropic's Claude Code CLI
  (`/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
  v2.1.141), invoked as a subprocess.
- OpenClaw's `:18789` gateway is a workspace/persona **management** UI —
  it organises `/root/.openclaw/workspace-coord`, `workspace-eng`, etc. —
  not a chat-dispatch RPC. Claude Code reads the workspace's config to pick
  the actual model for that agent (Ari is currently routed to a non-Claude
  model per the `openclaw.json.pre-ari-kimi-swap` backup file).
- Caddy already publishes `:18790` to the internet at
  `https://ai.kinhome.com/api/agent-runs/*` with a 320s timeout — a slot
  shaped for exactly this kind of long-running chat dispatch, with nothing
  bound to it yet.

So the cheapest path that actually works is the bot.py pattern, exposed via
HTTP instead of Telegram. `:18790` is its home.

## Components

### 1. `ari-chat-shim` (new VPS service)

A small HTTP service that wraps `claude --print` the same way bot.py does,
but inbound via HTTP rather than Telegram.

- **Lives at:** `/opt/ari-chat-shim/` (next to `/opt/claude-tg-ops/`).
- **Runs as:** systemd unit `ari-chat-shim.service`.
- **Port:** `127.0.0.1:18790` — Caddy already proxies
  `ai.kinhome.com/api/agent-runs/*` here.
- **Language:** Python 3 (mirrors bot.py — same stdlib idioms, same systemd
  shape, zero new toolchain on the VPS).

**HTTP contract:**

```
POST /chat
Authorization: Bearer <ARI_SHIM_TOKEN>
Content-Type: application/json

{
  "workspace": "coord",                          // which workspace (= which agent persona)
  "content":   "What notes are on this project?",
  "session_key": "thread-17492",                 // stable per chat thread → Claude --session-id
  "actor": {
    "email":      "paige@kinhome.com",
    "roles":      ["pc"],
    "project_id": 17492                          // optional, present when thread is project-attached
  }
}

→ 200 OK
{
  "ok": true,
  "content":     "There are 3 notes on this project...",
  "session_key": "thread-17492",
  "tokens_in":   1234,                           // when Claude reports them; else null
  "tokens_out":  567,
  "duration_ms": 4820
}

→ 4xx / 5xx
{ "ok": false, "error": "...", "code": "..." }
```

**What the shim does internally:**

1. Validate bearer token against `ARI_SHIM_TOKEN` env var.
2. Resolve workspace name → cwd via a config map. Day one:
   `{ "coord": "/root/.openclaw/workspace-coord" }`. Add `eng`, `finance`,
   `sales`, `marketing` as those agents come online.
3. Set env for the subprocess:
   - `CLAUDE_ACTOR_EMAIL=<actor.email>`
   - `CLAUDE_ACTOR_ROLES=<comma-joined>`
   - `CLAUDE_PROJECT_ID=<actor.project_id or empty>`
4. `subprocess.run(["claude", "--print", "--permission-mode", "bypassPermissions", "--session-id", session_key], input=content, cwd=cwd, env=env, timeout=300)`.
5. Return `stdout` as `content`. Capture token counts from stderr if Claude
   emits them; otherwise leave null.

**Per-user identity, two places:**

- **Env vars** for anything Ari's workspace explicitly reads (e.g. a hook
  or her `CLAUDE.md` that picks up `CLAUDE_ACTOR_EMAIL`).
- **Prompt prefix**: the shim wraps the user message as

  ```
  [Asked by: paige@kinhome.com (pc) about project 17492]

  What notes are on this project?
  ```

  This is universal — Ari sees who's asking even if the workspace config
  doesn't read env vars yet.

**Session memory:**

Each qb-spa chat thread gets a stable `session_key` (e.g. `thread-<id>`).
Claude Code's `--session-id` resumes that session every turn, so memory
flows naturally across messages without us managing it. Reset = new key.

**Auth model:**

- Inbound: shared bearer token (`ARI_SHIM_TOKEN`), env on both qb-spa
  Railway and the VPS shim. Rotatable.
- The shim is bound to `127.0.0.1` — only Caddy (TLS + HTTP/2) reaches it
  from outside. Defence in depth: even if Caddy mis-routes, no inbound port
  is open on the public interface.

### 2. `server/src/lib/ariClient.ts` (new in qb-spa)

Thin HTTP client for the shim. `dispatchToAri({ workspace, content,
sessionKey, actor })` → returns the same shape the chat route already
handles. Reuses the timeout/abort plumbing in `callUserLlm`.

- Env: `ARI_SHIM_URL` (e.g. `https://ai.kinhome.com/api/agent-runs/chat`),
  `ARI_SHIM_TOKEN`.
- Failure modes surface to the caller as typed errors; the chat route
  catches them and falls back to the generic `callUserLlm` path (so a shim
  outage degrades gracefully, never breaks chat).

### 3. `server/src/routes/chat.ts` changes

In the `POST /api/chat/threads/:id/messages` handler:

- After loading the thread + user message, check whether the thread is
  project-attached and whether `ARI_SHIM_URL` is set.
- If both: call `ariClient.dispatchToAri(...)` with the user's identity,
  the message, and `session_key = thread-<id>` (or a stored value).
- If the dispatch succeeds, persist Ari's reply as the assistant message.
  No `tool_calls_json` populated — Ari's tool calls happen inside her
  Claude Code process and aren't surfaced back yet (Phase 1.5 work).
- If the dispatch fails or `ARI_SHIM_URL` isn't configured, fall through
  to the existing `callUserLlm` + QB MCP path.

### 4. `chat_threads.openclaw_session_key`

New nullable column. Today we'll just use `thread-<id>` as the session key
deterministically, but a stored column lets us rotate it later (e.g. for
`/reset` in chat) without touching thread IDs.

Migration goes in `db.ts` using the existing PRAGMA-then-ALTER pattern
that already added `preferred_provider`, `preferred_model`, `space_id`.

## Per-user identity through to QB MCP (Phase 1)

Strategy §3.2 mandates per-user identity and permission, not service
accounts. Phase 1 takes the first step:

1. **qb-spa → shim**: the actor (email, roles, project_id) is in the POST
   body. ✅ above.
2. **Shim → Claude Code**: env vars + prompt prefix carry the actor into
   Ari's context. ✅ above.
3. **Claude Code (Ari) → qb-mcp**: Ari's MCP client should forward the
   actor on every tool call as a header (`X-Actor-Email`).
   ⚠ **Requires a small change on Ari's side**: her workspace's MCP
   client config or hook needs to read `CLAUDE_ACTOR_EMAIL` and set the
   header. That's a workspace-level edit, not a code change in qb-spa.
   Tracked as a follow-up.
4. **qb-mcp scoping**: qb-mcp reads `X-Actor-Email`, looks up the user's
   record-filter mapping, and AND-injects it into every `query_records` /
   `count_records` / `find_records` / `run_report` call.
   ⚠ **Requires a small PR against `KinHome-it/qb-mcp`** to add the header
   read + filter injection. Tracked as task #14 (follow-up).

Phase 1 ships steps 1 + 2 immediately (qb-spa side). Steps 3 + 4 follow as
separate PRs. Without them, Ari still works — she just queries QB with the
shared service-account token and isn't scoped. The audit trail (who asked
what) is already captured in qb-spa's `chat_messages` table on day one.

## Env vars summary

**qb-spa Railway service (new):**

```
ARI_SHIM_URL=https://ai.kinhome.com/api/agent-runs/chat
ARI_SHIM_TOKEN=<random hex from openssl rand -hex 32>
```

**VPS `/etc/ari-chat-shim/config.env` (new):**

```
ARI_SHIM_TOKEN=<same value as qb-spa>
ARI_SHIM_BIND=127.0.0.1:18790
ARI_SHIM_WORKSPACES_JSON={"coord":"/root/.openclaw/workspace-coord"}
ARI_SHIM_CLAUDE_BIN=/usr/bin/claude
ARI_SHIM_TIMEOUT_SEC=300
```

## Out of scope (later phases)

- **Tool-call surfacing**: render the QB MCP calls Ari made under her chat
  bubble (today they're invisible to qb-spa — they happen inside her
  Claude Code process). Phase 1.5: shim parses Claude's `--output-format
  stream-json` and forwards tool events back.
- **Streaming responses**: shim returns a single completion at end of run.
  Streaming (SSE from shim → qb-spa → browser) is straightforward to add;
  saves the user staring at "Ari is thinking..." for 30s. Phase 1.5.
- **Multi-agent delegation**: Ari deciding to consult Penny mid-answer.
  Workspace-side change — define an inter-agent tool in Ari's workspace
  that hits Penny's workspace. Phase 2.
- **agent_runs ledger promotion**: each chat message into Ari becomes an
  `agent_runs` row with cost/token accounting against her
  `monthly_token_cap`. Phase 2 alignment with the operating model.
- **`/reset` per chat thread**: rotate `openclaw_session_key` to start
  fresh memory. Trivial follow-up.

## Smoke test plan

After the shim is deployed and qb-spa is wired:

1. Open a project chat panel in qb-spa.
2. Ask: *"What notes are on this project?"*
3. Expect: a substantive answer pulling real notes from QB, in Ari's voice.
4. Inspect the assistant `chat_messages` row's `provider` field — it should
   say `ari` (not `anthropic`/`openai`/`ollama`), so we can tell at a glance
   which path served the message.
5. Inspect the shim's stdout/stderr logs (`journalctl -u ari-chat-shim
   -n 50`) to confirm the actor env vars were set.

If anything fails, the route falls back to the local-MCP chatbot path and
the user still gets *some* answer — just not Ari's.
