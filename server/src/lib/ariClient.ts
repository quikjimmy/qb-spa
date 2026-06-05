// Ari-chat-shim client.
//
// Project-attached chat threads dispatch each user message to the shim
// running on the OpenClaw VPS (mounted by Caddy at
// https://ai.kinhome.com/api/agent-runs/chat). The shim wraps Claude Code
// CLI in a specific workspace + carries per-user identity through env +
// prompt prefix. See docs/ari-chat-routing.md for the full design.
//
// Never throws — failures return { ok:false, ... } so the chat route can
// fall back to the local LLM + QB MCP path without breaking the user's
// conversation. Ari being down should degrade gracefully, not 500.

const URL_ENV = 'ARI_SHIM_URL'
const TOKEN_ENV = 'ARI_SHIM_TOKEN'
const DEFAULT_TIMEOUT_MS = 320_000   // matches Caddy's 320s read_timeout for /api/agent-runs*

export interface AriActor {
  email: string
  roles: string[]
  project_id?: number | null
}

export interface AriDispatchOptions {
  workspace: string                  // 'coord' for Ari; other agents add their workspace later
  content: string
  sessionKey: string                 // stable per chat thread → Claude --session-id
  actor: AriActor
  timeoutMs?: number
}

export type AriDispatchResult =
  | {
      ok: true
      content: string
      session_key: string
      tokens_in: number | null
      tokens_out: number | null
      duration_ms: number
    }
  | {
      ok: false
      error: string
      reason: 'not_configured' | 'http_error' | 'timeout' | 'parse_error' | 'shim_error'
      status?: number
    }

export interface AriStatus {
  enabled: boolean
  url: string | null
  hasToken: boolean
  reason?: string
}

function readConfig(): { url: string; token: string | null } | null {
  const url = (process.env[URL_ENV] || '').trim()
  if (!url) return null
  const token = (process.env[TOKEN_ENV] || '').trim() || null
  return { url, token }
}

export function ariStatus(): AriStatus {
  const cfg = readConfig()
  if (!cfg) return { enabled: false, url: null, hasToken: false, reason: `${URL_ENV} not set` }
  return { enabled: true, url: cfg.url, hasToken: !!cfg.token }
}

export async function dispatchToAri(opts: AriDispatchOptions): Promise<AriDispatchResult> {
  const cfg = readConfig()
  if (!cfg) {
    return { ok: false, error: `${URL_ENV} not set`, reason: 'not_configured' }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        workspace: opts.workspace,
        content: opts.content,
        session_key: opts.sessionKey,
        actor: {
          email: opts.actor.email,
          roles: opts.actor.roles,
          project_id: opts.actor.project_id ?? null,
        },
      }),
    })

    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 800)
      return {
        ok: false,
        error: `Ari shim HTTP ${r.status}: ${text || r.statusText}`,
        reason: 'http_error',
        status: r.status,
      }
    }

    const data = await r.json().catch(() => null) as
      | {
          ok?: boolean
          content?: string
          session_key?: string
          tokens_in?: number | null
          tokens_out?: number | null
          duration_ms?: number
          error?: string
          code?: string
        }
      | null

    if (!data) {
      return { ok: false, error: 'Ari shim returned non-JSON body', reason: 'parse_error' }
    }
    if (data.ok === false || typeof data.content !== 'string') {
      return {
        ok: false,
        error: data.error || 'Ari shim returned ok:false',
        reason: 'shim_error',
      }
    }

    return {
      ok: true,
      content: data.content,
      session_key: data.session_key || opts.sessionKey,
      tokens_in: typeof data.tokens_in === 'number' ? data.tokens_in : null,
      tokens_out: typeof data.tokens_out === 'number' ? data.tokens_out : null,
      duration_ms: typeof data.duration_ms === 'number' ? data.duration_ms : 0,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isAbort = msg.toLowerCase().includes('abort') || (e instanceof Error && e.name === 'AbortError')
    return {
      ok: false,
      error: isAbort ? 'Ari shim request timed out' : msg,
      reason: isAbort ? 'timeout' : 'http_error',
    }
  } finally {
    clearTimeout(timer)
  }
}

// Default mapping: every thread (project-attached or general) routes to Ari's
// 'coord' workspace for now. As more agents come online, this becomes a router
// (by department, by project type, etc.). Keeping it as a function makes future
// expansion non-breaking: callers don't need to know the rules.
export function workspaceForProjectThread(_projectId: number | null): string {
  return 'coord'
}
