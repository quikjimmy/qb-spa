#!/usr/bin/env python3
"""ari-chat-shim — minimal HTTP wrapper around `claude --print` for qb-spa.

Listens on 127.0.0.1:18790 (Caddy's already-published slot at
https://ai.kinhome.com/api/agent-runs/*) and exposes a single endpoint:

    POST /chat
    Authorization: Bearer <ARI_SHIM_TOKEN>
    Content-Type: application/json
    {
      "workspace":   "coord",
      "content":     "user message",
      "session_key": "qbspa-thread-123",
      "actor": { "email": "...", "roles": ["..."], "project_id": 17492 }
    }

Spawns `claude --print --permission-mode bypassPermissions --session-id <key>`
in the workspace's cwd, with the user's identity in env + a prompt prefix
so the agent can see who's asking. Returns Claude's stdout as JSON.

Config via env vars (see /etc/ari-chat-shim/config.env):
    ARI_SHIM_TOKEN          Required. Shared secret bearer.
    ARI_SHIM_BIND           Optional. host:port (default 127.0.0.1:18790).
    ARI_SHIM_WORKSPACES_JSON  Required. JSON map of workspace -> cwd path.
                            Example: {"coord":"/root/.openclaw/workspace-coord"}
    ARI_SHIM_CLAUDE_BIN     Optional. Path to claude (default /usr/bin/claude).
    ARI_SHIM_TIMEOUT_SEC    Optional. Per-request claude timeout (default 300).

Logs to stdout for journalctl. No file state — sessions live inside Claude
Code itself, keyed by --session-id.

Mirrors /opt/claude-tg-ops/bot.py's run_claude() shape; ported to inbound
HTTP and per-user identity passthrough.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# --- Config ---------------------------------------------------------------

TOKEN = os.environ.get("ARI_SHIM_TOKEN", "").strip()
BIND = os.environ.get("ARI_SHIM_BIND", "127.0.0.1:18790").strip()
CLAUDE_BIN = os.environ.get("ARI_SHIM_CLAUDE_BIN", "/usr/bin/claude").strip()
TIMEOUT_SEC = int(os.environ.get("ARI_SHIM_TIMEOUT_SEC", "300"))

try:
    WORKSPACES: dict[str, str] = json.loads(
        os.environ.get("ARI_SHIM_WORKSPACES_JSON", "{}")
    )
    if not isinstance(WORKSPACES, dict):
        raise ValueError("ARI_SHIM_WORKSPACES_JSON must be an object")
except Exception as e:
    sys.stderr.write(f"FATAL: bad ARI_SHIM_WORKSPACES_JSON: {e}\n")
    sys.exit(1)

if not TOKEN:
    sys.stderr.write("FATAL: ARI_SHIM_TOKEN must be set\n")
    sys.exit(1)

if not WORKSPACES:
    sys.stderr.write(
        "FATAL: ARI_SHIM_WORKSPACES_JSON must contain at least one workspace mapping\n"
    )
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("ari-chat-shim")


# --- HTTP -----------------------------------------------------------------


def _send_json(handler: BaseHTTPRequestHandler, status: int, body: dict[str, Any]) -> None:
    payload = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _bearer_ok(header_value: str | None) -> bool:
    if not header_value or not header_value.startswith("Bearer "):
        return False
    provided = header_value[7:].encode("utf-8")
    expected = TOKEN.encode("utf-8")
    # Constant-time comparison so timing doesn't leak the token byte-by-byte.
    return hmac.compare_digest(provided, expected)


def _build_prompt(content: str, actor: dict[str, Any]) -> str:
    """Wrap the user's message with an actor banner the agent always sees."""
    email = actor.get("email") or "unknown"
    roles = ",".join(actor.get("roles") or []) or "none"
    project_id = actor.get("project_id")
    pid_str = f" about project {project_id}" if project_id else ""
    banner = f"[Asked by: {email} (roles: {roles}){pid_str}]"
    return f"{banner}\n\n{content}"


