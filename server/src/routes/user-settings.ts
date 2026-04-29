import { Router, type Request, type Response } from 'express'
import db from '../db'
import { encryptSecret, decryptSecret, previewSecret } from '../lib/crypto'
import { defaultBaseUrl, isSupportedProvider, listUserKeys, probeProvider, SUPPORTED_PROVIDERS, type ProviderKeyRow, type ProviderId } from '../lib/userProviderKeys'

const router = Router()

function publicKeyShape(row: ProviderKeyRow): Record<string, unknown> {
  let preview: string | null = null
  try { preview = previewSecret(decryptSecret(row.api_key_encrypted)) } catch { preview = null }
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    base_url: row.base_url,
    is_default: row.is_default === 1,
    key_preview: preview,
    last_tested_at: row.last_tested_at,
    last_test_ok: row.last_test_ok === 1 ? true : row.last_test_ok === 0 ? false : null,
    last_test_error: row.last_test_error,
    last_test_models_count: row.last_test_models_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// GET /api/user-settings/providers — list all keys for current user, grouped by provider
router.get('/providers', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const rows = listUserKeys(userId)
  const grouped: Record<string, Array<ReturnType<typeof publicKeyShape>>> = {}
  for (const p of SUPPORTED_PROVIDERS) grouped[p] = []
  for (const r of rows) {
    if (!grouped[r.provider]) grouped[r.provider] = []
    grouped[r.provider].push(publicKeyShape(r))
  }
  res.json({ providers: SUPPORTED_PROVIDERS, keys: grouped })
})

// POST /api/user-settings/providers/:provider/keys — add a new key
router.post('/providers/:provider/keys', (req: Request, res: Response): void => {
  const provider = String(req.params['provider'] || '')
  if (!isSupportedProvider(provider)) { res.status(400).json({ error: `Unsupported provider '${provider}'` }); return }
  const { api_key, base_url, label, make_default } = req.body as { api_key?: string; base_url?: string | null; label?: string; make_default?: boolean }
  const trimmed = (api_key || '').trim()
  if (!trimmed) { res.status(400).json({ error: 'api_key is required' }); return }

  const userId = req.user!.userId
  const url = (base_url || '').trim() || (provider === 'ollama' ? defaultBaseUrl(provider) : null)
  const lbl = (label || '').trim() || null
  const encrypted = encryptSecret(trimmed)

  const tx = db.transaction(() => {
    const existing = db.prepare(`SELECT COUNT(*) AS n FROM user_provider_keys WHERE user_id = ? AND provider = ?`).get(userId, provider) as { n: number }
    const shouldBeDefault = make_default === true || existing.n === 0
    if (shouldBeDefault) {
      db.prepare(`UPDATE user_provider_keys SET is_default = 0 WHERE user_id = ? AND provider = ?`).run(userId, provider)
    }
    const result = db.prepare(
      `INSERT INTO user_provider_keys (user_id, provider, label, api_key_encrypted, base_url, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, provider, lbl, encrypted, url, shouldBeDefault ? 1 : 0)
    return Number(result.lastInsertRowid)
  })
  const id = tx()
  const row = db.prepare(`SELECT * FROM user_provider_keys WHERE id = ?`).get(id) as ProviderKeyRow
  res.json(publicKeyShape(row))
})

// PATCH /api/user-settings/providers/keys/:id — update label/base_url, or set as default
router.patch('/providers/keys/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const userId = req.user!.userId
  const row = db.prepare(`SELECT * FROM user_provider_keys WHERE id = ? AND user_id = ?`).get(id, userId) as ProviderKeyRow | undefined
  if (!row) { res.status(404).json({ error: 'Key not found' }); return }

  const { label, base_url, make_default } = req.body as { label?: string | null; base_url?: string | null; make_default?: boolean }

  const tx = db.transaction(() => {
    if (make_default === true) {
      db.prepare(`UPDATE user_provider_keys SET is_default = 0 WHERE user_id = ? AND provider = ?`).run(userId, row.provider)
      db.prepare(`UPDATE user_provider_keys SET is_default = 1, updated_at = datetime('now') WHERE id = ?`).run(id)
    }
    if (label !== undefined) {
      db.prepare(`UPDATE user_provider_keys SET label = ?, updated_at = datetime('now') WHERE id = ?`).run((label || '').toString().trim() || null, id)
    }
    if (base_url !== undefined) {
      db.prepare(`UPDATE user_provider_keys SET base_url = ?, updated_at = datetime('now') WHERE id = ?`).run((base_url || '').toString().trim() || null, id)
    }
  })
  tx()

  const updated = db.prepare(`SELECT * FROM user_provider_keys WHERE id = ?`).get(id) as ProviderKeyRow
  res.json(publicKeyShape(updated))
})

// DELETE /api/user-settings/providers/keys/:id
router.delete('/providers/keys/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const userId = req.user!.userId
  const row = db.prepare(`SELECT * FROM user_provider_keys WHERE id = ? AND user_id = ?`).get(id, userId) as ProviderKeyRow | undefined
  if (!row) { res.status(404).json({ error: 'Key not found' }); return }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM user_provider_keys WHERE id = ?`).run(id)
    if (row.is_default === 1) {
      // Promote the most-recently-created remaining key for this provider, if any.
      const next = db.prepare(`SELECT id FROM user_provider_keys WHERE user_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1`).get(userId, row.provider) as { id: number } | undefined
      if (next) db.prepare(`UPDATE user_provider_keys SET is_default = 1 WHERE id = ?`).run(next.id)
    }
  })
  tx()
  res.json({ ok: true })
})

