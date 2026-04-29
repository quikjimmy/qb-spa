import db from '../db'
import { decryptSecret } from './crypto'

export type ProviderId = 'ollama' | 'anthropic' | 'openai'
export const SUPPORTED_PROVIDERS: ProviderId[] = ['ollama', 'anthropic', 'openai']

export function isSupportedProvider(p: string): p is ProviderId {
  return (SUPPORTED_PROVIDERS as string[]).includes(p)
}

export interface ProviderKeyRow {
  id: number
  user_id: number
  provider: string
  label: string | null
  api_key_encrypted: string
  base_url: string | null
  is_default: number
  last_tested_at: string | null
  last_test_ok: number | null
  last_test_error: string | null
  last_test_models_count: number | null
  created_at: string
  updated_at: string
}

// Returns the user's default key for a provider, decrypted, or null if none.
// Used by callers that need to make an LLM request on behalf of the user.
export function getDefaultKeyFor(userId: number, provider: ProviderId): { apiKey: string; baseUrl: string | null } | null {
  const row = db.prepare(
    `SELECT api_key_encrypted, base_url FROM user_provider_keys
      WHERE user_id = ? AND provider = ? AND is_default = 1
      LIMIT 1`
  ).get(userId, provider) as { api_key_encrypted: string; base_url: string | null } | undefined
  if (!row) return null
  try {
    return { apiKey: decryptSecret(row.api_key_encrypted), baseUrl: row.base_url }
  } catch {
    return null
  }
}

export function listUserKeys(userId: number): ProviderKeyRow[] {
  return db.prepare(
    `SELECT * FROM user_provider_keys WHERE user_id = ? ORDER BY provider, is_default DESC, created_at DESC`
  ).all(userId) as ProviderKeyRow[]
}

// Defaults applied when the client doesn't provide a base URL for a provider.
export function defaultBaseUrl(provider: ProviderId): string {
  if (provider === 'ollama') return 'https://ollama.com'
  if (provider === 'anthropic') return 'https://api.anthropic.com'
  return 'https://api.openai.com'
}

// Per-provider connectivity probe. Returns { ok, modelsCount, sample, error }.
// Probes are designed to be cheap (no token spend on Anthropic/OpenAI):
//   - ollama: GET {base}/api/tags (lists pulled models)
//   - anthropic: GET {base}/v1/models (cheap, lists models)
//   - openai: GET {base}/v1/models
export async function probeProvider(provider: ProviderId, apiKey: string, baseUrl: string | null): Promise<{ ok: boolean; modelsCount: number | null; sample: string[]; error?: string }> {
  const base = (baseUrl || defaultBaseUrl(provider)).replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)

  try {
    if (provider === 'ollama') {
      const r = await fetch(`${base}/api/tags`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!r.ok) {
        const text = (await r.text().catch(() => '')).slice(0, 300)
        return { ok: false, modelsCount: null, sample: [], error: `HTTP ${r.status}: ${text || r.statusText}` }
      }
      const data = await r.json().catch(() => ({})) as { models?: Array<{ name?: string; model?: string }> }
      const models = Array.isArray(data.models) ? data.models : []
      return { ok: true, modelsCount: models.length, sample: models.slice(0, 8).map(m => String(m.name || m.model || '')) }
    }

    if (provider === 'anthropic') {
      const r = await fetch(`${base}/v1/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Accept': 'application/json' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!r.ok) {
        const text = (await r.text().catch(() => '')).slice(0, 300)
        return { ok: false, modelsCount: null, sample: [], error: `HTTP ${r.status}: ${text || r.statusText}` }
      }
      const data = await r.json().catch(() => ({})) as { data?: Array<{ id?: string }> }
      const models = Array.isArray(data.data) ? data.data : []
      return { ok: true, modelsCount: models.length, sample: models.slice(0, 8).map(m => String(m.id || '')) }
    }

    // openai
    const r = await fetch(`${base}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 300)
      return { ok: false, modelsCount: null, sample: [], error: `HTTP ${r.status}: ${text || r.statusText}` }
    }
    const data = await r.json().catch(() => ({})) as { data?: Array<{ id?: string }> }
    const models = Array.isArray(data.data) ? data.data : []
    return { ok: true, modelsCount: models.length, sample: models.slice(0, 8).map(m => String(m.id || '')) }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, modelsCount: null, sample: [], error: e instanceof Error ? e.message : String(e) }
  }
}
