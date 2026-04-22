import { Router, type Request, type Response } from 'express'
import db from '../db'
import { runHoldClassifier, HOLD_AGENT_NAME } from '../agents/runner'
import { classifyHoldProject, type HoldProject } from '../agents/holdClassifier'
import { fetchProjectNotes } from '../agents/notesFetcher'
import { dispatchRoleTask } from '../agents/taskDispatcher'

const router = Router()

interface AgentRunRow {
  id: number
  agent: string
  trigger: string
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  projects_scanned: number
  projects_classified: number
  projects_skipped: number
  tokens_in: number
  tokens_out: number
  cost_cents: number
  model: string | null
  error: string | null
}

interface AgentOutputRow {
  id: number
  agent: string
  project_id: number
  run_id: number | null
  payload_json: string
  input_hash: string
  generated_at: string
}

router.get('/runs', (req: Request, res: Response): void => {
  const agent = req.query['agent'] as string | undefined
  const status = req.query['status'] as string | undefined
  const limit = Math.min(parseInt(req.query['limit'] as string) || 100, 500)

  const where: string[] = []
  const params: unknown[] = []
  if (agent) { where.push('agent = ?'); params.push(agent) }
  if (status) { where.push('status = ?'); params.push(status) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const rows = db.prepare(
    `SELECT * FROM agent_runs ${clause} ORDER BY started_at DESC LIMIT ?`
  ).all(...params, limit) as AgentRunRow[]

  res.json({ runs: rows })
})

router.get('/outputs', (req: Request, res: Response): void => {
  const agent = req.query['agent'] as string | undefined
  const projectId = req.query['project_id'] as string | undefined
  const limit = Math.min(parseInt(req.query['limit'] as string) || 500, 2000)

  const where: string[] = []
  const params: unknown[] = []
  if (agent) { where.push('agent = ?'); params.push(agent) }
  if (projectId) { where.push('project_id = ?'); params.push(parseInt(projectId)) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const rows = db.prepare(
    `SELECT * FROM agent_outputs ${clause} ORDER BY generated_at DESC LIMIT ?`
  ).all(...params, limit) as AgentOutputRow[]

  const outputs = rows.map(r => ({
    id: r.id,
    agent: r.agent,
    project_id: r.project_id,
    run_id: r.run_id,
    generated_at: r.generated_at,
    payload: JSON.parse(r.payload_json),
  }))

  res.json({ outputs })
})

router.post('/hold-classifier/dry-run', async (req: Request, res: Response): Promise<void> => {
  const projectId = parseInt(req.body?.project_id)
  if (!projectId) { res.status(400).json({ error: 'project_id required' }); return }

  const project = db.prepare(
    `SELECT record_id, customer_name, status, state, system_size_kw, sales_date, lender, coordinator,
            intake_completed, survey_submitted, survey_approved, design_completed,
            nem_submitted, nem_approved, nem_rejected, permit_submitted, permit_approved, permit_rejected,
            install_scheduled, install_completed, inspection_scheduled, inspection_passed,
            pto_submitted, pto_approved
       FROM project_cache WHERE record_id = ?`
  ).get(projectId) as HoldProject | undefined

  if (!project) { res.status(404).json({ error: `project ${projectId} not in cache` }); return }

  try {
    const notes = await fetchProjectNotes(projectId, 90)
    const result = await classifyHoldProject(project, notes)
    res.json({
      ok: true,
      project: { record_id: project.record_id, customer_name: project.customer_name, status: project.status },
      notes_count: notes.length,
      notes_preview: notes.slice(0, 5).map(n => ({ record_id: n.record_id, date: n.date, category: n.category, text: n.text.slice(0, 120) })),
      classification: result.classification,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
      cost_cents: result.cost_cents,
      model: result.model,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

router.post('/hold-classifier/run', async (_req: Request, res: Response): Promise<void> => {
  try {
    const role = db.prepare(`SELECT id FROM agent_roles WHERE slug = 'pc-risk-hold-worker'`).get() as { id: number } | undefined
    const task = db.prepare(`SELECT id FROM agent_role_tasks WHERE agent_role_id = ? AND name = 'Hold classification'`).get(role?.id || 0) as { id: number } | undefined
    if (role && task) {
      const result = await dispatchRoleTask({
        agentRoleId: role.id,
        taskId: task.id,
        trigger: 'manual',
        payload: { source: 'legacy_admin_route' },
      })
      res.json({ ok: true, agent: HOLD_AGENT_NAME, migrated: true, ...result })
      return
    }
    const fallback = await runHoldClassifier('manual')
    res.json({ ok: true, agent: HOLD_AGENT_NAME, migrated: false, ...fallback })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

router.get('/budget', (_req: Request, res: Response): void => {
  const row = db.prepare(
    `SELECT agent, COALESCE(SUM(cost_cents),0) AS spent_cents
       FROM agent_runs
      WHERE started_at >= datetime('now', 'start of month')
      GROUP BY agent`
  ).all() as Array<{ agent: string; spent_cents: number }>
  const cap = Math.round(parseFloat(process.env['AGENT_MONTHLY_CAP_USD'] || '5') * 100)
  res.json({ cap_cents: cap, by_agent: row })
})

export { router as agentsRouter }
