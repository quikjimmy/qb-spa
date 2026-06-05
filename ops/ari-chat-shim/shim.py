#!/usr/bin/env python3
"""ari-chat-shim — HTTP wrapper around `claude --print`.

Inbound counterpart to qb-spa's server/src/lib/ariClient.ts. Caddy proxies
https://ai.kinhome.com/api/agent-runs/* → 127.0.0.1:18790 (prefix stripped),
so this service only ever sees POST /chat.

Stdlib only (Python 3.9+) — mirrors the /opt/claude-tg-ops/bot.py pattern,
no virtualenv, no pip. See docs/ari-chat-routing.md for the design.

Contract:
  POST /chat
  Authorization: Bearer <ARI_SHIM_TOKEN>
  { "workspace", "content", "session_key", "actor": { email, roles, project_id } }
  → 200 { "ok": true, "content", "session_key", "tokens_in", "tokens_out", "duration_ms" }
  → 4xx/5xx { "ok": false, "error", "code" }
"""

import json
import os
import hmac
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- Config from env -------------------------------------------------------

TOKEN = os.environ.get("ARI_SHIM_TOKEN", "").strip()
BIND = os.environ.get("ARI_SHIM_BIND", "127.0.0.1:18790").strip()
CLAUDE_BIN = os.environ.get("ARI_SHIM_CLAUDE_BIN", "/usr/bin/claude").strip()
TIMEOUT_SEC = int(os.environ.get("ARI_SHIM_TIMEOUT_SEC", "300"))
# {"coord": "/root/.openclaw/workspace-coord", ...}
WORKSPACES = json.loads(os.environ.get("ARI_SHIM_WORKSPACES_JSON", "{}"))

MAX_BODY = 1_000_000  # 1 MB cap on request bodies


def _host_port(bind: str):
    host, _, port = bind.rpartition(":")
    return host or "127.0.0.1", int(port)


class Handler(BaseHTTPRequestHandler):
    server_version = "ari-chat-shim/1"

    # Quieter logs — one line per request, no default stderr spam.
    def log_message(self, fmt, *args):
        print("[ari-chat-shim] %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Health probe — Caddy/uptime checks. No auth required.
        if self.path in ("/health", "/api/agent-runs/health"):
            self._send(200, {"ok": True, "service": "ari-chat-shim"})
        else:
            self._send(404, {"ok": False, "error": "Not Found", "code": "not_found"})

    def do_POST(self):
        # Caddy strips /api/agent-runs, so the shim sees /chat. Accept both
        # in case the prefix isn't stripped, to fail safe during rollout.
        if self.path not in ("/chat", "/api/agent-runs/chat"):
            self._send(404, {"ok": False, "error": "Not Found", "code": "not_found"})
            return

        # 1. Auth — constant-time bearer check.
        auth = self.headers.get("Authorization", "")
        presented = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not TOKEN or not hmac.compare_digest(presented, TOKEN):
            self._send(401, {"ok": False, "error": "Unauthorized", "code": "unauthorized"})
            return

        # 2. Parse body.
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send(400, {"ok": False, "error": "Missing or oversized body", "code": "bad_request"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"ok": False, "error": "Body is not valid JSON", "code": "bad_json"})
            return

        content = (data.get("content") or "").strip()
        workspace = (data.get("workspace") or "").strip()
        session_key = (data.get("session_key") or "").strip()
        actor = data.get("actor") or {}
        if not content:
            self._send(400, {"ok": False, "error": "Empty content", "code": "empty_content"})
            return
        if not session_key:
            self._send(400, {"ok": False, "error": "Missing session_key", "code": "no_session"})
            return

        # 3. Resolve workspace → cwd.
        cwd = WORKSPACES.get(workspace)
        if not cwd:
            self._send(400, {"ok": False, "error": "Unknown workspace: %s" % workspace, "code": "unknown_workspace"})
            return
        if not os.path.isdir(cwd):
            self._send(500, {"ok": False, "error": "Workspace dir missing: %s" % cwd, "code": "workspace_missing"})
            return

        # 4. Per-user identity → subprocess env + prompt prefix.
        email = (actor.get("email") or "").strip()
        roles = actor.get("roles") or []
        roles_csv = ",".join(str(r) for r in roles)
        project_id = actor.get("project_id")

        env = os.environ.copy()
        env["CLAUDE_ACTOR_EMAIL"] = email
        env["CLAUDE_ACTOR_ROLES"] = roles_csv
        env["CLAUDE_PROJECT_ID"] = str(project_id) if project_id not in (None, "") else ""

        who = email or "unknown"
        if roles_csv:
            who += " (%s)" % roles_csv
        about = " about project %s" % project_id if project_id not in (None, "") else ""
        prompt = "[Asked by: %s%s]\n\n%s" % (who, about, content)

        # 5. Run claude --print, resuming the thread's session.
        started = time.monotonic()
        try:
            proc = subprocess.run(
                [CLAUDE_BIN, "--print", "--permission-mode", "bypassPermissions",
                 "--session-id", session_key],
                input=prompt, cwd=cwd, env=env, timeout=TIMEOUT_SEC,
                capture_output=True, text=True,
            )
        except subprocess.TimeoutExpired:
            self._send(504, {"ok": False, "error": "Claude run timed out after %ss" % TIMEOUT_SEC, "code": "timeout"})
            return
        except FileNotFoundError:
            self._send(500, {"ok": False, "error": "claude binary not found at %s" % CLAUDE_BIN, "code": "no_claude"})
            return

        duration_ms = int((time.monotonic() - started) * 1000)

        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()[:800]
            self._send(500, {"ok": False, "error": "claude exited %d: %s" % (proc.returncode, err), "code": "claude_error"})
            return

        out = (proc.stdout or "").strip()
        if not out:
            # Don't return an empty success — qb-spa would persist a blank
            # bubble. Surface it as an error so the user sees a real failure.
            self._send(502, {"ok": False, "error": "Claude returned no output", "code": "empty_output"})
            return

        self._send(200, {
            "ok": True,
            "content": out,
            "session_key": session_key,
            "tokens_in": None,   # claude --print doesn't reliably emit usage; leave null
            "tokens_out": None,
            "duration_ms": duration_ms,
        })


def main():
    if not TOKEN:
        raise SystemExit("ARI_SHIM_TOKEN is not set — refusing to start without auth")
    host, port = _host_port(BIND)
    httpd = ThreadingHTTPServer((host, port), Handler)
    print("[ari-chat-shim] listening on %s:%d, workspaces=%s" % (host, port, list(WORKSPACES)), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