// POST /api/user-settings/providers/keys/:id/test — connectivity probe
router.post('/providers/keys/:id/test', async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params['id']), 10)
  const userId = req.user!.userId
  const row = db.prepare(`SELECT * FROM user_provider_keys WHERE id = ? AND user_id = ?`).get(id, userId) as ProviderKeyRow | undefined
  if (!row) { res.status(404).json({ ok: false, error: 'Key not found' }); return }
  if (!isSupportedProvider(row.provider)) { res.status(400).json({ ok: false, error: `Unsupported provider` }); return }

  let apiKey: string
  try { apiKey = decryptSecret(row.api_key_encrypted) }
  catch { res.status(500).json({ ok: false, error: 'Stored key could not be decrypted — re-enter it' }); return }

  const result = await probeProvider(row.provider as ProviderId, apiKey, row.base_url)
  db.prepare(
    `UPDATE user_provider_keys
        SET last_tested_at = datetime('now'),
            last_test_ok = ?,
            last_test_error = ?,
            last_test_models_count = ?
      WHERE id = ?`
  ).run(result.ok ? 1 : 0, result.ok ? null : (result.error || 'Unknown error'), result.modelsCount, id)

  res.json({ ok: result.ok, error: result.error, models_count: result.modelsCount, sample: result.sample })
})

// GET /api/user-settings/ollama/models — list models on the user's default Ollama account.
// Kept under the legacy path because user-agents.ts UI still calls it.
router.get('/ollama/models', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId
  const row = db.prepare(
    `SELECT api_key_encrypted, base_url FROM user_provider_keys
      WHERE user_id = ? AND provider = 'ollama' AND is_default = 1 LIMIT 1`
  ).get(userId) as { api_key_encrypted: string; base_url: string | null } | undefined
  if (!row) { res.status(400).json({ error: 'No Ollama key configured. Set one in Settings first.', needs_key: true }); return }
  let apiKey: string
  try { apiKey = decryptSecret(row.api_key_encrypted) }
  catch { res.status(500).json({ error: 'Stored key could not be decrypted — re-enter it in Settings.' }); return }

  const base = (row.base_url || 'https://ollama.com').replace(/\/+$/, '')
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const r = await fetch(`${base}/api/tags`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 500)
      res.status(200).json({ models: [], error: `HTTP ${r.status}: ${text}` }); return
    }
    const data = await r.json().catch(() => ({})) as { models?: Array<{ name?: string; model?: string; size?: number; modified_at?: string }> }
    const models = (data.models || [])
      .map(m => ({ name: String(m.name || m.model || ''), size: m.size ?? null, modified_at: m.modified_at ?? null }))
      .filter(m => m.name)
    res.json({ models })
  } catch (e) {
    res.status(200).json({ models: [], error: e instanceof Error ? e.message : String(e) })
  }
})

