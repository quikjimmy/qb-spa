import { Router, type Request, type Response } from 'express'
import db from '../db'
import { requireRole } from '../middleware/auth'
import { LLM_OPTIONS, isValidLlm, llmAvailableForTier, ollamaModelFor } from '../lib/llm-options'
import { decryptSecret } from '../lib/crypto'
import { ollamaChat } from '../agents/ollamaChat'

const router = Router()

const STATUSES = ['draft', 'submitted', 'approved', 'paused', 'retired'] as const
type AgentStatus = typeof STATUSES[number]

const DEFAULT_FREE_CAP = 50_000       // tokens/month while in draft / ollama-free
const DEFAULT_COMPANY_CAP = 500_000    // tokens/month once approved → company tier

interface UserAgentRow {
  id: number
  user_id: number
  name: string
  objective: string
  llm: string
  monthly_token_cap: number
  tokens_used_month: number
  tier: 'ollama-free' | 'company'
  status: AgentStatus
  department: string | null
  submission_note: string | null
  approved_by: number | null
  approved_at: string | null
  created_at: string
  updated_at: string
}

function ensureUserBudget(userId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO user_budgets (user_id, monthly_token_cap) VALUES (?, ?)`
  ).run(userId, DEFAULT_FREE_CAP)
}

// GET /api/user-agents/llms — fixed list for dropdown
router.get('/llms', (_req: Request, res: Response): void => {
  res.json({ options: LLM_OPTIONS })
})

// GET /api/user-agents/my-budget — current user's aggregate budget
router.get('/my-budget', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  ensureUserBudget(userId)
  const b = db.prepare(
    `SELECT monthly_token_cap, tokens_used_month, tier, updated_at FROM user_budgets WHERE user_id = ?`
  ).get(userId)
  res.json({ budget: b })
})

// GET /api/user-agents/mine — list current user's agents
router.get('/mine', (req: Request, res: Response): void => {
  const rows = db.prepare(
    `SELECT * FROM user_agents WHERE user_id = ? ORDER BY updated_at DESC`
  ).all(req.user!.userId)
  res.json({ rows })
})

// POST /api/user-agents — create a draft
router.post('/', (req: Request, res: Response): void => {
  const { name, objective, llm, department } = req.body as {
    name?: string; objective?: string; llm?: string; department?: string
  }
  if (!name?.trim() || !objective?.trim() || !llm) {
    res.status(400).json({ error: 'name, objective, and llm are required' }); return
  }
  if (!isValidLlm(llm)) {
    res.status(400).json({ error: 'unknown llm' }); return
  }
  if (!llmAvailableForTier(llm, 'ollama-free')) {
    res.status(400).json({ error: 'this llm is not available on the free tier; submit for approval first' }); return
  }
  const result = db.prepare(
    `INSERT INTO user_agents (user_id, name, objective, llm, monthly_token_cap, department)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.user!.userId, name.trim().slice(0, 120), objective.trim().slice(0, 2000), llm, DEFAULT_FREE_CAP, department?.trim() || null)
  res.json({ ok: true, id: Number(result.lastInsertRowid) })
})

// PATCH /api/user-agents/:id — edit a draft (owner only)
router.patch('/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.user_id !== req.user!.userId && !req.user!.roles.includes('admin')) {
    res.status(403).json({ error: 'forbidden' }); return
  }
  if (row.status !== 'draft') {
    res.status(400).json({ error: 'only drafts can be edited' }); return
  }
  const { name, objective, llm, department } = req.body as {
    name?: string; objective?: string; llm?: string; department?: string
  }
  const sets: string[] = []
  const params: unknown[] = []
  if (name !== undefined) { sets.push('name = ?'); params.push(name.trim().slice(0, 120)) }
  if (objective !== undefined) { sets.push('objective = ?'); params.push(objective.trim().slice(0, 2000)) }
  if (llm !== undefined) {
    if (!isValidLlm(llm)) { res.status(400).json({ error: 'unknown llm' }); return }
    sets.push('llm = ?'); params.push(llm)
  }
  if (department !== undefined) { sets.push('department = ?'); params.push(department?.trim() || null) }
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }
  sets.push(`updated_at = datetime('now')`)
  params.push(id)
  db.prepare(`UPDATE user_agents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  res.json({ ok: true })
})

// POST /api/user-agents/:id/submit — owner submits draft for review
router.post('/:id/submit', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const { submission_note } = req.body as { submission_note?: string }
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.user_id !== req.user!.userId) { res.status(403).json({ error: 'forbidden' }); return }
  if (row.status !== 'draft') { res.status(400).json({ error: 'only drafts can be submitted' }); return }
  db.prepare(
    `UPDATE user_agents SET status='submitted', submission_note=?, updated_at=datetime('now') WHERE id = ?`
  ).run(submission_note?.slice(0, 2000) || null, id)
  res.json({ ok: true })
})

// GET /api/user-agents — admin only; list all (filter by status)
router.get('/', requireRole('admin'), (req: Request, res: Response): void => {
  const status = req.query['status'] as string | undefined
  const where: string[] = []
  const params: unknown[] = []
  if (status && STATUSES.includes(status as AgentStatus)) { where.push('a.status = ?'); params.push(status) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(
    `SELECT a.*, u.name AS owner_name, u.email AS owner_email
     FROM user_agents a
     LEFT JOIN users u ON u.id = a.user_id
     ${whereSql}
     ORDER BY a.updated_at DESC`
  ).all(...params)
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM user_agents GROUP BY status`).all()
  res.json({ rows, counts })
})

