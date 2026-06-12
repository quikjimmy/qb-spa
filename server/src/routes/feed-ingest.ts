import { Router, type Request, type Response } from 'express'
import db from '../db'

const router = Router()

function getQbConfig() {
  return {
    realm: process.env['QB_REALM_HOSTNAME'] || 'kin.quickbase.com',
    token: process.env['QB_USER_TOKEN'] || '',
  }
}

function qbHeaders(realm: string, token: string) {
  return {
    'QB-Realm-Hostname': realm,
    'Authorization': `QB-USER-TOKEN ${token}`,
    'Content-Type': 'application/json',
  }
}

async function qbQuery(realm: string, token: string, tableId: string, select: number[], where?: string, top = 200) {
  const body: Record<string, unknown> = {
    from: tableId,
    select,
    sortBy: [{ fieldId: 2, order: 'DESC' }],
    options: { top },
  }
  if (where) body.where = where

  const res = await fetch('https://api.quickbase.com/v1/records/query', {
    method: 'POST',
    headers: qbHeaders(realm, token),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QB query failed (${res.status}): ${text}`)
  }
  return res.json()
}

function val(record: Record<string, { value: unknown }>, fieldId: number): string {
  return String(record[String(fieldId)]?.value ?? '')
}

// NOTE: this batch ingester is BACKFILL-ONLY. Live feed posts are minted
// in real time by the webhook path (lib/feedMint.ts via qb-webhooks).
// The shared dedup_key (same format both sides) makes re-running this
// safe: rows the webhooks already minted are ignored.
const upsertFeedItem = db.prepare(`
  INSERT OR IGNORE INTO feed_items
    (qb_source, qb_record_id, event_type, title, body, actor_name, actor_email, project_id, project_name, metadata, occurred_at, dedup_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

// ─── Ingest: Project milestones ──────────────────────────

async function ingestMilestones(realm: string, token: string): Promise<number> {
  // Query projects with milestone dates, modified recently.
  // `col` must match the project_cache column names used by feedMint's
  // MILESTONE_DEFS — it's the dedup_key contract between both paths.
  // Curated to the SAME "major + scheduled" set the live mint path uses
  // (lib/feedMint.ts MILESTONE_DEFS) — no "submitted" churn. Keep the two
  // lists in lockstep or backfill and live posts will diverge.
  const milestoneFields = [
    { fid: 166, col: 'survey_scheduled', label: 'Survey Scheduled' },
    { fid: 165, col: 'survey_approved', label: 'Survey Approved' },
    { fid: 1774, col: 'design_completed', label: 'Design Completed' },
    { fid: 208, col: 'permit_approved', label: 'Permit Approved' },
    { fid: 706, col: 'permit_rejected', label: 'Permit Needs Another Pass' },
    { fid: 327, col: 'nem_approved', label: 'NEM Approved' },
    { fid: 1878, col: 'nem_rejected', label: 'NEM Needs Another Pass' },
    { fid: 178, col: 'install_scheduled', label: 'Install Scheduled' },
    { fid: 534, col: 'install_completed', label: 'Install Completed' },
    { fid: 226, col: 'inspection_scheduled', label: 'Inspection Scheduled' },
    { fid: 491, col: 'inspection_passed', label: 'Inspection Passed' },
    { fid: 538, col: 'pto_approved', label: 'PTO Approved' },
  ]

  const selectIds = [3, 145, 255, 820, 2, ...milestoneFields.map(m => m.fid)]

  // Get projects modified in the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const data = await qbQuery(realm, token, 'br9kwm8na', selectIds, `{'2'.AF.'${sevenDaysAgo}'}`, 500)

  let count = 0
  const ingestTx = db.transaction(() => {
    for (const record of data.data || []) {
      const projectId = parseInt(val(record, 3))
      const projectName = val(record, 145)
      const coordinator = val(record, 820)

      for (const ms of milestoneFields) {
        const dateVal = val(record, ms.fid)
        if (!dateVal || dateVal === '' || dateVal === '0') continue

        try {
          upsertFeedItem.run(
            'projects', projectId, 'milestone',
            `${ms.label}`,
            `${projectName} — ${ms.label}`,
            // No actor: a batch pull can't know who set the date, and the
            // feed only names people when attribution is certain (the
            // webhook payload). Coordinator lives in metadata for context.
            null,
            null,
            projectId, projectName,
            JSON.stringify({
              milestone: ms.label, fieldId: ms.fid, milestone_col: ms.col, status: val(record, 255),
              mentions: coordinator ? [{ name: coordinator, email: null, role: 'coordinator', user_id: null }] : [],
            }),
            dateVal,
            `projects:${projectId}:milestone:${ms.col}:${dateVal}`
          )
          count++
        } catch { /* duplicate, skip */ }
      }
    }
  })
  ingestTx()
  return count
}

// ─── Ingest: Project status changes ──────────────────────

async function ingestStatusChanges(realm: string, token: string): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const data = await qbQuery(realm, token, 'br9kwm8na', [3, 145, 255, 820, 2], `{'2'.AF.'${sevenDaysAgo}'}`, 500)

  let count = 0
  const ingestTx = db.transaction(() => {
    for (const record of data.data || []) {
      const projectId = parseInt(val(record, 3))
      const projectName = val(record, 145)
      const status = val(record, 255)
      const coordinator = val(record, 820)
      const modified = val(record, 2)

      if (!status || !modified) continue

      try {
        upsertFeedItem.run(
          'projects', projectId, 'status_change',
          `Status: ${status}`,
          `${projectName} is now ${status}`,
          null,  // no doer claim — see milestone ingest note
          null,
          projectId, projectName,
          JSON.stringify({
            status,
            mentions: coordinator ? [{ name: coordinator, email: null, role: 'coordinator', user_id: null }] : [],
          }),
          modified,
          // Imperfect (modified date ≠ status-change date) but backfill-grade;
          // matches feedMint's status key shape so webhook mints dedup.
          `projects:${projectId}:status:${status}:${modified.slice(0, 10)}`
        )
        count++
      } catch { /* duplicate */ }
    }
  })
  ingestTx()
  return count
}

// The feed carries MILESTONES and STATUS CHANGES only (2026-06-11,
// James): notes, tickets, and Arrivy task events are deliberately not
// ingested. Notes live in the project Notes tab; tickets in /tickets;
// field activity in /field. If field events earn their way back in, the
// canonical bvbbznmdb field map is routes/field.ts LOG_F.

// ─── Trigger full ingestion ──────────────────────────────

router.post('/ingest', async (_req: Request, res: Response): Promise<void> => {
  const { realm, token } = getQbConfig()
  if (!token) {
    res.status(500).json({ error: 'QB_USER_TOKEN not configured' })
    return
  }

  const results: Record<string, number | string> = {}

  try {
    results.milestones = await ingestMilestones(realm, token)
  } catch (e) { results.milestones = `error: ${e}` }

  try {
    results.statusChanges = await ingestStatusChanges(realm, token)
  } catch (e) { results.statusChanges = `error: ${e}` }


  const totalItems = db.prepare('SELECT COUNT(*) as count FROM feed_items').get() as { count: number }

  res.json({
    success: true,
    ingested: results,
    totalFeedItems: totalItems.count,
  })
})

// Stats
router.get('/stats', (_req: Request, res: Response): void => {
  const total = db.prepare('SELECT COUNT(*) as count FROM feed_items').get() as { count: number }
  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count FROM feed_items GROUP BY event_type ORDER BY count DESC
  `).all()
  const bySource = db.prepare(`
    SELECT qb_source, COUNT(*) as count FROM feed_items GROUP BY qb_source ORDER BY count DESC
  `).all()
  const latest = db.prepare(
    'SELECT occurred_at FROM feed_items ORDER BY occurred_at DESC LIMIT 1'
  ).get() as { occurred_at: string } | undefined

  res.json({ total: total.count, byType, bySource, latestItem: latest?.occurred_at })
})

export { router as feedIngestRouter }
