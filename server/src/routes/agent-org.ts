import { Router, type Request, type Response } from 'express'
import db from '../db'
import { dispatchRoleTask, routeAriRequest } from '../agents/taskDispatcher'
import { reloadAgentScheduler } from '../agents/scheduler'
import { proposeTaskPatch, reviewTaskPatch } from '../agents/taskCompliance'
import { decryptSecret } from '../lib/crypto'
import { ollamaChat } from '../agents/ollamaChat'
import { ollamaModelFor } from '../lib/llm-options'
import { executeRoleTask, getRoleForRun } from '../agents/roleRunner'

const router = Router()

function isAdmin(req: Request): boolean {
  return !!req.user?.roles.includes('admin')
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!isAdmin(req)) {
    res.status(403).json({ error: 'Admin only' })
    return false
  }
  return true
}

interface RoleRow {
  id: number
  name: string
  slug: string
  description: string | null
  objective: string
  execution_mode: string
  parent_role_id: number | null
  department: string | null
  status: string
  llm: string
  monthly_token_cap: number
  tokens_used_month: number
  approval_required: number
  is_lab_only: number
}

function listRoleHierarchy() {
  const roles = db.prepare(
    `SELECT *
     FROM agent_roles
     WHERE is_lab_only = 0
     ORDER BY COALESCE(parent_role_id, 0), name`
  ).all() as RoleRow[]

  const goals = db.prepare(`SELECT * FROM agent_goals WHERE status != 'archived' ORDER BY priority ASC, id ASC`).all() as Array<Record<string, unknown>>
  const tasks = db.prepare(
    `SELECT t.*, s.id AS schedule_id, s.cron_expr, s.timezone, s.enabled AS schedule_enabled, s.last_run_at, s.next_run_at
     FROM agent_role_tasks t
     LEFT JOIN agent_task_schedules s ON s.task_id = t.id
     ORDER BY t.id ASC`
  ).all() as Array<Record<string, unknown>>
  const latestRuns = db.prepare(
    `SELECT r1.*
     FROM agent_task_runs r1
     JOIN (
       SELECT agent_role_id, MAX(created_at) AS max_created_at
       FROM agent_task_runs
       GROUP BY agent_role_id
     ) latest
       ON latest.agent_role_id = r1.agent_role_id AND latest.max_created_at = r1.created_at`
  ).all() as Array<Record<string, unknown>>
  const approvals = db.prepare(
    `SELECT tr.agent_role_id, COUNT(*) AS pending_count
     FROM agent_approvals a
     JOIN agent_task_runs tr ON tr.id = a.task_run_id
     WHERE a.status = 'pending'
     GROUP BY tr.agent_role_id`
  ).all() as Array<{ agent_role_id: number; pending_count: number }>

  const tasksByRole = new Map<number, Array<Record<string, unknown>>>()
  for (const task of tasks) {
    const roleId = Number(task['agent_role_id'])
    if (!tasksByRole.has(roleId)) tasksByRole.set(roleId, [])
    tasksByRole.get(roleId)!.push(task)
  }
  const goalsByRole = new Map<number, Array<Record<string, unknown>>>()
  for (const goal of goals) {
    const roleId = Number(goal['agent_role_id'])
    if (!goalsByRole.has(roleId)) goalsByRole.set(roleId, [])
    goalsByRole.get(roleId)!.push(goal)
  }
  const latestRunByRole = new Map<number, Record<string, unknown>>()
  for (const run of latestRuns) latestRunByRole.set(Number(run['agent_role_id']), run)
  const approvalsByRole = new Map<number, number>()
  for (const row of approvals) approvalsByRole.set(row.agent_role_id, row.pending_count)

  const nodeById = new Map<number, Record<string, unknown>>()
  const nodes = roles.map(role => {
    const node: Record<string, unknown> = {
      ...role,
      goals: goalsByRole.get(role.id) || [],
      tasks: tasksByRole.get(role.id) || [],
      latest_run: latestRunByRole.get(role.id) || null,
      pending_approvals: approvalsByRole.get(role.id) || 0,
      children: [],
    }
    nodeById.set(role.id, node)
    return node
  })

  const roots: Record<string, unknown>[] = []
  for (const node of nodes) {
    const parentId = Number(node['parent_role_id'] || 0)
    if (parentId && nodeById.has(parentId)) {
      (nodeById.get(parentId)!['children'] as Array<Record<string, unknown>>).push(node)
    } else {
      roots.push(node)
    }
  }

  return { roots, flat: nodes }
}

