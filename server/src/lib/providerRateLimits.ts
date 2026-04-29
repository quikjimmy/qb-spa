import db from '../db'
import type { ProviderId } from './userProviderKeys'

export interface RateSnapshot {
  tokens_remaining: number | null
  tokens_limit: number | null
  requests_remaining: number | null
  requests_limit: number | null
  reset_at: string | null     // ISO timestamp when the window resets
}

const EMPTY: RateSnapshot = {
  tokens_remaining: null, tokens_limit: null,
  requests_remaining: null, requests_limit: null,
  reset_at: null,
}

// Header parsers per provider.
// All providers expose at least short-window rate-limit info; monthly spend
// lives on their dashboards only.
export function parseRateLimitHeaders(provider: ProviderId, headers: Headers | Record<string, string>): RateSnapshot {
  const get = (k: string): string | null => {
    if (headers instanceof Headers) return headers.get(k)
    const lower: Record<string, string> = {}
    for (const [hk, hv] of Object.entries(headers)) lower[hk.toLowerCase()] = String(hv)
    return lower[k.toLowerCase()] ?? null
  }

  const num = (k: string): number | null => {
    const v = get(k)
    if (v == null) return null
    const n = parseFloat(v)
    return Number.isFinite(n) ? Math.round(n) : null
  }

  if (provider === 'anthropic') {
    return {
      tokens_remaining: num('anthropic-ratelimit-tokens-remaining') ?? num('anthropic-ratelimit-input-tokens-remaining'),
      tokens_limit: num('anthropic-ratelimit-tokens-limit') ?? num('anthropic-ratelimit-input-tokens-limit'),
      requests_remaining: num('anthropic-ratelimit-requests-remaining'),
      requests_limit: num('anthropic-ratelimit-requests-limit'),
      reset_at: get('anthropic-ratelimit-tokens-reset') || get('anthropic-ratelimit-requests-reset'),
    }
  }

  if (provider === 'openai') {
    // OpenAI returns time-strings like "1s" or "6m20s" for reset; normalize to absolute ISO.
    const tokensReset = get('x-ratelimit-reset-tokens')
    const reqReset = get('x-ratelimit-reset-requests')
    const resetAt = openAiRelativeToIso(tokensReset || reqReset)
    return {
      tokens_remaining: num('x-ratelimit-remaining-tokens'),
      tokens_limit: num('x-ratelimit-limit-tokens'),
      requests_remaining: num('x-ratelimit-remaining-requests'),
      requests_limit: num('x-ratelimit-limit-requests'),
      reset_at: resetAt,
    }
  }

  // ollama (cloud) — uses standard X-RateLimit-* headers when on a metered plan
  return {
    tokens_remaining: num('x-ratelimit-remaining-tokens') ?? num('x-ratelimit-remaining'),
    tokens_limit: num('x-ratelimit-limit-tokens') ?? num('x-ratelimit-limit'),
    requests_remaining: num('x-ratelimit-remaining-requests'),
    requests_limit: num('x-ratelimit-limit-requests'),
    reset_at: get('x-ratelimit-reset') ? new Date(parseInt(get('x-ratelimit-reset')!, 10) * 1000).toISOString() : null,
  }
}

// OpenAI returns reset windows as relative strings: "1s", "6m20s", "1h2m".
// Convert to absolute ISO so the client can render a countdown without
// having to know the response time.
function openAiRelativeToIso(s: string | null): string | null {
  if (!s) return null
  const m = s.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/i)
  if (!m) return null
  const h = parseInt(m[1] || '0', 10)
  const min = parseInt(m[2] || '0', 10)
  const sec = parseFloat(m[3] || '0')
  const ms = parseInt(m[4] || '0', 10)
  const totalMs = h * 3600_000 + min * 60_000 + sec * 1000 + ms
  if (totalMs <= 0) return null
  return new Date(Date.now() + totalMs).toISOString()
}

export function recordRateSnapshot(userId: number, provider: ProviderId, snap: RateSnapshot, usedOwnKey: boolean): void {
  // Skip the write if we got no usable data (provider didn't surface any headers).
  if (snap.tokens_remaining == null && snap.requests_remaining == null) return
  db.prepare(
    `INSERT INTO provider_rate_snapshots (user_id, provider, tokens_remaining, tokens_limit, requests_remaining, requests_limit, reset_at, used_own_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, provider) DO UPDATE SET
       tokens_remaining = excluded.tokens_remaining,
       tokens_limit = COALESCE(excluded.tokens_limit, provider_rate_snapshots.tokens_limit),
       requests_remaining = excluded.requests_remaining,
       requests_limit = COALESCE(excluded.requests_limit, provider_rate_snapshots.requests_limit),
       reset_at = excluded.reset_at,
       used_own_key = excluded.used_own_key,
       updated_at = datetime('now')`
  ).run(userId, provider, snap.tokens_remaining, snap.tokens_limit, snap.requests_remaining, snap.requests_limit, snap.reset_at, usedOwnKey ? 1 : 0)
}

export function getSnapshot(userId: number, provider: ProviderId): (RateSnapshot & { used_own_key: boolean; updated_at: string }) | null {
  const row = db.prepare(
    `SELECT * FROM provider_rate_snapshots WHERE user_id = ? AND provider = ?`
  ).get(userId, provider) as { tokens_remaining: number | null; tokens_limit: number | null; requests_remaining: number | null; requests_limit: number | null; reset_at: string | null; used_own_key: number; updated_at: string } | undefined
  if (!row) return null
  return {
    tokens_remaining: row.tokens_remaining,
    tokens_limit: row.tokens_limit,
    requests_remaining: row.requests_remaining,
    requests_limit: row.requests_limit,
    reset_at: row.reset_at,
    used_own_key: row.used_own_key === 1,
    updated_at: row.updated_at,
  }
}

export const EMPTY_SNAPSHOT = EMPTY
