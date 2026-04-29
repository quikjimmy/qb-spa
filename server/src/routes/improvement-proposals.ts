import { Router, type Request, type Response } from 'express'
import db from '../db'
import { requireRole } from '../middleware/auth'

const router = Router()

const VALID_STATUSES = [
  'awaiting_approval',
  'approved',
  'scheduled',
  'in_build',
  'shipped',
  'rejected',
] as const
type ProposalStatus = typeof VALID_STATUSES[number]

interface ProposalRow {
  id: number
  cluster_id: number
  scope_md: string
  files_touched_json: string
  effort_estimate: string | null
  risk_notes: string | null
  status: string
  approved_by: number | null
  approved_by_name: string | null
  approved_at: string | null
  rejection_reason: string | null
  target_release: string | null
  triage_run_id: number | null
  model: string | null
  created_at: string
  updated_at: string
  cluster_title: string
  cluster_summary: string
  cluster_theme: string | null
  cluster_status: string
  cluster_item_count: number
  cluster_first_seen: string | null
  cluster_last_seen: string | null
}

interface MemberRow {
  id: number
  cluster_id: number
  path: string
  category: string | null
  body: string
  status: string
  user_name: string | null
  user_email: string | null
  created_at: string
}

// GET /api/improvement-proposals — admin only; list proposals with their cluster + members
router.get('/', requireRole('admin'), (req: Request, res: Response): void => {
  const status = req.query['status'] as string | undefined

  const where: string[] = []
  const params: unknown[] = []
  if (status && VALID_STATUSES.includes(status as ProposalStatus)) {
    where.push('p.status = ?')
    params.push(status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const proposals = db.prepare(
    `SELECT p.*,
            u.name AS approved_by_name,
            c.title AS cluster_title,
            c.summary AS cluster_summary,
            c.theme AS cluster_theme,
            c.status AS cluster_status,
            c.item_count AS cluster_item_count,
            c.first_seen AS cluster_first_seen,
            c.last_seen AS cluster_last_seen
     FROM improvement_proposals p
     JOIN feedback_clusters c ON c.id = p.cluster_id
     LEFT JOIN users u ON u.id = p.approved_by
     ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT 200`
  ).all(...params) as ProposalRow[]

  const clusterIds = proposals.map(p => p.cluster_id)
  const placeholders = clusterIds.length ? clusterIds.map(() => '?').join(',') : 'NULL'
  const members = clusterIds.length
    ? db.prepare(
        `SELECT f.id, f.cluster_id, f.path, f.category, f.body, f.status, f.created_at,
                u.name AS user_name, u.email AS user_email
         FROM app_feedback f
         LEFT JOIN users u ON u.id = f.user_id
         WHERE f.cluster_id IN (${placeholders})
         ORDER BY f.created_at DESC`
      ).all(...clusterIds) as MemberRow[]
    : []

  const membersByCluster = new Map<number, MemberRow[]>()
  for (const m of members) {
    const list = membersByCluster.get(m.cluster_id) || []
    list.push(m)
    membersByCluster.set(m.cluster_id, list)
  }

  const counts = db.prepare(
    `SELECT status, COUNT(*) AS n FROM improvement_proposals GROUP BY status`
  ).all() as Array<{ status: string; n: number }>

  const rows = proposals.map(p => ({
    ...p,
    files_touched: JSON.parse(p.files_touched_json || '[]') as string[],
    members: membersByCluster.get(p.cluster_id) || [],
  }))

  res.json({ rows, counts })
})

// PATCH /api/improvement-proposals/:id — admin only; approve / reject / edit scope
router.patch('/:id', requireRole('admin'), (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  if (!id) { res.status(400).json({ error: 'invalid id' }); return }

  const { status, scope_md, files_touched, effort_estimate, risk_notes, rejection_reason, target_release } =
    req.body as {
      status?: string
      scope_md?: string
      files_touched?: string[]
      effort_estimate?: string
      risk_notes?: string
      rejection_reason?: string
      target_release?: string
    }

  const sets: string[] = []
  const params: unknown[] = []

  if (status) {
    if (!VALID_STATUSES.includes(status as ProposalStatus)) {
      res.status(400).json({ error: 'invalid status' }); return
    }
    sets.push('status = ?'); params.push(status)
    if (status === 'approved') {
      sets.push('approved_by = ?'); params.push(req.user!.userId)
      sets.push(`approved_at = datetime('now')`)
    }
  }
  if (typeof scope_md === 'string') {
    sets.push('scope_md = ?'); params.push(scope_md.slice(0, 8000))
  }
  if (Array.isArray(files_touched)) {
    sets.push('files_touched_json = ?'); params.push(JSON.stringify(files_touched.slice(0, 30)))
  }
  if (typeof effort_estimate === 'string' && ['S', 'M', 'L'].includes(effort_estimate)) {
    sets.push('effort_estimate = ?'); params.push(effort_estimate)
  }
  if (typeof risk_notes === 'string') {
    sets.push('risk_notes = ?'); params.push(risk_notes.slice(0, 2000))
  }
  if (typeof rejection_reason === 'string') {
    sets.push('rejection_reason = ?'); params.push(rejection_reason.slice(0, 2000))
  }
  if (typeof target_release === 'string') {
    sets.push('target_release = ?'); params.push(target_release.slice(0, 80))
  }

  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }
  sets.push(`updated_at = datetime('now')`)

  params.push(id)
  const result = db.prepare(
    `UPDATE improvement_proposals SET ${sets.join(', ')} WHERE id = ?`
  ).run(...params)

  if (result.changes === 0) { res.status(404).json({ error: 'not found' }); return }

  // When a proposal is approved/scheduled, mark its member feedback as in_build.
  // When shipped, mark them as shipped. This keeps the per-feedback queue in sync
  // with the cluster-level lifecycle so admins don't have to touch both.
  if (status === 'approved' || status === 'scheduled' || status === 'in_build') {
    db.prepare(
      `UPDATE app_feedback
         SET status = 'in_build'
       WHERE cluster_id = (SELECT cluster_id FROM improvement_proposals WHERE id = ?)
         AND status IN ('new', 'triaged')`
    ).run(id)
  } else if (status === 'shipped') {
    db.prepare(
      `UPDATE app_feedback
         SET status = 'shipped'
       WHERE cluster_id = (SELECT cluster_id FROM improvement_proposals WHERE id = ?)
         AND status NOT IN ('shipped', 'dismissed')`
    ).run(id)
  } else if (status === 'rejected') {
    db.prepare(
      `UPDATE feedback_clusters SET status = 'rejected', updated_at = datetime('now')
       WHERE id = (SELECT cluster_id FROM improvement_proposals WHERE id = ?)`
    ).run(id)
  }

  res.json({ ok: true })
})

export { router as improvementProposalsRouter }