function ensurePcDigestDeliveryConfig(taskId: number): number {
  const existing = db.prepare(
    `SELECT id FROM agent_delivery_configs
     WHERE task_id = ? AND audience_type = 'department' AND audience_value = 'PC' AND channel = 'agent_ops_inbox'
     ORDER BY id LIMIT 1`
  ).get(taskId) as { id: number } | undefined
  if (existing) return existing.id
  return Number(db.prepare(
    `INSERT INTO agent_delivery_configs
       (task_id, name, audience_type, audience_value, channel, enabled, approval_required, updated_at)
     VALUES (?, ?, 'department', 'PC', 'agent_ops_inbox', 1, 0, CURRENT_TIMESTAMP)`
  ).run(taskId, 'PC Daily Coordinator Digest').lastInsertRowid)
}

function listPcDigestRecipients(configId: number): Array<{ user_id: number; name: string; email: string; qb_coordinator_name: string; qb_coordinator_email: string }> {
  const rows = db.prepare(
    `SELECT u.id AS user_id,
            u.name,
            LOWER(TRIM(u.email)) AS email,
            COALESCE(dr.qb_coordinator_name, u.name) AS qb_coordinator_name,
            LOWER(TRIM(COALESCE(dr.qb_coordinator_email, u.email))) AS qb_coordinator_email
     FROM users u
     JOIN user_departments ud ON ud.user_id = u.id
     JOIN departments d ON d.id = ud.department_id
     LEFT JOIN agent_delivery_recipients dr
       ON dr.delivery_config_id = ? AND dr.user_id = u.id
     WHERE u.is_active = 1
       AND d.name = 'PC'
       AND COALESCE(dr.enabled, 1) = 1
     ORDER BY u.name`
  ).all(configId) as Array<{ user_id: number; name: string; email: string; qb_coordinator_name: string; qb_coordinator_email: string }>

  const ins = db.prepare(
    `INSERT OR IGNORE INTO agent_delivery_recipients
       (delivery_config_id, user_id, qb_coordinator_name, qb_coordinator_email, channel, enabled, updated_at)
     VALUES (?, ?, ?, ?, 'agent_ops_inbox', 1, CURRENT_TIMESTAMP)`
  )
  for (const row of rows) ins.run(configId, row.user_id, row.qb_coordinator_name || row.name, row.qb_coordinator_email || row.email)
  return rows
}

function deliveryTitle(coordinator: string): string {
  return `Daily coordinator digest - ${coordinator}`
}

router.get('/roles', (_req: Request, res: Response): void => {
  res.json(listRoleHierarchy())
})

router.post('/roles', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const body = req.body as Record<string, unknown>
  if (!body['name'] || !body['slug'] || !body['objective'] || !body['execution_mode'] || !body['llm']) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  const result = db.prepare(
    `INSERT INTO agent_roles
       (name, slug, description, objective, execution_mode, parent_role_id, owner_user_id, department, status, llm, monthly_token_cap, approval_required, is_lab_only, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    String(body['name']),
    String(body['slug']),
    body['description'] ? String(body['description']) : null,
    String(body['objective']),
    String(body['execution_mode']),
    body['parent_role_id'] ?? null,
    body['owner_user_id'] ?? null,
    body['department'] ? String(body['department']) : null,
    body['status'] ? String(body['status']) : 'active',
    String(body['llm']),
    Number(body['monthly_token_cap'] || 0),
    Number(body['approval_required'] ?? 1),
    Number(body['is_lab_only'] ?? 0),
  )
  res.json({ ok: true, id: Number(result.lastInsertRowid) })
})

router.patch('/roles/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const patch = req.body as Record<string, unknown>
  const allowed = ['name', 'slug', 'description', 'objective', 'execution_mode', 'parent_role_id', 'owner_user_id', 'department', 'status', 'llm', 'monthly_token_cap', 'approval_required', 'is_lab_only']
  const sets: string[] = []
  const params: unknown[] = []
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`)
      params.push(patch[key] ?? null)
    }
  }
  if (!sets.length) {
    res.status(400).json({ error: 'Nothing to update' })
    return
  }
  sets.push('updated_at = CURRENT_TIMESTAMP')
  params.push(id)
  db.prepare(`UPDATE agent_roles SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  res.json({ ok: true })
})

router.get('/goals/:roleId', (req: Request, res: Response): void => {
  const rows = db.prepare(`SELECT * FROM agent_goals WHERE agent_role_id = ? ORDER BY priority ASC, id ASC`).all(Number(req.params['roleId']))
  res.json({ rows })
})

router.post('/goals', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const body = req.body as Record<string, unknown>
  const result = db.prepare(
    `INSERT INTO agent_goals (agent_role_id, title, description, success_metric, priority, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    Number(body['agent_role_id']),
    String(body['title'] || ''),
    body['description'] ? String(body['description']) : null,
    body['success_metric'] ? String(body['success_metric']) : null,
    Number(body['priority'] || 3),
    String(body['status'] || 'active'),
  )
  res.json({ ok: true, id: Number(result.lastInsertRowid) })
})

