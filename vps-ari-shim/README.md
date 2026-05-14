# ari-chat-shim — deploy to the OpenClaw VPS

Small HTTP service that wraps `claude --print` so qb-spa can dispatch
project-attached chat messages to Ari (and other named agents) over
HTTP. See `docs/ari-chat-routing.md` in the main repo for the full design.

## What's in this folder

| File | Goes where on the VPS |
|---|---|
| `server.py` | `/opt/ari-chat-shim/server.py` |
| `ari-chat-shim.service` | `/etc/systemd/system/ari-chat-shim.service` |
| `config.env.example` | `/etc/ari-chat-shim/config.env` (rename, fill in, `chmod 600`) |

## Install steps (on the VPS, as root)

```bash
# 1. Drop the code in place.
mkdir -p /opt/ari-chat-shim
# scp this folder's server.py up, or just paste it:
nano /opt/ari-chat-shim/server.py     # paste contents

# 2. Config. Generate a fresh token and use the SAME value on qb-spa Railway.
mkdir -p /etc/ari-chat-shim
nano /etc/ari-chat-shim/config.env    # paste config.env.example, fill in ARI_SHIM_TOKEN
chmod 600 /etc/ari-chat-shim/config.env
openssl rand -hex 32                  # what to paste into ARI_SHIM_TOKEN

# 3. Systemd unit.
nano /etc/systemd/system/ari-chat-shim.service   # paste contents

# 4. Start it.
systemctl daemon-reload
systemctl enable --now ari-chat-shim
systemctl status ari-chat-shim                   # should be "active (running)"

# 5. Smoke-test locally on the VPS.
curl -s -i http://127.0.0.1:18790/healthz
# → { "ok": true, "service": "ari-chat-shim", "workspaces": ["coord"] }

# Then with auth + workspace:
curl -s -i -X POST http://127.0.0.1:18790/chat \
  -H "Authorization: Bearer $(grep ARI_SHIM_TOKEN /etc/ari-chat-shim/config.env | cut -d= -f2)" \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"coord","session_key":"test-1","content":"who are you?","actor":{"email":"test@kinhome.com","roles":["pc"]}}'
# → { "ok": true, "content": "I'm Ari...", "session_key": "test-1", ... }

# 6. From outside (proves Caddy is wired):
curl -s -i -X POST https://ai.kinhome.com/api/agent-runs/chat \
  -H "Authorization: Bearer <same token>" \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"coord","session_key":"test-2","content":"who are you?","actor":{"email":"test@kinhome.com","roles":["pc"]}}'
```

## qb-spa side (Railway env vars on the qb-spa service)

```
ARI_SHIM_URL=https://ai.kinhome.com/api/agent-runs/chat
ARI_SHIM_TOKEN=<same value as on the VPS>
```

After redeploy: project-attached chat threads will route through Ari.
Verify on the diagnostic endpoint:

```js
const token = localStorage.getItem('token')
fetch('/api/chat/threads', { headers: { Authorization: `Bearer ${token}` } })
  .then(r => r.json())
  .then(({threads}) => fetch(`/api/chat/threads/${threads[0].id}/context-preview`, { headers: { Authorization: `Bearer ${token}` } }))
  .then(r => r.json()).then(d => console.log(d.ari))
// → { enabled: true, url: 'https://ai.kinhome.com/api/agent-runs/chat', hasToken: true }
```

## What the shim does on each request

1. Verifies `Authorization: Bearer <ARI_SHIM_TOKEN>` (constant-time compare).
2. Validates the workspace name against the mapping in
   `ARI_SHIM_WORKSPACES_JSON` and resolves it to a cwd.
3. Sets per-user identity env vars before spawning the subprocess:
   `CLAUDE_ACTOR_EMAIL`, `CLAUDE_ACTOR_ROLES`, `CLAUDE_PROJECT_ID`.
4. Wraps the user message with an actor banner so the agent always sees
   *who* is asking, even if the workspace config doesn't read the env vars:
   ```
   [Asked by: paige@kinhome.com (roles: pc) about project 17492]

   What notes are on this project?
   ```
5. Runs `claude --print --permission-mode bypassPermissions --session-id <key>`
   in the workspace cwd. The `--session-id` keeps memory per qb-spa chat
   thread without us managing state.
6. Returns Claude's stdout as JSON.

## Adding more agents later

Just extend `ARI_SHIM_WORKSPACES_JSON`:

```
ARI_SHIM_WORKSPACES_JSON={"coord":"/root/.openclaw/workspace-coord","finance":"/root/.openclaw/workspace-finance","eng":"/root/.openclaw/workspace-eng"}
```

`systemctl restart ari-chat-shim`. On the qb-spa side, update
`workspaceForProjectThread()` in `server/src/lib/ariClient.ts` to route
projects to the right workspace by department.

## Logs

```bash
journalctl -u ari-chat-shim -f
journalctl -u ari-chat-shim -n 100 --no-pager
```

Each request logs `dispatch workspace=... session=... actor=... len=...`.

## What this does NOT do (yet)

- **Stream the response.** The shim returns a single completion at the end
  of the claude run. qb-spa's chat UI waits ~5–30s. Streaming is a Phase
  1.5 follow-up (use `claude --print --output-format stream-json` and
  forward SSE).
- **Surface Ari's tool calls.** Tool calls happen inside the claude
  subprocess; the shim only returns the final stdout. Phase 1.5: parse the
  stream-json events and pass tool events back.
- **Real token counting.** Token in/out come back as null. Phase 1.5
  parses them from claude's usage block.
- **Forward actor identity into the QB MCP call.** That requires Ari's
  workspace MCP config to read `CLAUDE_ACTOR_EMAIL` and set an
  `X-Actor-Email` header on her qb-mcp calls. Separate workspace-level
  edit on the VPS (not in this shim).
