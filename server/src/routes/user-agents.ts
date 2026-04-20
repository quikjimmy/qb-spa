import { Router, type Request, type Response } from 'express'
import db from '../db'
import { requireRole } from '../middleware/auth'
import { LLM_OPTIONS, isValidLlm, llmAvailableForTier } from '../lib/llm-options'

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

export { router as userAgentsRouter }
