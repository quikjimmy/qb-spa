import cron, { type ScheduledTask } from 'node-cron'
import db from '../db'
import { dispatchRoleTask } from './taskDispatcher'

interface ScheduleRow {
  schedule_id: number
  task_id: number
  agent_role_id: number
  cron_expr: string
  timezone: string
  task_name: string
  role_name: string
}

const scheduledJobs = new Map<number, ScheduledTask>()
let started = false

function nowIso(): string {
  return new Date().toISOString()
}

function estimateNextRunAt(cronExpr: string): string | null {
  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  const now = new Date()

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const next = new Date(now)
    next.setHours(parseInt(hour, 10), parseInt(minute, 10), 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }

  if (/^\*\/\d+$/.test(minute) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const every = parseInt(minute.slice(2), 10)
    const next = new Date(now)
    next.setSeconds(0, 0)
    const currentMin = next.getMinutes()
    const delta = every - (currentMin % every || every)
    next.setMinutes(currentMin + delta)
    return next.toISOString()
  }

  return null
}

function stopAll(): void {
  for (const task of scheduledJobs.values()) task.stop()
  scheduledJobs.clear()
}

async function runScheduledTask(row: ScheduleRow): Promise<void> {
  const startedAt = nowIso()
  db.prepare(`UPDATE agent_task_schedules SET last_run_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(startedAt, estimateNextRunAt(row.cron_expr), row.schedule_id)

  try {
    const result = await dispatchRoleTask({
      agentRoleId: row.agent_role_id,
      taskId: row.task_id,
      trigger: 'cron',
      payload: { schedule_id: row.schedule_id, task_name: row.task_name, role_name: row.role_name },
    })
    console.log(`[agent-scheduler] ${row.role_name}/${row.task_name} -> ${result.status}`)
  } catch (err) {
    console.error(`[agent-scheduler] ${row.role_name}/${row.task_name} error:`, err)
  }
}

function loadScheduleRows(): ScheduleRow[] {
  return db.prepare(
    `SELECT s.id AS schedule_id, s.task_id, t.agent_role_id, s.cron_expr, s.timezone, t.name AS task_name, r.name AS role_name
     FROM agent_task_schedules s
     JOIN agent_role_tasks t ON t.id = s.task_id
     JOIN agent_roles r ON r.id = t.agent_role_id
     WHERE s.enabled = 1 AND t.enabled = 1 AND r.status = 'active'`
  ).all() as ScheduleRow[]
}

export function reloadAgentScheduler(): void {
  if (!started) return
  stopAll()
  const rows = loadScheduleRows()
  for (const row of rows) {
    if (!cron.validate(row.cron_expr)) {
      console.warn(`[agent-scheduler] invalid cron for schedule ${row.schedule_id}: ${row.cron_expr}`)
      continue
    }
    const task = cron.schedule(row.cron_expr, () => {
      void runScheduledTask(row)
    }, { timezone: row.timezone })
    scheduledJobs.set(row.schedule_id, task)
    db.prepare(`UPDATE agent_task_schedules SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(estimateNextRunAt(row.cron_expr), row.schedule_id)
    console.log(`[agent-scheduler] registered ${row.role_name}/${row.task_name} @ ${row.cron_expr} (${row.timezone})`)
  }
}

export function startAgentScheduler(): void {
  if (started) return
  started = true
  reloadAgentScheduler()
}
