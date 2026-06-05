# ari-chat-shim — deploy

The inbound HTTP service that makes `https://ai.kinhome.com/api/agent-runs/chat`
work. Without it, qb-spa chat dispatches 404 and every thread shows
"Ari isn't responding right now." See `docs/ari-chat-routing.md` for the design.

This service runs on the **OpenClaw VPS** (the box behind `ai.kinhome.com`),
not on Railway. These files are version-controlled here so they can be copied up.

## What's here

| File | Goes to (on the VPS) |
|------|----------------------|
| `shim.py` | `/opt/ari-chat-shim/shim.py` |
| `ari-chat-shim.service` | `/etc/systemd/system/ari-chat-shim.service` |
| `config.env.example` | `/etc/ari-chat-shim/config.env` (rename, chmod 600) |
| `Caddyfile.snippet` | paste into the `ai.kinhome.com { }` block in the Caddyfile |

## Deploy steps (run on the VPS as root)

```bash
# 1. Code + config
mkdir -p /opt/ari-chat-shim /etc/ari-chat-shim
scp shim.py root@<vps>:/opt/ari-chat-shim/shim.py        # or git pull / paste
scp config.env.example root@<vps>:/etc/ari-chat-shim/config.env
chmod 600 /etc/ari-chat-shim/config.env
# -> edit config.env: confirm ARI_SHIM_TOKEN matches Railway, fix workspace path

# 2. Sanity-check the workspace dir + claude binary the config points at
ls -d "$(python3 -c 'import json,os;print(json.load(open("/etc/ari-chat-shim/config.env")) if False else "")' 2>/dev/null)"   # (just verify by eye)
which claude            # must match ARI_SHIM_CLAUDE_BIN
ls -d /root/.openclaw/workspace-coord   # must match ARI_SHIM_WORKSPACES_JSON

# 3. systemd
scp ari-chat-shim.service root@<vps>:/etc/systemd/system/ari-chat-shim.service
systemctl daemon-reload
systemctl enable --now ari-chat-shim
systemctl status ari-chat-shim --no-pager
journalctl -u ari-chat-shim -n 30 --no-pager

# 4. Caddy — paste Caddyfile.snippet into the ai.kinhome.com site block
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## Smoke tests

```bash
# On the VPS — bypasses Caddy, hits the shim directly:
curl -s localhost:18790/health
# -> {"ok": true, "service": "ari-chat-shim"}

curl -s -X POST localhost:18790/chat \
  -H "Authorization: Bearer $ARI_SHIM_TOKEN" -H "Content-Type: application/json" \
  -d '{"workspace":"coord","content":"say hello","session_key":"smoke-1","actor":{"email":"you@kinhome.com","roles":["admin"],"project_id":null}}'
# -> {"ok": true, "content": "...", ...}

# From anywhere — through Caddy + TLS (the path qb-spa actually uses):
curl -s -X POST https://ai.kinhome.com/api/agent-runs/chat \
  -H "Authorization: Bearer <ARI_SHIM_TOKEN>" -H "Content-Type: application/json" \
  -d '{"workspace":"coord","content":"say hello","session_key":"smoke-2","actor":{"email":"you@kinhome.com","roles":["admin"],"project_id":null}}'
```

When the through-Caddy curl returns `ok:true`, qb-spa chat will route to Ari
automatically — no qb-spa redeploy needed (it's already dispatching; it just
gets a 200 instead of a 404).

## Notes / gotchas

- **Token parity is everything.** `ARI_SHIM_TOKEN` here must equal the Railway
  var byte-for-byte, or every request 401s.
- **Empty output is treated as an error** (HTTP 502, `code: empty_output`) on
  purpose — qb-spa was silently persisting blank replies before. If you see
  these, the claude run is producing nothing (bad workspace, auth, or model).
- **`--permission-mode bypassPermissions`** means Ari runs tools without
  prompting. That's intended for an unattended service, but it also means the
  workspace's tool allow-list / MCP scoping is the only guardrail. Per-user QB
  scoping (X-Actor-Email → qb-mcp filter) is still a follow-up (docs §Phase 1,
  steps 3-4) — until then Ari queries QB with the shared service account.
- **Session store**: `--session-id thread-<n>` resumes per-thread memory. These
  live under the workspace's claude state dir; they grow over time.