def _run_claude(
    workspace_cwd: str,
    session_key: str,
    prompt: str,
    actor_env: dict[str, str],
) -> tuple[bool, str, str, int, int, int, int]:
    """Returns (ok, stdout, stderr, returncode, tokens_in, tokens_out, elapsed_ms)."""
    env = dict(os.environ)
    env.update(actor_env)
    started = time.monotonic()
    try:
        proc = subprocess.run(
            [
                CLAUDE_BIN,
                "--print",
                "--permission-mode",
                "bypassPermissions",
                "--session-id",
                session_key,
            ],
            input=prompt,
            capture_output=True,
            text=True,
            cwd=workspace_cwd,
            env=env,
            timeout=TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return False, "", f"claude timed out after {TIMEOUT_SEC}s", -1, 0, 0, elapsed_ms
    except FileNotFoundError as e:
        return False, "", f"claude binary not found: {e}", -1, 0, 0, 0

    elapsed_ms = int((time.monotonic() - started) * 1000)
    # Token counts: claude --print doesn't emit them by default. Phase 1.5
    # can switch to --output-format stream-json and parse the usage block.
    return (
        proc.returncode == 0,
        (proc.stdout or "").strip(),
        (proc.stderr or "").strip(),
        proc.returncode,
        0,
        0,
        elapsed_ms,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "ari-chat-shim/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Route BaseHTTPRequestHandler's noisy logger through our structured one.
        log.info("%s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:  # noqa: N802 — required name
        if self.path in ("/", "/healthz"):
            _send_json(self, 200, {"ok": True, "service": "ari-chat-shim", "workspaces": list(WORKSPACES.keys())})
            return
        _send_json(self, 404, {"ok": False, "error": "Not Found"})

    def do_POST(self) -> None:  # noqa: N802 — required name
        if self.path != "/chat":
            _send_json(self, 404, {"ok": False, "error": "Not Found"})
            return

        if not _bearer_ok(self.headers.get("Authorization")):
            _send_json(self, 401, {"ok": False, "error": "Unauthorized"})
            return

        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0 or length > 1_000_000:
            _send_json(self, 400, {"ok": False, "error": "Invalid Content-Length"})
            return

        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except Exception:
            _send_json(self, 400, {"ok": False, "error": "Invalid JSON"})
            return

        workspace = (body.get("workspace") or "").strip()
        content = (body.get("content") or "").strip()
        session_key = (body.get("session_key") or "").strip()
        actor = body.get("actor") or {}

        if not workspace or workspace not in WORKSPACES:
            _send_json(
                self,
                400,
                {
                    "ok": False,
                    "error": f"Unknown workspace '{workspace}'",
                    "available": list(WORKSPACES.keys()),
                },
            )
            return
        if not content:
            _send_json(self, 400, {"ok": False, "error": "content is required"})
            return
        if not session_key:
            _send_json(self, 400, {"ok": False, "error": "session_key is required"})
            return
        if not isinstance(actor, dict):
            _send_json(self, 400, {"ok": False, "error": "actor must be an object"})
            return

        cwd = WORKSPACES[workspace]
        prompt = _build_prompt(content, actor)
        actor_env = {
            "CLAUDE_ACTOR_EMAIL": str(actor.get("email") or ""),
            "CLAUDE_ACTOR_ROLES": ",".join(actor.get("roles") or []),
            "CLAUDE_PROJECT_ID": str(actor.get("project_id") or ""),
        }

        log.info(
            "dispatch workspace=%s session=%s actor=%s len=%d",
            workspace,
            session_key,
            actor_env["CLAUDE_ACTOR_EMAIL"] or "(none)",
            len(content),
        )

        ok, stdout, stderr, rc, t_in, t_out, elapsed_ms = _run_claude(
            cwd, session_key, prompt, actor_env
        )

        if not ok:
            log.warning("claude failed rc=%s stderr=%s", rc, stderr[:500])
            _send_json(
                self,
                502,
                {
                    "ok": False,
                    "error": stderr or f"claude exited {rc}",
                    "code": "claude_error",
                    "duration_ms": elapsed_ms,
                },
            )
            return

        _send_json(
            self,
            200,
            {
                "ok": True,
                "content": stdout or "(empty response)",
                "session_key": session_key,
                "tokens_in": t_in or None,
                "tokens_out": t_out or None,
                "duration_ms": elapsed_ms,
            },
        )


def _parse_bind(s: str) -> tuple[str, int]:
    host, _, port = s.rpartition(":")
    if not host or not port:
        raise ValueError(f"ARI_SHIM_BIND must be host:port, got {s!r}")
    return host, int(port)


class IPv4ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET   # force IPv4 — Caddy proxies over IPv4 loopback
    daemon_threads = True             # threads die with the server, no zombies on shutdown


def main() -> None:
    host, port = _parse_bind(BIND)
    server = IPv4ThreadingHTTPServer((host, port), Handler)
    log.info(
        "listening on %s:%d, workspaces=%s, claude=%s, timeout=%ds",
        host,
        port,
        list(WORKSPACES.keys()),
        CLAUDE_BIN,
        TIMEOUT_SEC,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