router.patch('/goals/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const patch = req.body as Record<string, unknown>
  const sets: string[] = []
  const params: unknown[] = []
  for (const key of ['title', 'description', 'success_metric', 'priority', 'status']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`)
      params.push(patch[key] ?? null)
    }
  }
  if (!sets.length) {
    res.status(400).json({ error: 'Nothing to update' })
    return
  }
  sets.push('updated_at = CURRENT_TIMESTAMP')
  params.push(id)
  db.prepare(`UPDATE agent_goals SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  res.json({ ok: true })
})

router.get('/tasks/:roleId', (req: Request, res: Response): void => {
  const rows = db.prepare(
    `SELECT t.*, s.id AS schedule_id, s.cron_expr, s.timezone, s.enabled AS schedule_enabled, s.last_run_at, s.next_run_at
     FROM agent_role_tasks t
     LEFT JOIN agent_task_schedules s ON s.task_id = t.id
     WHERE t.agent_role_id = ?
     ORDER BY t.id ASC`
  ).all(Number(req.params['roleId']))
  res.json({ rows })
})

router.get('/tasks/detail/:id', (req: Request, res: Response): void => {
  const id = Number(req.params['id'])
  const task = db.prepare(
    `SELECT t.*, ar.name AS role_name, ar.slug AS role_slug, ar.department, ar.objective AS role_objective, ar.execution_mode,
            s.id AS schedule_id, s.cron_expr, s.timezone, s.enabled AS schedule_enabled, s.last_run_at, s.next_run_at
     FROM agent_role_tasks t
     JOIN agent_roles ar ON ar.id = t.agent_role_id
     LEFT JOIN agent_task_schedules s ON s.task_id = t.id
     WHERE t.id = ?`
  ).get(id) as Record<string, unknown> | undefined
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const draft = db.prepare(
    `SELECT *
     FROM agent_task_drafts
     WHERE task_id = ? AND user_id = ?
     LIMIT 1`
  ).get(id, req.user?.userId || 0) as Record<string, unknown> | undefined
  const messages = db.prepare(
    `SELECT id, role, content, patch_json, compliance_review_json, created_at
     FROM agent_task_draft_messages
     WHERE task_id = ? AND user_id = ?
     ORDER BY created_at ASC, id ASC`
  ).all(id, req.user?.userId || 0)
  res.json({ task, draft: draft || null, messages })
})

router.post('/tasks/:id/draft', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const current = db.prepare(`SELECT * FROM agent_role_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!current) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const draft = (req.body as Record<string, unknown>)['draft']
  if (!draft || typeof draft !== 'object') {
    res.status(400).json({ error: 'draft is required' })
    return
  }
  const review = reviewTaskPatch(current, draft as Record<string, unknown>)
  if (review.review_required === 'blocked') {
    res.status(400).json({ error: review.summary, review })
    return
  }
  db.prepare(
    `INSERT INTO agent_task_drafts (task_id, user_id, draft_json, compliance_review_json, status, updated_at)
     VALUES (?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP)
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       draft_json=excluded.draft_json,
       compliance_review_json=excluded.compliance_review_json,
       status='draft',
       updated_at=CURRENT_TIMESTAMP`
  ).run(id, req.user?.userId || null, JSON.stringify(draft), JSON.stringify(review))
  res.json({ ok: true, review })
})

router.post('/tasks/:id/draft/request-review', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const userId = req.user?.userId || 0
  const current = db.prepare(`SELECT * FROM agent_role_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  const draftRow = db.prepare(
    `SELECT * FROM agent_task_drafts WHERE task_id = ? AND user_id = ?`
  ).get(id, userId) as Record<string, unknown> | undefined
  if (!current || !draftRow) {
    res.status(404).json({ error: 'Saved draft not found' })
    return
  }
  const draft = JSON.parse(String(draftRow['draft_json'] || '{}')) as Record<string, unknown>
  const review = reviewTaskPatch(current, draft)
  if (review.review_required === 'blocked') {
    res.status(400).json({ error: review.summary, review })
    return
  }
  db.prepare(
    `UPDATE agent_task_drafts
     SET status = 'requested', compliance_review_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE task_id = ? AND user_id = ?`
  ).run(JSON.stringify(review), id, userId)
  res.json({ ok: true, status: 'requested', review })
})

