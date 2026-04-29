import { Router, type Request, type Response } from 'express'
import db from '../db'
import { requireRole } from '../middleware/auth'
import { runFeedbackTriage } from '../agents/feedbackTriage'

const router = Router()

const VALID_STATUSES = ['new', 'triaged', 'in_build', 'shipped', 'dismissed'] as const
type FeedbackStatus = typeof VALID_STATUSES[number]

interface FeedbackRow {
  id: number
  user_id: number
  user_name: string | null
  user_email: string | null
  path: string
  category: string | null
  body: string
  status: string
  triaged_by: number | null
  triaged_by_name: string | null
  triaged_at: string | null
  triage_note: string | null
  cluster_id: number | null
  created_at: string
}

// POST /api/feedback — any authenticated user
router.post('/', (req: Request, res: Response): void => {
  const { path, category, body } = req.body as { path?: string; category?: string; body?: string }
  if (!path || !body || !body.trim()) {
    res.status(400).json({ error: 'path and body are required' })
    return
  }
  const userId = req.user!.userId
  const cat = category && ['bug', 'idea', 'question'].includes(category) ? category : null
  const result = db.prepare(
    `INSERT INTO app_feedback (user_id, path, category, body) VALUES (?, ?, ?, ?)`
  ).run(userId, path.slice(0, 300), cat, body.slice(0, 4000))
  res.json({ ok: true, id: Number(result.lastInsertRowid) })
})

// GET /api/feedback — admin only; list + filter
router.get('/', requireRole('admin'), (req: Request, res: Response): void => {
  const status = req.query['status'] as string | undefined
  const category = req.query['category'] as string | undefined
  const path = req.query['path'] as string | undefined

  const where: string[] = []
  const params: unknown[] = []
  if (status && VALID_STATUSES.includes(status as FeedbackStatus)) { where.push('f.status = ?'); params.push(status) }
  if (category) { where.push('f.category = ?'); params.push(category) }
  if (path) { where.push('f.path = ?'); params.push(path) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const rows = db.prepare(
    `SELECT f.*, u.name AS user_name, u.email AS user_email,
            t.name AS triaged_by_name
     FROM app_feedback f
     LEFT JOIN users u ON u.id = f.user_id
     LEFT JOIN users t ON t.id = f.triaged_by
     ${whereSql}
     ORDER BY f.created_at DESC`
  ).all(...params) as FeedbackRow[]

  // Lightweight status counts for filter chips
  const counts = db.prepare(
    `SELECT status, COUNT(*) AS n FROM app_feedback GROUP BY status`
  ).all() as Array<{ status: string; n: number }>

  res.json({ rows, counts })
})

// PATCH /api/feedback/:id — admin only; change status / triage note
router.patch('/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  if (!id) { res.status(400).json({ error: 'invalid id' }); return }
  const { status, triage_note } = req.body as { status?: string; triage_note?: string }

  const sets: string[] = []
  const params: unknown[] = []
  if (status) {
    if (!VALID_STATUSES.includes(status as FeedbackStatus)) {
      res.status(400).json({ error: 'invalid status' }); return
    }
    sets.push('status = ?'); params.push(status)
    sets.push('triaged_by = ?'); params.push(req.user!.userId)
    sets.push(`triaged_at = datetime('now')`)
  }
  if (typeof triage_note === 'string') {
    sets.push('triage_note = ?'); params.push(triage_note.slice(0, 2000))
  }
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }

  params.push(id)
  const result = db.prepare(`UPDATE app_feedback SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  if (result.changes === 0) { res.status(404).json({ error: 'not found' }); return }
  res.json({ ok: true })
})

// POST /api/feedback/triage/run — admin only; cluster unclustered feedback + draft proposals
router.post('/triage/run', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  try {
    const summary = await runFeedbackTriage({ triggeredBy: req.user!.userId })
    res.json({ ok: true, summary })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'triage failed' })
  }
})

// GET /api/feedback/triage/runs — admin only; recent triage run history
router.get('/triage/runs', requireRole('admin'), (_req: Request, res: Response): void => {
  const rows = db.prepare(
    `SELECT r.*, u.name AS triggered_by_name
     FROM feedback_triage_runs r
     LEFT JOIN users u ON u.id = r.triggered_by
     ORDER BY r.started_at DESC
     LIMIT 20`
  ).all()
  res.json({ rows })
})

export { router as feedbackRouter }
