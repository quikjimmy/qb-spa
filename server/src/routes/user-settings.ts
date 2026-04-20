import { Router, type Request, type Response } from 'express'
import db from '../db'
import { encryptSecret, decryptSecret, previewSecret } from '../lib/crypto'

const router = Router()

interface OllamaRow {
  user_id: number
  api_key_encrypted: string | null
  base_url: string
  last_tested_at: string | null
  last_test_ok: number | null
  last_test_error: string | null
  last_test_models_count: number | null
  updated_at: string
}

function getOllamaRow(userId: number): OllamaRow | undefined {
  return db.prepare(`SELECT * FROM user_ollama_config WHERE user_id = ?`).get(userId) as OllamaRow | undefined
}

function publicShape(row: OllamaRow | undefined, plaintextKey?: string | null) {
  if (!row) {
    return { connected: false, base_url: 'https://ollama.com', key_preview: null, last_tested_at: null, last_test_ok: null, last_test_error: null, last_test_models_count: null }
  }
  const plain = plaintextKey ?? (row.api_key_encrypted ? (() => { try { return decryptSecret(row.api_key_encrypted!) } catch { return '' } })() : '')
  return {
    connected: !!row.api_key_encrypted,
    base_url: row.base_url,
    key_preview: plain ? previewSecret(plain) : null,
    last_tested_at: row.last_tested_at,
    last_test_ok: row.last_test_ok === 1 ? true : row.last_test_ok === 0 ? false : null,
    last_test_error: row.last_test_error,
    last_test_models_count: row.last_test_models_count,
  }
}

// GET /api/user-settings/ollama — return current user's config (redacted)
router.get('/ollama', (req: Request, res: Response): void => {
  const row = getOllamaRow(req.user!.userId)
  res.json(publicShape(row))
})

// PUT /api/user-settings/ollama — set/update key + base_url
router.put('/ollama', (req: Request, res: Response): void => {
  const { api_key, base_url } = req.body as { api_key?: string; base_url?: string }
  const userId = req.user!.userId
  const url = (base_url || '').trim() || 'https://ollama.com'

  if (api_key !== undefined && api_key !== null) {
    if (typeof api_key !== 'string') { res.status(400).json({ error: 'api_key must be a string' }); return }
    const trimmed = api_key.trim()
    if (trimmed === '') {
      // blank key submitted with an update — clear it
      db.prepare(
        `INSERT INTO user_ollama_config (user_id, api_key_encrypted, base_url, updated_at)
         VALUES (?, NULL, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET api_key_encrypted=NULL, base_url=excluded.base_url, updated_at=datetime('now')`
      ).run(userId, url)
    } else {
      const encrypted = encryptSecret(trimmed)
      db.prepare(
        `INSERT INTO user_ollama_config (user_id, api_key_encrypted, base_url, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET api_key_encrypted=excluded.api_key_encrypted, base_url=excluded.base_url, updated_at=datetime('now')`
      ).run(userId, encrypted, url)
    }
  } else {
    // Only base_url change
    db.prepare(
      `INSERT INTO user_ollama_config (user_id, base_url, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET base_url=excluded.base_url, updated_at=datetime('now')`
    ).run(userId, url)
  }

  const row = getOllamaRow(userId)
  res.json(publicShape(row))
})

// DELETE /api/user-settings/ollama — clear key
router.delete('/ollama', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  db.prepare(`UPDATE user_ollama_config SET api_key_encrypted=NULL, updated_at=datetime('now') WHERE user_id = ?`).run(userId)
  const row = getOllamaRow(userId)
  res.json(publicShape(row))
})

// POST /api/user-settings/ollama/test — ping Ollama with the stored key
router.post('/ollama/test', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId
  const row = getOllamaRow(userId)
  if (!row || !row.api_key_encrypted) {
    res.status(400).json({ ok: false, error: 'No API key configured' }); return
  }

  let apiKey: string
  try {
    apiKey = decryptSecret(row.api_key_encrypted)
  } catch {
    res.status(500).json({ ok: false, error: 'Stored key could not be decrypted — re-enter it' }); return
  }

  const baseUrl = (row.base_url || 'https://ollama.com').replace(/\/+$/, '')
  // Ollama's standard list-models endpoint works for both cloud and self-hosted
  const testUrl = `${baseUrl}/api/tags`

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const r = await fetch(testUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    if (!r.ok) {
      const text = (await r.text()).slice(0, 500)
      const err = `HTTP ${r.status}: ${text || r.statusText}`
      db.prepare(
        `UPDATE user_ollama_config SET last_tested_at=datetime('now'), last_test_ok=0, last_test_error=?, last_test_models_count=NULL WHERE user_id = ?`
      ).run(err, userId)
      res.status(200).json({ ok: false, error: err })
      return
    }

    const data = await r.json().catch(() => ({}))
    const modelsCount = Array.isArray(data.models) ? data.models.length : null
    db.prepare(
      `UPDATE user_ollama_config SET last_tested_at=datetime('now'), last_test_ok=1, last_test_error=NULL, last_test_models_count=? WHERE user_id = ?`
    ).run(modelsCount, userId)
    res.json({ ok: true, models_count: modelsCount, sample: Array.isArray(data.models) ? data.models.slice(0, 8).map((m: Record<string, unknown>) => m.name || m.model) : [] })
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    db.prepare(
      `UPDATE user_ollama_config SET last_tested_at=datetime('now'), last_test_ok=0, last_test_error=?, last_test_models_count=NULL WHERE user_id = ?`
    ).run(err, userId)
    res.status(200).json({ ok: false, error: err })
  }
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