router.post('/tasks/:id/draft/withdraw-review', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  db.prepare(
    `UPDATE agent_task_drafts
     SET status = 'draft', updated_at = CURRENT_TIMESTAMP
     WHERE task_id = ? AND user_id = ? AND status = 'requested'`
  ).run(id, req.user?.userId || 0)
  db.prepare(
    `INSERT INTO agent_task_draft_messages (task_id, user_id, role, content)
     VALUES (?, ?, 'system', ?)`
  ).run(id, req.user?.userId || null, 'Production review withdrawn. Draft editing is unlocked.')
  res.json({ ok: true })
})

router.get('/task-drafts/review', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const rows = db.prepare(
    `SELECT d.*, t.name AS task_name, t.task_type, ar.name AS role_name, ar.department, u.name AS requested_by_name, u.email AS requested_by_email
     FROM agent_task_drafts d
     JOIN agent_role_tasks t ON t.id = d.task_id
     JOIN agent_roles ar ON ar.id = t.agent_role_id
     LEFT JOIN users u ON u.id = d.user_id
     WHERE d.status = 'requested'
     ORDER BY d.updated_at DESC`
  ).all()
  res.json({ rows })
})

router.post('/task-drafts/:id/approve', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const row = db.prepare(
    `SELECT d.*, t.*
     FROM agent_task_drafts d
     JOIN agent_role_tasks t ON t.id = d.task_id
     WHERE d.id = ? AND d.status = 'requested'`
  ).get(id) as Record<string, unknown> | undefined
  if (!row) {
    res.status(404).json({ error: 'Requested draft not found' })
    return
  }
  const draft = JSON.parse(String(row['draft_json'] || '{}')) as Record<string, unknown>
  const review = reviewTaskPatch(row, draft)
  if (review.review_required === 'blocked') {
    res.status(400).json({ error: review.summary, review })
    return
  }
  const inputTemplate = Object.prototype.hasOwnProperty.call(draft, 'input_template_json')
    ? JSON.stringify(draft['input_template_json'] || null)
    : row['input_template_json']
  const outputSchema = Object.prototype.hasOwnProperty.call(draft, 'output_schema_json')
    ? JSON.stringify(draft['output_schema_json'] || null)
    : row['output_schema_json']
  db.prepare(
    `UPDATE agent_role_tasks
     SET name = ?, task_type = ?, instructions = ?, input_template_json = ?, output_schema_json = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    String(draft['name'] || row['name'] || ''),
    String(draft['task_type'] || row['task_type'] || 'custom'),
    String(draft['instructions'] || row['instructions'] || ''),
    inputTemplate,
    outputSchema,
    Number(draft['enabled'] ?? row['enabled'] ?? 1),
    Number(row['task_id']),
  )
  db.prepare(
    `UPDATE agent_task_drafts
     SET status = 'approved', compliance_review_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(JSON.stringify(review), id)
  reloadAgentScheduler()
  res.json({ ok: true, review })
})

router.post('/task-drafts/:id/reject', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  db.prepare(
    `UPDATE agent_task_drafts
     SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'requested'`
  ).run(id)
  res.json({ ok: true })
})