// POST /api/user-agents/:id/approve — admin only; promotes to company tier
router.post('/:id/approve', requireRole('admin'), (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.status !== 'submitted') { res.status(400).json({ error: 'agent must be submitted to approve' }); return }
  db.prepare(
    `UPDATE user_agents SET status='approved', tier='company', monthly_token_cap=?,
            approved_by=?, approved_at=datetime('now'), updated_at=datetime('now')
     WHERE id = ?`
  ).run(DEFAULT_COMPANY_CAP, req.user!.userId, id)
  res.json({ ok: true })
})

// POST /api/user-agents/:id/reject — admin only; returns to draft with a note
router.post('/:id/reject', requireRole('admin'), (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const { note } = req.body as { note?: string }
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.status !== 'submitted') { res.status(400).json({ error: 'agent must be submitted to reject' }); return }
  db.prepare(
    `UPDATE user_agents SET status='draft', submission_note=?, updated_at=datetime('now') WHERE id = ?`
  ).run(note?.slice(0, 2000) || null, id)
  res.json({ ok: true })
})

// POST /api/user-agents/:id/pause — owner or admin; pauses an approved agent
router.post('/:id/pause', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.user_id !== req.user!.userId && !req.user!.roles.includes('admin')) {
    res.status(403).json({ error: 'forbidden' }); return
  }
  if (!['approved'].includes(row.status)) { res.status(400).json({ error: 'only approved agents can be paused' }); return }
  db.prepare(`UPDATE user_agents SET status='paused', updated_at=datetime('now') WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// POST /api/user-agents/:id/resume — owner or admin
router.post('/:id/resume', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.user_id !== req.user!.userId && !req.user!.roles.includes('admin')) {
    res.status(403).json({ error: 'forbidden' }); return
  }
  if (row.status !== 'paused') { res.status(400).json({ error: 'only paused agents can be resumed' }); return }
  db.prepare(`UPDATE user_agents SET status='approved', updated_at=datetime('now') WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// POST /api/user-agents/:id/retire — owner or admin; permanent stop
router.post('/:id/retire', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.user_id !== req.user!.userId && !req.user!.roles.includes('admin')) {
    res.status(403).json({ error: 'forbidden' }); return
  }
  db.prepare(`UPDATE user_agents SET status='retired', updated_at=datetime('now') WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// DELETE /api/user-agents/:id — owner can delete own drafts only
router.delete('/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const row = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!row) { res.status(404).json({ error: 'not found' }); return }
  if (row.user_id !== req.user!.userId && !req.user!.roles.includes('admin')) {
    res.status(403).json({ error: 'forbidden' }); return
  }
  if (row.status !== 'draft' && !req.user!.roles.includes('admin')) {
    res.status(400).json({ error: 'only drafts can be deleted by owner' }); return
  }
  db.prepare(`DELETE FROM user_agents WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// GET /api/user-agents/:id/runs — last N runs for a user agent
router.get('/:id/runs', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  const agent = db.prepare(`SELECT user_id FROM user_agents WHERE id = ?`).get(id) as { user_id: number } | undefined
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  if (agent.user_id !== req.user!.userId && !req.user!.roles.includes('admin')) {
    res.status(403).json({ error: 'Not your agent' }); return
  }
  const limit = Math.min(parseInt(String(req.query['limit'] || '20'), 10) || 20, 100)
  const rows = db.prepare(
    `SELECT id, status, trigger, model, prompt, output, error,
            tokens_in, tokens_out, duration_ms, started_at, finished_at
     FROM agent_runs
     WHERE agent = ?
     ORDER BY started_at DESC
     LIMIT ?`
  ).all(`user-agent-${id}`, limit)
  res.json({ rows })
})

// ── Run Once ─────────────────────────────────────────────
// Sends the agent's objective straight to Ollama as a single user message,
// returns the response + token counts, logs to agent_runs, and increments
// both the per-agent and per-user token counters. Soft-capped output so a
// runaway prompt can't drain the whole budget in a single click.

router.post('/:id/run-once', async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params['id']), 10)
  const userId = req.user!.userId
  const { prompt: promptOverride } = (req.body || {}) as { prompt?: string }

  const agent = db.prepare(`SELECT * FROM user_agents WHERE id = ?`).get(id) as UserAgentRow | undefined
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  if (agent.user_id !== userId) { res.status(403).json({ error: 'Not your agent' }); return }
  // Owners can iterate while in any status except 'retired'. Draft is the
  // sandbox, submitted still accepts tests while admin reviews, approved is
  // production, paused stops *automatic* runs but allows manual.
  if (agent.status === 'retired') {
    res.status(400).json({ error: 'Retired agents cannot be run.' }); return
  }
  const effectivePrompt = (promptOverride && promptOverride.trim()) ? promptOverride.trim() : agent.objective

  // Budget checks — both the agent cap and the user-wide cap must allow the run.
  ensureUserBudget(userId)
  const userBudget = db.prepare(
    `SELECT monthly_token_cap, tokens_used_month FROM user_budgets WHERE user_id = ?`
  ).get(userId) as { monthly_token_cap: number; tokens_used_month: number }
  if (agent.tokens_used_month >= agent.monthly_token_cap) {
    res.status(403).json({ error: `Agent has hit its monthly cap (${agent.monthly_token_cap.toLocaleString()} tokens).` }); return
  }
  if (userBudget.tokens_used_month >= userBudget.monthly_token_cap) {
    res.status(403).json({ error: `Your account has hit its monthly cap (${userBudget.monthly_token_cap.toLocaleString()} tokens).` }); return
  }

  // Load + decrypt the user's Ollama key.
  const cfg = db.prepare(
    `SELECT api_key_encrypted, base_url FROM user_ollama_config WHERE user_id = ?`
  ).get(userId) as { api_key_encrypted: string | null; base_url: string } | undefined
  if (!cfg || !cfg.api_key_encrypted) {
    res.status(400).json({ error: 'No Ollama key configured. Set one in Settings first.', needs_key: true }); return
  }
  let apiKey: string
  try { apiKey = decryptSecret(cfg.api_key_encrypted) }
  catch { res.status(500).json({ error: 'Stored key could not be decrypted — re-enter it in Settings.' }); return }

  const modelName = ollamaModelFor(agent.llm)
  if (!modelName) { res.status(400).json({ error: `Unknown LLM '${agent.llm}' — edit the agent and pick one from the list.` }); return }

  // Register the run row up-front so we can track in-progress + failures.
  const runInsert = db.prepare(
    `INSERT INTO agent_runs (agent, trigger, status, model, prompt) VALUES (?, 'manual', 'running', ?, ?)`
  ).run(`user-agent-${agent.id}`, modelName, effectivePrompt.slice(0, 8000))
  const runId = Number(runInsert.lastInsertRowid)

  const result = await ollamaChat({
    baseUrl: cfg.base_url || 'https://ollama.com',
    apiKey,
    model: modelName,
    messages: [
      { role: 'system', content: `You are a user-built agent. Your objective: ${agent.objective}` },
      { role: 'user', content: effectivePrompt },
    ],
    maxOutputTokens: 500,
    timeoutMs: 30_000,
  })

  if (!result.ok) {
    db.prepare(
      `UPDATE agent_runs SET status='failed', finished_at=datetime('now'),
              duration_ms=?, error=? WHERE id = ?`
    ).run(result.duration_ms ?? 0, (result.error || '').slice(0, 1000), runId)
    res.status(200).json({ ok: false, error: result.error, run_id: runId })
    return
  }

  const tokensIn = result.tokens_in || 0
  const tokensOut = result.tokens_out || 0
  const totalTokens = tokensIn + tokensOut

  const commit = db.transaction(() => {
    db.prepare(
      `UPDATE agent_runs SET status='completed', finished_at=datetime('now'),
              duration_ms=?, tokens_in=?, tokens_out=?, output=? WHERE id = ?`
    ).run(result.duration_ms ?? 0, tokensIn, tokensOut, (result.output || '').slice(0, 16_000), runId)
    db.prepare(
      `UPDATE user_agents SET tokens_used_month = tokens_used_month + ?,
              updated_at=datetime('now') WHERE id = ?`
    ).run(totalTokens, agent.id)
    db.prepare(
      `UPDATE user_budgets SET tokens_used_month = tokens_used_month + ?,
              updated_at=datetime('now') WHERE user_id = ?`
    ).run(totalTokens, userId)
  })
  commit()

  res.json({
    ok: true,
    run_id: runId,
    output: result.output,
    model: modelName,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    duration_ms: result.duration_ms,
  })
})

export { router as userAgentsRouter }