// GET /api/user-settings/usage — month-to-date LLM spend attributed to this user
// Combines two sources:
//   - agent_runs rows where user_id = me (manual agent triggers)
//   - user_llm_usage rows (chatbot + future per-user features)
// Cap resolution: user_budgets.monthly_cap_cents → otherwise null (no per-user cap set)
router.get('/usage', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const monthStart = `datetime('now', 'start of month')`

  const fromAgentRuns = db.prepare(
    `SELECT COALESCE(SUM(cost_cents),0) AS cents,
            COALESCE(SUM(tokens_in),0) AS tin,
            COALESCE(SUM(tokens_out),0) AS tout,
            COUNT(*) AS calls
       FROM agent_runs
      WHERE user_id = ? AND started_at >= ${monthStart}`
  ).get(userId) as { cents: number; tin: number; tout: number; calls: number }

  const fromLedger = db.prepare(
    `SELECT COALESCE(SUM(cost_cents),0) AS cents,
            COALESCE(SUM(tokens_in),0) AS tin,
            COALESCE(SUM(tokens_out),0) AS tout,
            COUNT(*) AS calls,
            COALESCE(SUM(CASE WHEN used_own_key = 1 THEN cost_cents ELSE 0 END),0) AS byok_cents,
            COALESCE(SUM(CASE WHEN used_own_key = 0 THEN cost_cents ELSE 0 END),0) AS platform_cents
       FROM user_llm_usage
      WHERE user_id = ? AND created_at >= ${monthStart}`
  ).get(userId) as { cents: number; tin: number; tout: number; calls: number; byok_cents: number; platform_cents: number }

  const byProvider = db.prepare(
    `SELECT provider,
            COALESCE(SUM(cost_cents),0) AS cents,
            COUNT(*) AS calls
       FROM user_llm_usage
      WHERE user_id = ? AND created_at >= ${monthStart}
      GROUP BY provider`
  ).all(userId) as Array<{ provider: string; cents: number; calls: number }>

  const budget = db.prepare(`SELECT monthly_cap_cents, byok_bypasses_cap FROM user_budgets WHERE user_id = ?`).get(userId) as { monthly_cap_cents: number | null; byok_bypasses_cap: number } | undefined

  // Spend that counts against the cap. If byok_bypasses_cap, only platform-key
  // spend counts. Agent-run spend is platform spend (it uses the global key).
  const bypassByok = (budget?.byok_bypasses_cap ?? 1) === 1
  const cappedCents = (fromAgentRuns.cents) + (bypassByok ? fromLedger.platform_cents : fromLedger.cents)

  res.json({
    month_to_date_cents: fromAgentRuns.cents + fromLedger.cents,
    counted_against_cap_cents: cappedCents,
    cap_cents: budget?.monthly_cap_cents ?? null,
    byok_bypasses_cap: bypassByok,
    tokens_in: fromAgentRuns.tin + fromLedger.tin,
    tokens_out: fromAgentRuns.tout + fromLedger.tout,
    calls: fromAgentRuns.calls + fromLedger.calls,
    breakdown: {
      agent_runs_cents: fromAgentRuns.cents,
      chatbot_byok_cents: fromLedger.byok_cents,
      chatbot_platform_cents: fromLedger.platform_cents,
      by_provider: byProvider,
    },
  })
})

// GET /api/user-settings/my-departments — departments the current user is in
router.get('/my-departments', (req: Request, res: Response): void => {
  const rows = db.prepare(
    `SELECT d.id, d.name, d.description
     FROM departments d
     JOIN user_departments ud ON ud.department_id = d.id
     WHERE ud.user_id = ?
     ORDER BY d.name`
  ).all(req.user!.userId)
  res.json({ departments: rows })
})

export { router as userSettingsRouter }