router.post('/tasks', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const body = req.body as Record<string, unknown>
  const result = db.prepare(
    `INSERT INTO agent_role_tasks
       (agent_role_id, name, task_type, instructions, input_template_json, output_schema_json, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    Number(body['agent_role_id']),
    String(body['name'] || ''),
    String(body['task_type'] || 'custom'),
    String(body['instructions'] || ''),
    body['input_template_json'] ? JSON.stringify(body['input_template_json']) : null,
    body['output_schema_json'] ? JSON.stringify(body['output_schema_json']) : null,
    Number(body['enabled'] ?? 1),
  )
  res.json({ ok: true, id: Number(result.lastInsertRowid) })
})

router.patch('/tasks/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const patch = req.body as Record<string, unknown>
  const current = db.prepare(`SELECT * FROM agent_role_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!current) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const review = reviewTaskPatch(current, patch)
  if (!review.allowed_to_save) {
    res.status(review.review_required === 'blocked' ? 400 : 409).json({ error: review.summary, review })
    return
  }
  const sets: string[] = []
  const params: unknown[] = []
  for (const key of ['name', 'task_type', 'instructions', 'enabled']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`)
      params.push(patch[key])
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'input_template_json')) {
    sets.push('input_template_json = ?')
    params.push(patch['input_template_json'] ? JSON.stringify(patch['input_template_json']) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'output_schema_json')) {
    sets.push('output_schema_json = ?')
    params.push(patch['output_schema_json'] ? JSON.stringify(patch['output_schema_json']) : null)
  }
  if (!sets.length) {
    res.status(400).json({ error: 'Nothing to update' })
    return
  }
  sets.push('updated_at = CURRENT_TIMESTAMP')
  params.push(id)
  db.prepare(`UPDATE agent_role_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  reloadAgentScheduler()
  res.json({ ok: true, review })
})

router.post('/tasks/:id/edit-chat', async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const existingDraft = db.prepare(
    `SELECT status FROM agent_task_drafts WHERE task_id = ? AND user_id = ?`
  ).get(id, req.user?.userId || 0) as { status: string } | undefined
  if (existingDraft?.status === 'requested') {
    res.status(409).json({ error: 'This draft is in production review. Withdraw the review before making more edits.' })
    return
  }
  const task = db.prepare(
    `SELECT t.*, ar.name AS role_name, ar.department
     FROM agent_role_tasks t
     JOIN agent_roles ar ON ar.id = t.agent_role_id
     WHERE t.id = ?`
  ).get(id) as Record<string, unknown> | undefined
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const message = String((req.body as Record<string, unknown>)['message'] || '')
  const workingDraft = (req.body as Record<string, unknown>)['draft']
  if (!message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  db.prepare(
    `INSERT INTO agent_task_draft_messages (task_id, user_id, role, content)
     VALUES (?, ?, 'user', ?)`
  ).run(id, req.user?.userId || null, message.trim())
  const workingTask = workingDraft && typeof workingDraft === 'object'
    ? { ...task, ...(workingDraft as Record<string, unknown>) }
    : task
  let proposal = proposeTaskPatch(workingTask, message)
  const cfg = db.prepare(
    `SELECT api_key_encrypted, base_url FROM user_ollama_config WHERE user_id = ?`
  ).get(req.user?.userId || 0) as { api_key_encrypted: string | null; base_url: string } | undefined
  if (cfg?.api_key_encrypted) {
    try {
      const apiKey = decryptSecret(cfg.api_key_encrypted)
      const llm = await ollamaChat({
        baseUrl: cfg.base_url || 'https://ollama.com',
        apiKey,
        model: ollamaModelFor('ollama-qwen2.5-7b') || 'qwen2.5:7b',
        temperature: 0.1,
        maxOutputTokens: 900,
        timeoutMs: 30_000,
        messages: [
          {
            role: 'system',
            content: [
              'You help admins edit controlled production agent tasks.',
              'Return only JSON with keys reply and patch.',
              'patch may include name, task_type, instructions, input_template_json, output_schema_json, enabled.',
              'Do not include irreversible actions as enabled behavior. Keep external communication draft-only.',
              'Prefer agent-to-agent routing recommendations over human report reading.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              current_task: task,
              current_draft: workingTask,
              prior_conversation: db.prepare(
                `SELECT role, content FROM agent_task_draft_messages
                 WHERE task_id = ? AND user_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT 12`
              ).all(id, req.user?.userId || 0).reverse(),
              requested_change: message,
            }),
          },
        ],
      })
      if (llm.ok && llm.output) {
        const cleaned = llm.output.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
        const parsed = JSON.parse(cleaned) as { reply?: string; patch?: Record<string, unknown> }
        if (parsed.patch && typeof parsed.patch === 'object') {
          const fallback = proposeTaskPatch(workingTask, message)
          proposal = {
            reply: parsed.reply || 'I drafted a task update and ran the compliance review.',
            patch: {
              ...fallback.patch,
              ...parsed.patch,
              instructions: parsed.patch['instructions'] || fallback.patch['instructions'],
            },
          }
        }
      }
    } catch {
      proposal = {
        ...proposal,
        reply: `${proposal.reply} The LLM draft was unavailable, so I used the deterministic fallback proposal.`,
      }
    }
  }
  const review = reviewTaskPatch(workingTask, proposal.patch)
  const assistantContent = review.review_required === 'blocked'
    ? `${review.summary} I did not apply this change to the draft.`
    : `${proposal.reply}\n\nProposed draft changes: ${Object.keys(proposal.patch || {}).join(', ') || 'none'}. Apply them if they match what you want.`
  db.prepare(
    `INSERT INTO agent_task_draft_messages
       (task_id, user_id, role, content, patch_json, compliance_review_json)
     VALUES (?, ?, 'assistant', ?, ?, ?)`
  ).run(id, req.user?.userId || null, assistantContent, JSON.stringify(proposal.patch || {}), JSON.stringify(review))
  res.json({ ok: true, reply: proposal.reply, patch: proposal.patch, review })
})

