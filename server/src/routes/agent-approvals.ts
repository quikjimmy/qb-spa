import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.user?.roles.includes('admin')) {
    res.status(403).json({ error: 'Admin only' })
    return false
  }
  return true
}

router.get('/', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const rows = db.prepare(
    `SELECT a.*, r.agent_role_id, ar.name AS role_name, t.name AS task_name
     FROM agent_approvals a
     JOIN agent_task_runs r ON r.id = a.task_run_id
     JOIN agent_roles ar ON ar.id = r.agent_role_id
     LEFT JOIN agent_role_tasks t ON t.id = r.task_id
     ORDER BY
       CASE a.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       a.requested_at DESC`
  ).all()
  res.json({ rows })
})

router.post('/:id/approve', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const note = String(req.body?.review_note || '')
  db.prepare(
    `UPDATE agent_approvals
     SET status = 'approved', reviewed_by_user_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(req.user!.userId, note || null, id)
  res.json({ ok: true })
})

router.post('/:id/reject', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const note = String(req.body?.review_note || '')
  db.prepare(
    `UPDATE agent_approvals
     SET status = 'rejected', reviewed_by_user_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(req.user!.userId, note || null, id)
  const approval = db.prepare(`SELECT task_run_id FROM agent_approvals WHERE id = ?`).get(id) as { task_run_id: number } | undefined
  if (approval) {
    db.prepare(`UPDATE agent_task_runs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP, error = ? WHERE id = ?`)
      .run('Approval rejected', approval.task_run_id)
  }
  res.json({ ok: true })
})

export { router as agentApprovalsRouter }

