import crypto from 'crypto'
import db from '../db'
import { classifyHoldProject, HOLD_CLASSIFIER_MODEL_DEFAULT, HOLD_CLASSIFIER_MODEL_FALLBACK, type HoldProject, type ProjectNote } from './holdClassifier'
import { fetchProjectNotes } from './notesFetcher'

const AGENT_NAME = 'hold-classifier'

function inputHash(project: HoldProject, notes: ProjectNote[]): string {
  const payload = JSON.stringify({
    status: project.status,
    recent: notes.slice(0, 20).map(n => ({ id: n.record_id, d: n.date, t: n.text })),
  })
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

function monthSpendCents(): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_cents),0) AS c FROM agent_runs WHERE agent = ? AND started_at >= datetime('now', 'start of month')`
  ).get(AGENT_NAME) as { c: number }
  return row.c
}

function getBudgetCapCents(): number {
  const usd = parseFloat(process.env['AGENT_MONTHLY_CAP_USD'] || '5')
  return Math.round(usd * 100)
}

function pickModel(): string {
  const spend = monthSpendCents()
  const cap = getBudgetCapCents()
  if (spend > cap * 0.7) return HOLD_CLASSIFIER_MODEL_FALLBACK
  return HOLD_CLASSIFIER_MODEL_DEFAULT
}

export interface RunResult {
  run_id: number
  status: 'completed' | 'failed' | 'budget_exceeded'
  projects_scanned: number
  projects_classified: number
  projects_skipped: number
  cost_cents: number
  error?: string
}

export async function runHoldClassifier(trigger: 'cron' | 'manual' = 'manual'): Promise<RunResult> {
  const started = Date.now()
  const runInsert = db.prepare(
    `INSERT INTO agent_runs (agent, trigger, status, model) VALUES (?, ?, 'running', ?)`
  ).run(AGENT_NAME, trigger, HOLD_CLASSIFIER_MODEL_DEFAULT)
  const runId = Number(runInsert.lastInsertRowid)

  const updateRun = db.prepare(
    `UPDATE agent_runs SET status=?, finished_at=datetime('now'), duration_ms=?, projects_scanned=?, projects_classified=?, projects_skipped=?, tokens_in=?, tokens_out=?, cost_cents=?, model=?, error=? WHERE id=?`
  )

  try {
    if (monthSpendCents() >= getBudgetCapCents()) {
      updateRun.run('budget_exceeded', Date.now() - started, 0, 0, 0, 0, 0, 0, HOLD_CLASSIFIER_MODEL_DEFAULT, 'Monthly budget cap reached', runId)
      return { run_id: runId, status: 'budget_exceeded', projects_scanned: 0, projects_classified: 0, projects_skipped: 0, cost_cents: 0 }
    }

    const holdProjects = db.prepare(
      `SELECT record_id, customer_name, status, state, system_size_kw, sales_date, lender, coordinator,
              intake_completed, survey_submitted, survey_approved, design_completed,
              nem_submitted, nem_approved, nem_rejected, permit_submitted, permit_approved, permit_rejected,
              install_scheduled, install_completed, inspection_scheduled, inspection_passed,
              pto_submitted, pto_approved
         FROM project_cache
        WHERE status LIKE '%Hold%'`
    ).all() as HoldProject[]

    let classified = 0
    let skipped = 0
    let tokensIn = 0
    let tokensOut = 0
    let costCents = 0

    const upsertOutput = db.prepare(
      `INSERT INTO agent_outputs (agent, project_id, run_id, payload_json, input_hash, generated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(agent, project_id) DO UPDATE SET
         run_id=excluded.run_id,
         payload_json=excluded.payload_json,
         input_hash=excluded.input_hash,
         generated_at=excluded.generated_at`
    )

    const getExistingHash = db.prepare(`SELECT input_hash FROM agent_outputs WHERE agent=? AND project_id=?`)

    for (const project of holdProjects) {
      try {
        const notes = await fetchProjectNotes(project.record_id, 90)
        const hash = inputHash(project, notes)
        const existing = getExistingHash.get(AGENT_NAME, project.record_id) as { input_hash: string } | undefined
        if (existing?.input_hash === hash) { skipped++; continue }

        if (costCents + monthSpendCents() >= getBudgetCapCents()) { skipped++; continue }

        const model = pickModel()
        const result = await classifyHoldProject(project, notes, { model })
        upsertOutput.run(AGENT_NAME, project.record_id, runId, JSON.stringify(result.classification), hash)
        classified++
        tokensIn += result.tokens_in
        tokensOut += result.tokens_out
        costCents += result.cost_cents
      } catch (err) {
        console.error(`[hold-classifier] project ${project.record_id} failed:`, err)
        skipped++
      }
    }

    updateRun.run('completed', Date.now() - started, holdProjects.length, classified, skipped, tokensIn, tokensOut, costCents, HOLD_CLASSIFIER_MODEL_DEFAULT, null, runId)

    return { run_id: runId, status: 'completed', projects_scanned: holdProjects.length, projects_classified: classified, projects_skipped: skipped, cost_cents: costCents }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateRun.run('failed', Date.now() - started, 0, 0, 0, 0, 0, 0, HOLD_CLASSIFIER_MODEL_DEFAULT, msg, runId)
    return { run_id: runId, status: 'failed', projects_scanned: 0, projects_classified: 0, projects_skipped: 0, cost_cents: 0, error: msg }
  }
}

export { AGENT_NAME as HOLD_AGENT_NAME }