router.post('/tasks/:id/draft/test', async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const task = db.prepare(
    `SELECT t.*, ar.id AS role_id
     FROM agent_role_tasks t
     JOIN agent_roles ar ON ar.id = t.agent_role_id
     WHERE t.id = ?`
  ).get(id) as Record<string, unknown> | undefined
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const draft = (req.body as Record<string, unknown>)['draft']
  const payload = (req.body as Record<string, unknown>)['payload'] as Record<string, unknown> | undefined
  const testTask = draft && typeof draft === 'object'
    ? { ...task, ...(draft as Record<string, unknown>) }
    : task
  const role = getRoleForRun(Number(task['role_id']))
  if (!role) {
    res.status(404).json({ error: 'Role not found' })
    return
  }
  const result = await executeRoleTask(role, testTask as any, JSON.stringify(payload || {}))
  db.prepare(
    `INSERT INTO agent_task_draft_messages (task_id, user_id, role, content)
     VALUES (?, ?, 'system', ?)`
  ).run(id, req.user?.userId || null, `Test run completed with status ${result.status}.`)
  res.json({ ok: true, ...result })
})

router.post('/tasks/:id/run', async (req: Request, res: Response): Promise<void> => {
  const taskId = Number(req.params['id'])
  const task = db.prepare(`SELECT id, agent_role_id FROM agent_role_tasks WHERE id = ?`).get(taskId) as { id: number; agent_role_id: number } | undefined
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const result = await dispatchRoleTask({
    agentRoleId: task.agent_role_id,
    taskId,
    trigger: 'manual',
    payload: (req.body || {}) as Record<string, unknown>,
    createdByUserId: req.user?.userId || null,
  })
  res.json({ ok: true, ...result })
})

