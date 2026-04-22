import db from '../db'
import { executeRoleTask, getRoleForRun, getTaskForRun } from './roleRunner'

interface DispatchOptions {
  agentRoleId: number
  taskId: number | null
  trigger: 'manual' | 'cron' | 'delegated' | 'api'
  payload?: Record<string, unknown> | null
  createdByUserId?: number | null
  parentRunId?: number | null
  scheduledFor?: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

export async function dispatchRoleTask(opts: DispatchOptions): Promise<{ runId: number; status: string; resultJson?: string | null }> {
  const insert = db.prepare(
    `INSERT INTO agent_task_runs
       (agent_role_id, task_id, trigger, status, payload_json, scheduled_for, created_by_user_id, parent_run_id, created_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  )
  const runId = Number(insert.run(
    opts.agentRoleId,
    opts.taskId,
    opts.trigger,
    opts.payload ? JSON.stringify(opts.payload) : null,
    opts.scheduledFor || null,
    opts.createdByUserId || null,
    opts.parentRunId || null,
  ).lastInsertRowid)

  db.prepare(`UPDATE agent_task_runs SET status='running', started_at=? WHERE id = ?`).run(nowIso(), runId)

  const role = getRoleForRun(opts.agentRoleId)
  if (!role) {
    db.prepare(`UPDATE agent_task_runs SET status='failed', finished_at=?, error=? WHERE id = ?`).run(nowIso(), 'Role not found', runId)
    return { runId, status: 'failed' }
  }

  if (!opts.taskId) {
    db.prepare(`UPDATE agent_task_runs SET status='failed', finished_at=?, error=? WHERE id = ?`).run(nowIso(), 'Task not provided', runId)
    return { runId, status: 'failed' }
  }

  const task = getTaskForRun(opts.taskId)
  if (!task) {
    db.prepare(`UPDATE agent_task_runs SET status='failed', finished_at=?, error=? WHERE id = ?`).run(nowIso(), 'Task not found', runId)
    return { runId, status: 'failed' }
  }

  const payloadJson = db.prepare(`SELECT payload_json FROM agent_task_runs WHERE id = ?`).get(runId) as { payload_json: string | null }
  const result = await executeRoleTask(role, task, payloadJson.payload_json)

  db.prepare(
    `UPDATE agent_task_runs
     SET status = ?, result_json = ?, error = ?, finished_at = ?, tokens_in = ?, tokens_out = ?, cost_cents = ?
     WHERE id = ?`
  ).run(
    result.status,
    result.resultJson || null,
    result.error || null,
    nowIso(),
    result.tokensIn || 0,
    result.tokensOut || 0,
    result.costCents || 0,
    runId,
  )

  if (result.status === 'approval_pending') {
    const parsed = (() => {
      try { return JSON.parse(result.resultJson || '{}') as Record<string, unknown> } catch { return {} }
    })()
    db.prepare(
      `INSERT INTO agent_approvals
         (task_run_id, requested_action, requested_payload_json)
       VALUES (?, ?, ?)`
    ).run(runId, String(parsed['requested_action'] || 'approval_required'), JSON.stringify(parsed))
  }

  const deliveryUserId = opts.payload?.['delivery_user_id']
  if (opts.createdByUserId && !deliveryUserId) {
    db.prepare(
      `INSERT INTO agent_delivery_items
         (task_run_id, user_id, channel, title, status, body_json, error)
       VALUES (?, ?, 'agent_ops_inbox', ?, ?, ?, ?)`
    ).run(
      runId,
      opts.createdByUserId,
      `${task.name} - ${role.name}`,
      result.status === 'failed' ? 'failed' : 'delivered',
      result.resultJson || null,
      result.error || null,
    )
  }

  db.prepare(
    `UPDATE agent_roles
     SET tokens_used_month = tokens_used_month + ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run((result.tokensIn || 0) + (result.tokensOut || 0), opts.agentRoleId)

  return { runId, status: result.status, resultJson: result.resultJson || null }
}

function chooseTaskByMessage(message: string): { roleSlug: string; taskName: string } {
  const q = message.toLowerCase()
  if (q.includes('hold') || q.includes('risk') || q.includes('blocker')) return { roleSlug: 'pc-risk-hold-worker', taskName: 'Hold classification' }
  if (q.includes('morning') || q.includes('briefing') || q.includes('daily coordinator') || q.includes('daily digest')) return { roleSlug: 'pc-status-summary-worker', taskName: 'Generate daily coordinator digest' }
  if (q.includes('digest') || q.includes('notes')) return { roleSlug: 'pc-notes-digest-worker', taskName: 'Recent notes digest' }
  if (q.includes('summary') || q.includes('status')) return { roleSlug: 'pc-status-summary-worker', taskName: 'Generate project status summary' }
  return { roleSlug: 'pc-outreach-worker', taskName: 'Draft customer follow-up' }
}

export async function routeAriRequest(message: string, userId: number): Promise<{ parentRunId: number; childRunId: number; routedRole: string; routedTask: string }> {
  const ariRole = db.prepare(`SELECT id FROM agent_roles WHERE slug = 'ari-pc-manager'`).get() as { id: number } | undefined
  const ariTask = db.prepare(
    `SELECT id FROM agent_role_tasks
     WHERE agent_role_id = ? AND name = 'Intake / route PC requests'`
  ).get(ariRole?.id || 0) as { id: number } | undefined
  if (!ariRole || !ariTask) throw new Error('Ari role is not seeded')

  const parent = await dispatchRoleTask({
    agentRoleId: ariRole.id,
    taskId: ariTask.id,
    trigger: 'api',
    payload: { message, routed: true },
    createdByUserId: userId,
  })

  const target = chooseTaskByMessage(message)
  const workerRole = db.prepare(`SELECT id, name FROM agent_roles WHERE slug = ?`).get(target.roleSlug) as { id: number; name: string } | undefined
  const workerTask = db.prepare(`SELECT id, name FROM agent_role_tasks WHERE agent_role_id = ? AND name = ?`).get(workerRole?.id || 0, target.taskName) as { id: number; name: string } | undefined
  if (!workerRole || !workerTask) throw new Error('Routed worker task not found')

  const child = await dispatchRoleTask({
    agentRoleId: workerRole.id,
    taskId: workerTask.id,
    trigger: 'delegated',
    payload: { message, routed_by: 'Ari' },
    createdByUserId: userId,
    parentRunId: parent.runId,
  })

  db.prepare(
    `UPDATE agent_task_runs
     SET result_json = ?, status = 'completed', finished_at = ?, error = NULL
     WHERE id = ?`
  ).run(
    JSON.stringify({
      summary: `Ari routed the request to ${workerRole.name}: ${workerTask.name}.`,
      delegated_run_id: child.runId,
      routed_role: workerRole.name,
      routed_task: workerTask.name,
    }),
    nowIso(),
    parent.runId,
  )

  return {
    parentRunId: parent.runId,
    childRunId: child.runId,
    routedRole: workerRole.name,
    routedTask: workerTask.name,
  }
}