router.post('/tasks/:id/deliver-pc-digest', async (req: Request, res: Response): Promise<void> => {
  const taskId = Number(req.params['id'])
  const task = db.prepare(
    `SELECT t.id, t.agent_role_id, t.name, t.task_type, ar.name AS role_name
     FROM agent_role_tasks t
     JOIN agent_roles ar ON ar.id = t.agent_role_id
     WHERE t.id = ?`
  ).get(taskId) as { id: number; agent_role_id: number; name: string; task_type: string; role_name: string } | undefined
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  if (task.name !== 'Generate daily coordinator digest') {
    res.status(400).json({ error: 'Delivery action is currently only available for Generate daily coordinator digest' })
    return
  }

  const configId = ensurePcDigestDeliveryConfig(taskId)
  const recipients = listPcDigestRecipients(configId)
  const results: Array<Record<string, unknown>> = []

  for (const recipient of recipients) {
    try {
      const run = await dispatchRoleTask({
        agentRoleId: task.agent_role_id,
        taskId,
        trigger: 'manual',
        payload: {
          use_live_data: true,
          coordinator: recipient.qb_coordinator_name,
          coordinator_email: recipient.qb_coordinator_email,
          inspection_days: Number(req.body?.inspection_days || 30),
          delivery_config_id: configId,
          delivery_user_id: recipient.user_id,
        },
        createdByUserId: req.user?.userId || null,
      })
      db.prepare(
        `INSERT INTO agent_delivery_items
           (delivery_config_id, task_run_id, user_id, channel, title, status, body_json, error)
         VALUES (?, ?, ?, 'agent_ops_inbox', ?, ?, ?, ?)`
      ).run(
        configId,
        run.runId,
        recipient.user_id,
        deliveryTitle(recipient.qb_coordinator_name),
        run.status === 'completed' ? 'delivered' : 'failed',
        run.resultJson || null,
        run.status === 'completed' ? null : `Run finished with status ${run.status}`,
      )
      results.push({ user_id: recipient.user_id, coordinator: recipient.qb_coordinator_name, coordinator_email: recipient.qb_coordinator_email, run_id: run.runId, status: run.status })
    } catch (err) {
      db.prepare(
        `INSERT INTO agent_delivery_items
           (delivery_config_id, user_id, channel, title, status, error)
         VALUES (?, ?, 'agent_ops_inbox', ?, 'failed', ?)`
      ).run(configId, recipient.user_id, deliveryTitle(recipient.qb_coordinator_name), err instanceof Error ? err.message : String(err))
      results.push({ user_id: recipient.user_id, coordinator: recipient.qb_coordinator_name, coordinator_email: recipient.qb_coordinator_email, status: 'failed', error: String(err) })
    }
  }

  res.json({
    ok: true,
    delivery_config_id: configId,
    expected_recipients: recipients.length,
    delivered: results.filter(r => r['status'] === 'completed').length,
    failed: results.filter(r => r['status'] !== 'completed').length,
    results,
  })
})

router.get('/delivery/inbox', (req: Request, res: Response): void => {
  const limit = Math.min(Number(req.query['limit'] || 50), 200)
  const scope = String(req.query['scope'] || 'mine')
  const showAll = scope === 'all' && isAdmin(req)
  const where = showAll ? 'WHERE di.deleted_at IS NULL' : 'WHERE di.user_id = ? AND di.deleted_at IS NULL'
  const params: unknown[] = showAll ? [] : [req.user?.userId || 0]
  const rows = db.prepare(
    `SELECT di.*, dc.name AS delivery_name, ar.name AS role_name, t.name AS task_name,
            u.name AS recipient_name, u.email AS recipient_email
     FROM agent_delivery_items di
     JOIN users u ON u.id = di.user_id
     LEFT JOIN agent_delivery_configs dc ON dc.id = di.delivery_config_id
     LEFT JOIN agent_task_runs tr ON tr.id = di.task_run_id
     LEFT JOIN agent_roles ar ON ar.id = tr.agent_role_id
     LEFT JOIN agent_role_tasks t ON t.id = tr.task_id
     ${where}
     ORDER BY di.created_at DESC
     LIMIT ?`
  ).all(...params, limit)
  res.json({ rows, scope: showAll ? 'all' : 'mine' })
})

router.post('/delivery/inbox/:id/read', (req: Request, res: Response): void => {
  db.prepare(
    `UPDATE agent_delivery_items
     SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
     WHERE id = ? AND user_id = ?`
  ).run(Number(req.params['id']), req.user?.userId || 0)
  res.json({ ok: true })
})

router.post('/delivery/inbox/:id/unread', (req: Request, res: Response): void => {
  db.prepare(
    `UPDATE agent_delivery_items
     SET read_at = NULL
     WHERE id = ? AND user_id = ?`
  ).run(Number(req.params['id']), req.user?.userId || 0)
  res.json({ ok: true })
})

router.delete('/delivery/inbox/:id', (req: Request, res: Response): void => {
  db.prepare(
    `UPDATE agent_delivery_items
     SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  ).run(Number(req.params['id']), req.user?.userId || 0)
  res.json({ ok: true })
})

router.post('/delivery/inbox/:id/forward', (req: Request, res: Response): void => {
  const body = req.body as Record<string, unknown>
  const email = String(body['email'] || '').trim().toLowerCase()
  if (!email) {
    res.status(400).json({ error: 'email is required' })
    return
  }
  const source = db.prepare(
    `SELECT * FROM agent_delivery_items WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).get(Number(req.params['id']), req.user?.userId || 0) as Record<string, unknown> | undefined
  const target = db.prepare(
    `SELECT id FROM users WHERE LOWER(email) = ? AND is_active = 1`
  ).get(email) as { id: number } | undefined
  if (!source || !target) {
    res.status(404).json({ error: 'Inbox item or active target user not found' })
    return
  }
  db.prepare(
    `INSERT INTO agent_delivery_items
       (delivery_config_id, task_run_id, user_id, channel, title, status, body_json, error)
     VALUES (?, ?, ?, 'agent_ops_inbox', ?, ?, ?, ?)`
  ).run(
    source['delivery_config_id'] || null,
    source['task_run_id'] || null,
    target.id,
    `Fwd: ${source['title'] || 'Agent delivery'}`,
    source['status'] || 'delivered',
    source['body_json'] || null,
    source['error'] || null,
  )
  res.json({ ok: true })
})

router.get('/delivery/configs', (_req: Request, res: Response): void => {
  const rows = db.prepare(
    `SELECT dc.*, t.name AS task_name, ar.name AS role_name,
            COUNT(dr.id) AS explicit_recipients
     FROM agent_delivery_configs dc
     JOIN agent_role_tasks t ON t.id = dc.task_id
     JOIN agent_roles ar ON ar.id = t.agent_role_id
     LEFT JOIN agent_delivery_recipients dr ON dr.delivery_config_id = dc.id
     GROUP BY dc.id
     ORDER BY dc.created_at DESC`
  ).all()
  res.json({ rows })
})

router.post('/schedules', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const body = req.body as Record<string, unknown>
  const result = db.prepare(
    `INSERT INTO agent_task_schedules (task_id, cron_expr, timezone, enabled, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    Number(body['task_id']),
    String(body['cron_expr'] || ''),
    String(body['timezone'] || 'America/Los_Angeles'),
    Number(body['enabled'] ?? 1),
  )
  reloadAgentScheduler()
  res.json({ ok: true, id: Number(result.lastInsertRowid) })
})

router.patch('/schedules/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return
  const id = Number(req.params['id'])
  const patch = req.body as Record<string, unknown>
  const sets: string[] = []
  const params: unknown[] = []
  for (const key of ['cron_expr', 'timezone', 'enabled', 'last_run_at', 'next_run_at']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`)
      params.push(patch[key])
    }
  }
  if (!sets.length) {
    res.status(400).json({ error: 'Nothing to update' })
    return
  }
  sets.push('updated_at = CURRENT_TIMESTAMP')
  params.push(id)
  db.prepare(`UPDATE agent_task_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  reloadAgentScheduler()
  res.json({ ok: true })
})

router.get('/runs', (req: Request, res: Response): void => {
  const status = req.query['status'] as string | undefined
  const roleId = req.query['role_id'] ? Number(req.query['role_id']) : null
  const limit = Math.min(Number(req.query['limit'] || 100), 500)
  const where: string[] = []
  const params: unknown[] = []
  if (status) { where.push('r.status = ?'); params.push(status) }
  if (roleId) { where.push('r.agent_role_id = ?'); params.push(roleId) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(
    `SELECT r.*, ar.name AS role_name, t.name AS task_name
     FROM agent_task_runs r
     JOIN agent_roles ar ON ar.id = r.agent_role_id
     LEFT JOIN agent_role_tasks t ON t.id = r.task_id
     ${clause}
     ORDER BY r.created_at DESC
     LIMIT ?`
  ).all(...params, limit)
  res.json({ rows })
})

router.post('/ari/route', async (req: Request, res: Response): Promise<void> => {
  const message = String(req.body?.message || '').trim()
  if (!message) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  const result = await routeAriRequest(message, req.user?.userId || 0)
  res.json({ ok: true, ...result })
})

router.get('/ari/workspace', (_req: Request, res: Response): void => {
  const ari = db.prepare(`SELECT * FROM agent_roles WHERE slug = 'ari-pc-manager'`).get()
  const tasks = db.prepare(
    `SELECT r.slug AS role_slug, r.name AS role_name, t.id, t.name, t.task_type
     FROM agent_role_tasks t
     JOIN agent_roles r ON r.id = t.agent_role_id
     WHERE r.department = 'Project Coordinators' AND r.is_lab_only = 0 AND t.enabled = 1
     ORDER BY r.name, t.name`
  ).all()
  res.json({
    ari,
    suggestions: [
      'Draft a customer follow-up',
      'Generate a project status summary',
      'Run hold classification',
      'Create a notes digest',
    ],
    tasks,
  })
})

export { router as agentOrgRouter }
